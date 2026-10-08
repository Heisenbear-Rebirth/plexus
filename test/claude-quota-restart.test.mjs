import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, appendFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { ClaudeQuotaJournal } from '../src/claude-quota-journal.mjs';
import { ClaudeProtocolState } from '../src/claude-wrapper-state.mjs';
import { ClaudeRuntime } from '../src/runtime/claude-runtime.mjs';
import { startServer } from '../src/http-server.mjs';
import { quotaSettingKey } from '../src/quota-recovery.mjs';
import { readRestartEvidence } from '../src/maintenance-recovery.mjs';
import { publicClaudeSelection } from '../src/claude-context-channel.mjs';

async function approveRestart(manager) {
  const config = await (await fetch(manager.url + '/api/config')).json();
  const status = await (await fetch(manager.url + '/api/monitoring')).json();
  assert.ok(status.restartConfirmations.length, 'restart must require consent');
  const response = await fetch(manager.url + '/api/restart-confirmation', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coop-ui': config.csrfToken },
    body: JSON.stringify({ bootId: status.bootId, items: status.restartConfirmations.map(({ id, revision }) => ({ id, revision })), action: 'approve' }) });
  assert.equal(response.status, 200);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(35); }
  throw Error('Timed out: ' + label);
}
async function fixture(t) {
  const root = await mkdtemp(join(resolve('.cooperation'), 'restart-test-')), id = randomUUID();
  t.after(async () => { assert.ok(root.startsWith(resolve('.cooperation') + sep)); await rm(root, { recursive: true, force: true }); });
  const state = new ClaudeProtocolState(id); state.initialized = true; state.model = 'fixture';
  const directory = join(root, 'journal'), head = { verified: true, cwd: root, quotaError: true };
  const journal = () => new ClaudeQuotaJournal({ directory, sessionId: id, cwd: root, readHead: async () => structuredClone(head) });
  const first = journal(), input = randomUUID();
  state.host({ type: 'user', uuid: input }); first.observe(state);
  state.child({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' } });
  state.child({ type: 'result', is_error: true }); first.observe(state); head.lastInputId = input;
  const reopened = new ClaudeProtocolState(id); reopened.initialized = true; reopened.model = 'fixture';
  return { root, id, state, first, journal, reopened, head };
}
test('durable Claude failure is reconstructed only after matching native history; newer input and manual stop survive reboot', async t => {
  const h = await fixture(t), journal = h.journal();
  await journal.restore(h.reopened); assert.equal(h.reopened.activity(), 'quota_limited'); assert.equal(h.reopened.quota.autoResume, true);
  h.reopened.host({ type: 'control_request', request_id: 'stop', request: { subtype: 'interrupt' } }); journal.observe(h.reopened);
  const stopped = new ClaudeProtocolState(h.id); stopped.initialized = true; stopped.model = 'fixture';
  await h.journal().restore(stopped); assert.equal(stopped.quota.autoResume, false);
  const other = await fixture(t); other.head.lastInputId = randomUUID(); await other.journal().restore(other.reopened);
  assert.equal(other.reopened.quota, null);
});
test('missing or changing history holds automatic work, and live input during evidence read invalidates the old failure', async t => {
  const h = await fixture(t); h.head.verified = false;
  const journal = h.journal(); await journal.restore(h.reopened); assert.equal(journal.pending, true); assert.equal(h.reopened.quota, null);
  journal.nextRead = 0; h.head.verified = true;
  journal.readHead = async () => { h.reopened.host({ type: 'user', uuid: randomUUID() }); journal.observe(h.reopened); return h.head; };
  await journal.restore(h.reopened); assert.equal(h.reopened.quota, null); assert.equal(journal.pending, false);
});

test('reopened quota recovery distinguishes a resolved model label from an actual explicit model selection change', async t => {
  const h = await fixture(t);
  h.reopened.observeNativeSelection({ model: 'fixture[1m]', effort: null });
  await h.journal().restore(h.reopened); assert.equal(h.reopened.quota?.autoResume, true);
  const explicit = await fixture(t); explicit.state.modelSelectionSource = 'native-settings'; explicit.first.observe(explicit.state);
  explicit.reopened.observeNativeSelection({ model: 'fixture[1m]', effort: null });
  await explicit.journal().restore(explicit.reopened); assert.equal(explicit.reopened.quota, null);
});

async function protocolFixture(t) {
  const root = await mkdtemp(join(resolve('.cooperation'), 'restart-protocol-')), id = randomUUID();
  const config = join(root, 'claude'), history = join(config, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), id + '.jsonl');
  const wrapperRoot = join(root, '.cooperation', 'claude-wrapper'); await mkdir(wrapperRoot, { recursive: true });
  await mkdir(resolve(history, '..'), { recursive: true });
  await writeFile(join(wrapperRoot, 'config.json'), JSON.stringify({ enabled: true, directories: [root] }));
  await writeFile(join(root, 'quota-utilization.json'), JSON.stringify({ value: 100 }));
  const processes = [], delivered = []; let manager;
  t.after(async () => {
    await manager?.close();
    for (const p of processes) { if (p.child.exitCode === null && p.child.signalCode === null) p.child.kill(); await p.exited; }
    assert.ok(root.startsWith(resolve('.cooperation') + sep)); await rm(root, { recursive: true, force: true });
  });
  async function launch(extraEnv = {}, extraArgs = [], equals = false) {
    const child = spawn(resolve('bin/claude-wrapper.exe'), [process.execPath, resolve('test/fixtures/claude-wrapper-child.mjs'),
      ...(equals ? ['--input-format=stream-json', '--resume=' + id] : ['--input-format', 'stream-json', '--resume', id]), ...extraArgs], {
      cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CONFIG_DIR: config,
        COOP_WRAPPER_DATA_DIRECTORY: wrapperRoot, COOP_FIXTURE_HISTORY: history, COOP_FIXTURE_MANAGER_PATH: join(root, '.cooperation', 'connection.json'), ...extraEnv },
    });
    const messages = [], errors = []; let buffer = '';
    child.stdout.on('data', b => { buffer += b.toString(); let index; while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { messages.push(JSON.parse(line)); } catch {} } });
    child.stderr.on('data', b => errors.push(b.toString()));
    const exited = new Promise(resolve => child.once('close', resolve));
    const p = { child, messages, errors, exited, send: m => child.stdin.write(JSON.stringify(m) + '\n') }; processes.push(p);
    p.send({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize' } });
    await until(async () => { try { return (await runtime().status()).initialized; } catch {} }, 'wrapper registry');
    return p;
  }
  const session = { client: 'claude', id, cwd: root, name: 'restart fixture' };
  const runtime = () => new ClaudeRuntime(id, { folder: join(wrapperRoot, 'instances') });
  async function start() {
    manager = await startServer({ root, port: 0, runtimeFactory: runtime, startMonitoring: false,
      adapters: { claude: { find: async () => session, list: async () => ({ sessions: [] }), send: async () => ({ status: 'submitted' }) } } });
    manager.controller.recoveryEvidence = (cycle, sample) => readRestartEvidence(cycle, sample, { root, configDir: config });
    manager.service.mailbox.deliverMessage = async message => { delivered.push(message.text); return { status: 'submitted' }; };
    if (!manager.store.getPolicy(session)) manager.store.savePolicy(session, { enabled: true, mode: 'automatic', session });
    return manager;
  }
  async function stop() { await manager?.close(); manager = null; }
  return { root, id, session, config, history, launch, start, stop, runtime, delivered, get manager() { return manager; } };
}

test('only applied model and effort escape the native settings response; launch permission is observed without rewriting arguments', () => {
  assert.deepEqual(publicClaudeSelection({ applied: { model: 'chosen', effort: 'high' }, merged: { model: 'wrong', env: { secret: 'private' } } }), { model: 'chosen', effort: 'high' });
  assert.deepEqual(publicClaudeSelection({ merged: { model: 'old' } }), { model: null });
  assert.equal(publicClaudeSelection({ applied: { model: '<synthetic>', effort: {} } }).model, null);
  for (const args of [['--permission-mode', 'auto'], ['--permission-mode=auto']]) assert.equal(new ClaudeProtocolState(randomUUID(), args).permissionMode, 'auto');
  assert.equal(new ClaudeProtocolState(randomUUID(), ['--allow-dangerously-skip-permissions']).permissionMode, null);
});

for (const equals of [false, true]) test(`a reopened idle session reads settings before its first business prompt with ${equals ? 'equals' : 'separate'} CLI arguments and no quota journal`, async t => {
  const h = await protocolFixture(t), client = await h.launch({ COOP_FIXTURE_DEFER_INIT: '1' }, ['--permission-mode', 'auto'], equals);
  const state = await until(async () => { const r = await h.runtime().status(); return r.model && r; }, 'current idle selection');
  assert.equal(state.model, 'fixture'); assert.equal(state.permissionMode, 'auto'); assert.equal(state.activity, 'idle');
  assert.equal(client.messages.some(m => m.fixtureReceivedExactly), false);
});

for (const order of ['manager-first', 'client-first']) test(`realistic ${order} reopen without system/init reads actual settings and resumes once after consent`, async t => {
  const h = await protocolFixture(t), first = await h.launch({}, ['--permission-mode', 'auto']); let manager = await h.start();
  first.send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'quota-failure' } });
  await until(async () => (await h.runtime().status()).quota, 'initial failure');
  await manager.controller.quotaRecovery.handle(h.session, manager.store.getPolicy(h.session), await manager.monitor.sample(h.session));
  assert.equal(manager.store.getSetting(quotaSettingKey(h.session)).state, 'waiting');
  await h.stop(); first.child.kill(); await first.exited;
  await writeFile(join(h.root, 'quota-utilization.json'), JSON.stringify({ value: 5 }));
  let second;
  const reopen = () => h.launch({ COOP_FIXTURE_DEFER_INIT: '1', COOP_FIXTURE_SETTINGS_DELAY_MS: '350' }, ['--permission-mode=auto'], true);
  if (order === 'manager-first') { manager = await h.start(); second = await reopen(); } else { second = await reopen(); manager = await h.start(); }
  const state = await until(async () => { const r = await h.runtime().status(); return r.quota && r; }, 'verified original failure without new input');
  assert.equal(state.model, 'fixture'); assert.equal(state.permissionMode, 'auto'); assert.equal(state.effort, 'high');
  assert.equal(state.quotaRestart, undefined); assert.equal(state.requiresReopen, false);
  assert.equal(second.messages.some(m => m.type === 'system' && m.subtype === 'init'), false);
  assert.equal(second.messages.some(m => m.type === 'control_response' && m.response?.response?.applied), false);
  assert.equal(JSON.stringify(state).includes('must-not-leave-native-channel'), false);
  await approveRestart(manager);
  const old = manager.store.getSetting(quotaSettingKey(h.session)); manager.store.setSetting(quotaSettingKey(h.session), { ...old, nextCheckAt: null });
  await manager.controller.quotaRecovery.handle(h.session, manager.store.getPolicy(h.session), await manager.monitor.sample(h.session));
  assert.equal(manager.store.getSetting(quotaSettingKey(h.session)).state, 'submitted');
  await until(() => second.messages.filter(m => m.fixtureReceivedExactly && /额度已恢复/.test(m.message?.content)).length === 1, 'single continuation');
});

test('slow startup settings reads keep Claude connected and never overwrite newer human input', async t => {
  const h = await protocolFixture(t), first = await h.launch({}, ['--permission-mode', 'auto']);
  first.send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'quota-failure' } });
  await until(async () => (await h.runtime().status()).quota, 'failure'); first.child.kill(); await first.exited;
  const second = await h.launch({ COOP_FIXTURE_DEFER_INIT: '1', COOP_FIXTURE_SETTINGS_DELAY_MS: '3000', COOP_FIXTURE_SELECTED_MODEL: 'stale-read' }, ['--permission-mode', 'auto']);
  const started = Date.now(), pending = await h.runtime().status(); assert.ok(Date.now() - started < 1500);
  assert.equal(pending.connected, true); assert.equal(pending.quotaRestart.stage, 'settings');
  const input = randomUUID(); second.send({ type: 'user', uuid: input, message: { role: 'user', content: 'hold' } });
  await until(async () => (await h.runtime().status()).activeTurnId === input, 'new user input');
  await sleep(3200); const current = await h.runtime().status();
  assert.equal(current.activeTurnId, input); assert.equal(current.model, 'fixture'); assert.equal(current.quota, null);
});

test('a genuinely changed native model does not restore the saved quota failure', async t => {
  const h = await protocolFixture(t), first = await h.launch({}, ['--permission-mode', 'auto']);
  first.send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'quota-failure' } });
  await until(async () => (await h.runtime().status()).quota, 'failure'); first.child.kill(); await first.exited;
  const second = await h.launch({ COOP_FIXTURE_DEFER_INIT: '1', COOP_FIXTURE_SELECTED_MODEL: 'changed' }, ['--permission-mode', 'auto']);
  const state = await until(async () => { const r = await h.runtime().status(); return !r.quotaRestart && r.model && r; }, 'verified changed model');
  assert.equal(state.model, 'changed'); assert.equal(state.quota, null); assert.equal(second.messages.some(m => m.fixtureReceivedExactly), false);
});
for (const order of ['manager-first', 'client-first']) test(`actual wrapper crash and ${order} restart recovers persisted quota, submits once and releases queued messages`, async t => {
  const h = await protocolFixture(t), { root, id, session, runtime, launch, start, delivered } = h;
  const first = await launch(); await start();
  let manager = h.manager;
  first.send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'quota-failure' } });
  await until(async () => (await runtime().status()).activity === 'quota_limited', 'initial quota failure');
  await manager.controller.quotaRecovery.handle(session, manager.store.getPolicy(session), await manager.monitor.sample(session));
  assert.equal(manager.store.getSetting(quotaSettingKey(session)).state, 'waiting');
  for (const text of ['first-queued', 'second-queued']) assert.equal((await manager.service.mailbox.send({ id: randomUUID(),
    createdAt: new Date().toISOString(), from: { ...session, client: 'codex' }, to: session, text })).status, 'queued');
  await h.stop(); first.child.kill(); await first.exited;
  await writeFile(join(root, 'quota-utilization.json'), JSON.stringify({ value: 5 }));
  let second;
  if (order === 'manager-first') { manager = await start(); await manager.controller.tick(); second = await launch(); }
  else { second = await launch(); manager = await start(); }
  assert.deepEqual(delivered, []);
  const reconnected = await until(async () => { try { const r = await runtime().status(); return r.activity === 'quota_limited' && r; } catch {} }, 'restored quota marker');
  assert.equal(reconnected.quota.autoResume, true);
  await manager.controller.quotaRecovery.handle(session, manager.store.getPolicy(session), await manager.monitor.sample(session));
  assert.equal(manager.store.getSetting(quotaSettingKey(session)).state, 'waiting');
  assert.equal(second.messages.filter(m => m.fixtureReceivedExactly && /额度已恢复/.test(m.message?.content)).length, 0);
  await approveRestart(manager);
  const old = manager.store.getSetting(quotaSettingKey(session)); manager.store.setSetting(quotaSettingKey(session), { ...old, nextCheckAt: null });
  await manager.controller.quotaRecovery.handle(session, manager.store.getPolicy(session), await manager.monitor.sample(session));
  assert.equal(manager.store.getSetting(quotaSettingKey(session)).state, 'submitted', JSON.stringify(manager.store.getSetting(quotaSettingKey(session))));
  await until(() => second.messages.filter(m => m.fixtureReceivedExactly && /额度已恢复/.test(m.message?.content)).length === 1, 'one continuation');
  await manager.controller.quotaRecovery.handle(session, manager.store.getPolicy(session), await manager.monitor.sample(session));
  assert.equal(second.messages.filter(m => m.fixtureReceivedExactly && /额度已恢复/.test(m.message?.content)).length, 1);
  await manager.service.mailbox.flush(); assert.deepEqual(delivered, ['first-queued', 'second-queued']);
});

for (const stage of ['writing_handoff', 'awaiting_handoff_end', 'compacting', 'restoring', 'awaiting_restore_end'])
  for (const order of ['manager-first', 'client-first']) test(`actual Claude ${stage} shutdown recovers with ${order} startup and keeps receipt gates`, async t => {
    const h = await protocolFixture(t); let client = await h.launch(), manager = await h.start();
    const sample = await manager.monitor.sample(h.session);
    const cycle = await manager.controller.trigger(h.session, manager.store.getPolicy(h.session), { ...sample,
      decision: { trigger: 'soft', wasWorkingAtTrigger: false } });
    const id = cycle.id;
    async function receipt(stage) {
      // Mirror normal service ticks while initialization and recovery are
      // asynchronous; an initialize reply alone does not establish settings.
      await until(async () => { await manager.controller.advance(id); return client.messages.some(m => m.type === 'fixture_pending_checkpoint' && m.stage === stage); }, 'pending ' + stage).catch(async error => {
        const c = manager.store.cycle(id), r = await h.runtime().status();
        throw Error(error.message + ' ' + JSON.stringify({ cycleState: c.state, reason: c.reason, previousState: c.previousState,
          triggerModel: c.triggerRuntime.model, triggerEffort: c.triggerRuntime.effort, runtimeModel: r.model, runtimeEffort: r.effort,
          selectionPending: r.selectionPending, activity: r.activity, compactResult: c.compactResult,
          evidence: await readRestartEvidence(c, {}, { root: h.root, configDir: h.config }) }));
      });
      client.send({ type: 'fixture_release_checkpoint' });
      await until(() => manager.store.checkpoint(id, stage), 'accepted ' + stage);
      await until(async () => (await h.runtime().status()).activity === 'idle', 'receipt turn ended');
    }
    if (stage !== 'writing_handoff') await receipt('handoff');
    if (stage === 'compacting') { await manager.controller.advance(id); await manager.controller.advance(id); }
    if (stage.startsWith('restor') || stage === 'awaiting_restore_end') {
      for (let i = 0; i < 4; i++) await manager.controller.advance(id);
      if (stage === 'awaiting_restore_end') await receipt('restored');
      else await until(() => client.messages.some(m => m.type === 'fixture_pending_checkpoint' && m.stage === 'restored'), 'restore delivered');
    }
    assert.equal(manager.store.cycle(id).state, stage);
    await manager.service.mailbox.send({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...h.session, client: 'codex' }, to: h.session, text: 'held-during-restart' });
    await h.stop(); client.child.kill(); await client.exited;
    if (order === 'manager-first') {
      manager = await h.start(); await manager.controller.advance(id); client = await h.launch();
    } else { client = await h.launch(); manager = await h.start(); }
    await manager.controller.advance(id);
    assert.equal(client.messages.filter(m => m.type === 'fixture_pending_checkpoint').length, 0);
    await approveRestart(manager);
    manager.controller.recoveryPollAt.clear(); await manager.controller.advance(id);
    assert.deepEqual(h.delivered, []);
    if (stage === 'writing_handoff') { await manager.controller.advance(id); await receipt('handoff'); }
    if (['writing_handoff', 'awaiting_handoff_end'].includes(stage)) {
      for (let i = 0; i < 4; i++) await manager.controller.advance(id);
    }
    if (stage !== 'awaiting_restore_end') {
      if (['restoring', 'compacting'].includes(stage)) await manager.controller.advance(id);
      await receipt('restored');
    }
    await manager.controller.advance(id);
    assert.equal(manager.store.cycle(id).state, 'completed');
    assert.deepEqual(h.delivered, ['held-during-restart']);
    const audit = (await readFile(join(h.root, '.cooperation', 'claude-wrapper', 'compactions.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(audit.filter(row => row.type === 'requested').length, 1);
  });

test('Claude failure saved while the manager is stopped can resume after both restart', async t => {
  const h = await protocolFixture(t), first = await h.launch();
  first.send({ type: 'user', uuid: randomUUID(), message: { role: 'user', content: 'quota-failure' } });
  await until(async () => (await h.runtime().status()).quota, 'failure without manager');
  first.child.kill(); await first.exited;
  await writeFile(join(h.root, 'quota-utilization.json'), JSON.stringify({ value: 5 }));
  const second = await h.launch(), manager = await h.start();
  await manager.controller.quotaRecovery.handle(h.session, manager.store.getPolicy(h.session), await manager.monitor.sample(h.session));
  assert.equal(manager.store.getSetting(quotaSettingKey(h.session)).state, 'submitted');
  await until(() => second.messages.filter(m => m.fixtureReceivedExactly && /额度已恢复/.test(m.message?.content)).length === 1, 'one continuation');
});

test('shutdown during native compaction retains its boundary and holds the queue when completion is unknown', async t => {
  const h = await protocolFixture(t), first = await h.launch({ COOP_FIXTURE_HOLD_COMPACT: '1' }); let manager = await h.start();
  const sample = await manager.monitor.sample(h.session);
  const cycle = await manager.controller.trigger(h.session, manager.store.getPolicy(h.session), { ...sample, decision: { trigger: 'soft', wasWorkingAtTrigger: false } });
  await until(() => first.messages.some(m => m.type === 'fixture_pending_checkpoint'), 'handoff');
  first.send({ type: 'fixture_release_checkpoint' });
  await until(() => manager.store.checkpoint(cycle.id, 'handoff'), 'handoff accepted');
  await until(async () => (await h.runtime().status()).activity === 'idle', 'handoff ended');
  await manager.controller.advance(cycle.id); const compacting = manager.controller.advance(cycle.id);
  await until(() => first.messages.some(m => m.subtype === 'compact_boundary'), 'boundary without result');
  first.child.kill(); await first.exited; await compacting; await h.stop();
  await h.launch(); manager = await h.start();
  await manager.controller.advance(cycle.id);
  assert.equal(manager.store.restartConfirmation.blocks(h.session), true);
  await approveRestart(manager); manager.controller.recoveryPollAt.clear();
  await manager.controller.advance(cycle.id);
  const record = manager.store.cycle(cycle.id); assert.equal(record.state, 'needs_attention'); assert.equal(record.recoveryBlocked, true);
  assert.match(record.reason, /压缩结果无法确认/); assert.equal(manager.store.activeCycle(h.session).id, cycle.id);
  const audit = (await readFile(join(h.root, '.cooperation', 'claude-wrapper', 'compactions.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(audit.filter(row => row.type === 'requested').length, 1);
});
