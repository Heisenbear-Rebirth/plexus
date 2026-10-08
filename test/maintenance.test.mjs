import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ManagementStore } from '../src/management-store.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';
import { CheckpointService } from '../src/checkpoint-service.mjs';
import { MaintenanceController } from '../src/maintenance-controller.mjs';
import { PromptSettings } from '../src/prompt-settings.mjs';
import { defaultPromptValues } from '../public/prompt-templates.mjs';
import { projectCodexState } from '../src/runtime/codex-runtime.mjs';

async function harness(t, wasWorking = false, delayedInterrupt = false, recoveryEvidence, client = 'claude') {
  const root = await mkdtemp(join(resolve('.'), '.maintenance-test-'));
  const store = await new ManagementStore(join(root, '.cooperation')).init();
  const target = { client, id: '11111111-1111-4111-8111-111111111111', cwd: root, name: 'fixture' };
  let count = 0, compactCount = 0, interruptCount = 0;
  const delivered = [];
  const state = { connected: true, activity: wasWorking ? 'running' : 'idle', activeTurnId: wasWorking ? 'original' : null,
    sessionId: target.id, cwd: root, instanceId: 'fixture-instance', activityRevision: 1, model: 'fixed', permissionMode: 'original', queuedNativeInputs: 0, backgroundTasks: 0,
    capabilities: { readActivity: true, interrupt: true, sendControl: true, compact: true, observeCompletion: true } };
  const usage = { usedTokens: 600, contextWindowTokens: 1000, contextEpoch: 0 };
  const runtime = {
    async status() { return structuredClone(state); },
    async sendControl(text) { const id = 'control-' + (++count); state.activity = 'running'; state.activeTurnId = id; if (client === 'codex') state.latestTurn = { id, status: 'inProgress' }; delivered.push(text); return { status: 'submitted', activeTurnId: id, requestId: id }; },
    async interrupt() { interruptCount++; if (!delayedInterrupt) { state.activity = 'idle'; state.lastCompletedTurnId = state.activeTurnId; state.activeTurnId = null; } return { status: 'acknowledged' }; },
    async compact() { compactCount++; usage.contextEpoch++; usage.usedTokens = 100; state.lastCompletedTurnId = 'compact-' + compactCount;
      if (client === 'codex') {
        usage.lastCompactionAt = new Date().toISOString(); usage.recordedTurnState = 'task_complete';
        state.latestTurn = { id: state.lastCompletedTurnId, status: 'completed', itemTypes: ['contextCompaction'] };
      }
      return { status: 'completed', requestId: state.lastCompletedTurnId, completedAt: new Date().toISOString(), boundary: { trigger: 'manual' } }; }, close() {},
  };
  const monitor = { sample: async () => ({ runtime: structuredClone(state), usage: { ...usage }, decision: { trigger: wasWorking ? 'hard' : 'soft', wasWorkingAtTrigger: wasWorking } }), runtime: () => runtime, close() {} };
  const service = { adapters: { [client]: { find: async () => target } }, mailbox: new SessionMailbox({ store,
    deliverMessage: async m => { delivered.push(m.text); return { status: 'submitted' }; }, deliverResume: async () => { delivered.push('continue'); return { status: 'submitted' }; } }) };
  const controller = new MaintenanceController({ root, store, service, monitor, recoveryEvidence });
  const checkpoints = new CheckpointService({ root, store, readRuntime: () => runtime.status() });
  t.after(async () => { await controller.close(); await service.mailbox.close(); store.close(); assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); });
  const policy = { enabled: true, softPercent: 50, hardPercent: 80, mode: 'automatic' };
  const cycle = await controller.trigger(target, policy, await monitor.sample());
  const endTurn = () => { state.lastCompletedTurnId = state.activeTurnId; if (client === 'codex') state.latestTurn = { id: state.activeTurnId, status: 'completed' }; state.activeTurnId = null; state.activity = 'idle'; };
  const receipt = async stage => {
    const c = store.cycle(cycle.id); const tokens = store.getSetting('cycle-tokens:' + c.id);
    return checkpoints.accept({ from: target, cycleId: c.id, stage, receiptToken: tokens[stage], documentPath: c.handoffPath });
  };
  return { root, store, target, state, runtime, controller, checkpoints, service, cycle, delivered, endTurn, receipt,
    compactCount: () => compactCount, interruptCount: () => interruptCount };
}
for (const working of [false, true]) test(`two-phase ${working ? 'hard-running' : 'soft-idle'} maintenance waits for both control turns, preserves FIFO and resumes conditionally`, async t => {
  const h = await harness(t, working); const id = h.cycle.id;
  if (working) { assert.equal(h.interruptCount(), 1); await h.controller.advance(id); await h.controller.advance(id); }
  const cycle = h.store.cycle(id);
  assert.equal(cycle.state, 'writing_handoff');
  await mkdir(dirname(cycle.handoffPath), { recursive: true }); await writeFile(cycle.handoffPath, '# Context\nKeep constraints and next steps.');
  const incoming = text => h.service.mailbox.send({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...h.target, client: 'codex' }, to: h.target, text });
  assert.equal((await incoming('first-message')).status, 'queued');
  assert.equal((await h.receipt('handoff')).status, 'accepted');
  assert.equal((await h.receipt('handoff')).duplicate, true);
  await h.controller.advance(id); assert.equal(h.compactCount(), 0); // ACK tool has not returned / its turn is still active.
  h.endTurn(); await h.controller.advance(id); await h.controller.advance(id); assert.equal(h.compactCount(), 1);
  await h.controller.advance(id); await h.controller.advance(id); assert.equal(h.store.cycle(id).state, 'restoring');
  assert.equal((await incoming('second-message')).status, 'queued');
  assert.equal(h.delivered.includes('first-message'), false);
  await h.receipt('restored'); await h.controller.advance(id); assert.equal(h.delivered.includes('first-message'), false);
  h.endTurn(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'completed');
  assert.deepEqual(h.delivered.slice(2), working ? ['continue', 'first-message', 'second-message'] : ['first-message', 'second-message']);
  assert.equal(h.compactCount(), 1);
});

test('receipt rejects a different session, wrong stage, wrong token and changed document', async t => {
  const h = await harness(t); const cycle = h.store.cycle(h.cycle.id); const tokens = h.store.getSetting('cycle-tokens:' + cycle.id);
  await mkdir(dirname(cycle.handoffPath), { recursive: true }); await writeFile(cycle.handoffPath, 'original');
  const request = { from: h.target, cycleId: cycle.id, stage: 'handoff', receiptToken: tokens.handoff, documentPath: cycle.handoffPath };
  await assert.rejects(h.checkpoints.accept({ ...request, from: { ...h.target, id: 'different' } }), /发送方/);
  await assert.rejects(h.checkpoints.accept({ ...request, stage: 'restored', receiptToken: tokens.restored }), /阶段/);
  await assert.rejects(h.checkpoints.accept({ ...request, receiptToken: 'wrong' }), /凭证/);
  await h.checkpoints.accept(request); h.endTurn(); await h.controller.advance(cycle.id); await h.controller.advance(cycle.id); await h.controller.advance(cycle.id); await h.controller.advance(cycle.id);
  await writeFile(cycle.handoffPath, 'modified'); await assert.rejects(h.receipt('restored'), /内容不一致/);
  assert.equal(h.store.activeCycle(h.target).id, cycle.id);
});

for (const client of ['claude', 'codex']) test(`${client}: effort and permission changes after compaction preserve restore receipts and FIFO without another compact`, async t => {
  const h = await harness(t, false, false, undefined, client), id=h.cycle.id;
  await mkdir(dirname(h.cycle.handoffPath), { recursive: true }); await writeFile(h.cycle.handoffPath, 'Preserved progress');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id); await h.controller.advance(id);
  const queued = await h.service.mailbox.send({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...h.target, client: client==='claude'?'codex':'claude' }, to: h.target, text: 'release only after restore' });
  Object.assign(h.state, { effort: 'low', permissionMode: 'new-native-mode', permissionFingerprint: 'new-native-fingerprint' });
  await h.controller.advance(id); await h.controller.advance(id); assert.equal(h.store.cycle(id).state,'restoring');
  assert.equal(h.state.permissionMode,'new-native-mode'); assert.equal(h.compactCount(),1);
  await h.receipt('restored'); assert.equal(h.store.getMessage(queued.id).status,'queued'); h.endTurn();await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state,'completed'); assert.equal(h.delivered.filter(x=>x==='release only after restore').length,1);assert.equal(h.compactCount(),1);
});

for (const late of [false, true]) test(`Codex reviewer alias after compaction accepts ${late ? 'a verified late' : 'the original'} restore receipt and releases FIFO once`, async t => {
  const h = await harness(t, false, false, undefined, 'codex'); const id = h.cycle.id;
  const projected = projectCodexState({ id: h.target.id, cwd: h.root, currentPermissions: {
    activePermissionProfile: { id: ':workspace', extends: null }, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review',
    runtimeWorkspaceRoots: [h.root], sandboxPolicy: { type: 'workspaceWrite', writableRoots: [], networkAccess: false },
  } });
  const selection = Object.fromEntries(Object.entries(projected).filter(([key]) => /PermissionFingerprints|permissionFingerprint/.test(key)));
  Object.assign(h.state, selection);
  h.store.updateCycle(id, h.cycle.state, { triggerRuntime: { ...h.cycle.triggerRuntime,
    permissionFingerprint: projected.legacyPermissionFingerprintsV2[1], permissionFingerprintBasis: 'permission-selection-v2-implicit-workspace-root' } });
  await mkdir(dirname(h.cycle.handoffPath), { recursive: true }); await writeFile(h.cycle.handoffPath, 'Saved Codex context');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id); await h.controller.advance(id);
  await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'restoring'); assert.equal(h.compactCount(), 1);
  const queued = await h.service.mailbox.send({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...h.target, client: 'claude' }, to: h.target, text: 'queued-after-maintenance' });
  assert.equal(queued.status, 'queued');
  if (late) h.controller.attention(h.store.cycle(id), '维护阶段超时；会话锁及排队消息已保留。');
  assert.equal((await h.receipt('restored')).status, 'accepted');
  assert.equal((await h.receipt('restored')).duplicate, true);
  assert.equal(h.delivered.includes('queued-after-maintenance'), false);
  h.endTurn(); await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'completed');
  assert.equal(h.delivered.filter(text => text === 'queued-after-maintenance').length, 1);
  assert.equal(h.compactCount(), 1);
});

test('quota failure inside handoff retains its lock and queued messages without compression, generic resume or timeout retry', async t => {
  const h = await harness(t); const cycle = h.store.cycle(h.cycle.id);
  h.state.activity = 'quota_limited'; h.state.quota = { turnId: h.state.activeTurnId, autoResume: true }; h.state.activeTurnId = null;
  h.store.updateCycle(cycle.id, cycle.state, { deadlineAt: '2000-01-01T00:00:00Z' });
  await h.controller.advance(cycle.id);
  assert.equal(h.store.cycle(cycle.id).state, 'needs_attention'); assert.equal(h.store.cycle(cycle.id).recoveryBlocked, true);
  assert.match(h.store.cycle(cycle.id).reason, /额度不足/); assert.equal(h.compactCount(), 0);
  assert.equal(h.store.activeCycle(h.target).id, cycle.id);
  await h.controller.advance(cycle.id); assert.equal(h.delivered.length, 1);
});

test('account-only exhaustion pauses the next Codex maintenance operation and resumes that stage once capacity returns', async t => {
  const h = await harness(t, false, false, undefined, 'codex'); const id = h.cycle.id;
  await mkdir(dirname(h.cycle.handoffPath), { recursive: true }); await writeFile(h.cycle.handoffPath, 'Saved before quota exhaustion');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'compacting');
  h.state.accountQuota = { status: 'exhausted', queriedAt: new Date().toISOString() };
  h.store.updateCycle(id, 'compacting', { deadlineAt: '2000-01-01' });
  await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'compacting'); assert.equal(h.store.cycle(id).accountQuotaWaiting, true);
  assert.equal(h.compactCount(), 0); assert.equal(h.delivered.length, 1);
  h.state.accountQuota = { status: 'available', queriedAt: new Date().toISOString() };
  await h.controller.advance(id); await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.compactCount(), 1); assert.equal(h.store.cycle(id).state, 'restoring');
  assert.equal(h.store.cycle(id).accountQuotaWaiting, false); assert.equal(h.delivered.length, 2);
});

for (const client of ['claude', 'codex']) test(`${client}: a maintenance turn still writing its handoff after ten minutes remains eligible to submit its receipt`, async t => {
  const h = await harness(t, false, false, undefined, client); const c = h.store.cycle(h.cycle.id);
  h.store.updateCycle(c.id, c.state, { deadlineAt: '2000-01-01T00:00:00Z' });
  await h.controller.advance(c.id);
  assert.equal(h.store.cycle(c.id).state, 'writing_handoff');
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Long but legitimate handoff');
  assert.equal((await h.receipt('handoff')).status, 'accepted'); assert.equal(h.compactCount(), 0);
});

for (const client of ['claude', 'codex']) test(`${client}: a verified late handoff receipt recovers a timed-out original turn without rewriting or resending`, async t => {
  const h = await harness(t, false, false, undefined, client); const c = h.store.cycle(h.cycle.id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Existing handoff');
  h.controller.attention(c, '维护阶段超时；会话锁及排队消息已保留。');
  assert.equal((await h.receipt('handoff')).status, 'accepted');
  assert.equal(h.store.cycle(c.id).state, 'awaiting_handoff_end'); assert.equal(h.store.cycle(c.id).lateReceiptAccepted, true);
  assert.equal(h.delivered.length, 1); assert.equal(h.compactCount(), 0);
  h.endTurn(); await h.controller.advance(c.id); await h.controller.advance(c.id); assert.equal(h.compactCount(), 1);
});

test('late receipts still reject user intervention and expose token-free diagnostic reasons', async t => {
  const h = await harness(t); const c = h.store.cycle(h.cycle.id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Existing handoff');
  h.controller.attention(c, '维护阶段超时；会话锁及排队消息已保留。');
  h.state.activeTurnId = 'new-user-turn';
  await assert.rejects(h.receipt('handoff'), error => error.code === 'CHECKPOINT_NATIVE_TURN_CHANGED');
  const issue = h.store.cycle(c.id).lastReceiptIssue; assert.equal(issue.code, 'CHECKPOINT_NATIVE_TURN_CHANGED');
  assert.equal(JSON.stringify(issue).includes(h.store.getSetting('cycle-tokens:' + c.id).handoff), false);
  h.store.updateCycle(c.id, 'user_intervened', { previousState: 'writing_handoff' });
  h.state.activeTurnId = c.controlTurnId;
  await assert.rejects(h.receipt('handoff'), /维护已暂停/); assert.equal(h.store.checkpoint(c.id, 'handoff'), null);
});

test('late receipts ignore effort and permission changes but still reject pending settings and model changes', async t => {
  const h = await harness(t); const c = h.store.cycle(h.cycle.id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Existing progress');
  h.store.updateCycle(c.id, c.state, { triggerRuntime: { ...c.triggerRuntime, effort: 'high' } });
  h.controller.attention(h.store.cycle(c.id), '维护阶段超时；会话锁及排队消息已保留。');
  Object.assign(h.state, { model: 'fixed[1m]', modelSelectionSource: 'native-settings', effort: 'high', selectionPending: true });
  await assert.rejects(h.receipt('handoff'), error => error.code === 'CHECKPOINT_NATIVE_TURN_CHANGED');
  h.state.selectionPending = false; h.state.effort = null; h.state.selectionKnown = ['effort'];
  h.state.permissionMode = 'changed';
  h.state.model = 'different-model';
  await assert.rejects(h.receipt('handoff'), error => error.code === 'CHECKPOINT_NATIVE_TURN_CHANGED');
  h.state.model = 'fixed[1m]'; assert.equal((await h.receipt('handoff')).status, 'accepted'); assert.equal(h.delivered.length, 1);
});

test('an unaccepted backup from a rejected receipt cannot block a later valid document', async t => {
  const h = await harness(t); const c = h.store.cycle(h.cycle.id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Earlier attempt');
  h.controller.attention(c, '维护阶段超时；会话锁及排队消息已保留。'); h.state.connected = false;
  await assert.rejects(h.receipt('handoff'), error => error.code === 'CHECKPOINT_NATIVE_TURN_CHANGED');
  await writeFile(c.handoffPath, 'Corrected document'); h.state.connected = true;
  assert.equal((await h.receipt('handoff')).status, 'accepted');
  assert.match(h.store.checkpoint(c.id, 'handoff').backupPath, /handoff-[a-f0-9]{64}\.md$/);
});

test('a delivery metadata update during document validation does not reject a valid receipt', async t => {
  const h = await harness(t); const c = h.store.cycle(h.cycle.id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Existing handoff');
  const transaction = h.store.transaction.bind(h.store); let once = true;
  h.store.transaction = fn => { if (once) { once = false; h.store.updateCycle(c.id, 'writing_handoff', { controlResult: { status: 'submitted' } }); } return transaction(fn); };
  assert.equal((await h.receipt('handoff')).status, 'accepted'); assert.equal(h.store.cycle(c.id).state, 'awaiting_handoff_end');
});

test('check and continue reopens a timed-out original live turn without sending a second handoff prompt', async t => {
  const h = await harness(t); const c = h.store.cycle(h.cycle.id);
  h.controller.attention(c, '维护阶段超时；会话锁及排队消息已保留。');
  await h.controller.reconcile(c.id); assert.equal(h.store.cycle(c.id).state, 'writing_handoff'); assert.equal(h.delivered.length, 1);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Existing original work');
  assert.equal((await h.receipt('handoff')).status, 'accepted'); assert.equal(h.compactCount(), 0);
});

test('explicitly retrying a stage rotates its receipt credential so delayed older attempts cannot confirm the new request', async t => {
  const h = await harness(t); const c = h.store.cycle(h.cycle.id), oldToken = h.store.getSetting('cycle-tokens:' + c.id).handoff;
  h.endTurn(); h.controller.attention(c, '目标轮次已结束，但系统未收到阶段回执。', 'failed'); await h.controller.retry(c.id);
  assert.notEqual(h.store.getSetting('cycle-tokens:' + c.id).handoff, oldToken);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'Existing original work');
  await assert.rejects(h.checkpoints.accept({ from: h.target, cycleId: c.id, stage: 'handoff', receiptToken: oldToken, documentPath: c.handoffPath }), /凭证不匹配/);
  assert.equal((await h.receipt('handoff')).status, 'accepted');
});

for (const action of ['retry', 'reconcile', 'restartFromCurrent']) test(`cancelling while ${action} awaits native state cannot resurrect a cancelled cycle`, async t => {
  const h = await harness(t); const id = h.cycle.id;
  if (action === 'retry') h.endTurn();
  h.controller.attention(h.store.cycle(id), '维护阶段超时；会话锁及排队消息已保留。');
  let reached, release;
  const started = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const owner = action === 'retry' ? h.runtime : h.controller.monitor;
  const method = action === 'retry' ? 'status' : 'sample', original = owner[method];
  owner[method] = async (...args) => { const state = await original(...args); reached(); await gate; return state; };
  const work = h.controller[action](id);
  await started; await h.controller.cancel(id, false); release();
  await assert.rejects(work, /流程.*变化|已结束/);
  assert.equal(h.store.cycle(id).state, 'cancelled'); assert.equal(h.store.activeCycle(h.target), null);
  assert.equal(h.store.getSetting('cycle-tokens:' + id), null);
  assert.equal(h.delivered.length, 1); assert.equal(h.compactCount(), 0);
});

test('explicit continue from current progress replaces a pre-compaction pause, preserves old receipt and keeps FIFO locked until the new restore ends', async t => {
  const h = await harness(t, false, false, undefined, 'codex'); const old = h.cycle;
  await mkdir(dirname(old.handoffPath), { recursive: true }); await writeFile(old.handoffPath, 'Earlier accepted context');
  await h.receipt('handoff'); const oldReceipt = h.store.checkpoint(old.id, 'handoff'); h.endTurn();
  h.controller.attention(h.store.cycle(old.id), '重启后检测到维护之外的新输入，需人工核对。');
  Object.assign(h.state, { instanceId: 'new-native-instance', lastCompletedTurnId: 'new-user-turn', latestTurn: { id: 'new-user-turn', status: 'completed' } });
  const queued = await h.service.mailbox.send({ id: randomUUID(), createdAt: new Date().toISOString(), from: { ...h.target, client: 'claude' }, to: h.target, text: 'retained message' });
  const next = await h.controller.restartFromCurrent(old.id);
  assert.notEqual(next.id, old.id); assert.equal(next.supersedesCycleId, old.id); assert.equal(next.state, 'writing_handoff');
  assert.equal(next.triggerRuntime.instanceId, 'new-native-instance'); assert.equal(next.wasWorkingAtTrigger, false);
  assert.equal(h.store.cycle(old.id).state, 'cancelled'); assert.equal(h.store.cycle(old.id).supersededByCycleId, next.id);
  assert.deepEqual(h.store.checkpoint(old.id, 'handoff'), oldReceipt); assert.equal(await readFile(old.handoffPath, 'utf8'), 'Earlier accepted context');
  assert.notEqual(next.handoffPath, old.handoffPath); assert.equal(h.store.getSetting('cycle-tokens:' + old.id), null);
  await h.service.mailbox.flush(); assert.equal(h.store.getMessage(queued.id).status, 'queued'); assert.equal(h.compactCount(), 0);
  await assert.rejects(h.controller.restartFromCurrent(old.id), /此阶段不能/);
  const receipt = stage => h.checkpoints.accept({ from: h.target, cycleId: next.id, stage,
    receiptToken: h.store.getSetting('cycle-tokens:' + next.id)[stage], documentPath: next.handoffPath });
  await writeFile(next.handoffPath, 'Fresh context including the later input');
  await receipt('handoff'); h.endTurn();
  await h.controller.advance(next.id); await h.controller.advance(next.id); await h.controller.advance(next.id); await h.controller.advance(next.id);
  assert.equal(h.compactCount(), 1); assert.equal(h.store.cycle(next.id).state, 'restoring');
  await receipt('restored'); await h.service.mailbox.flush(); assert.equal(h.store.getMessage(queued.id).status, 'queued');
  h.endTurn(); await h.controller.advance(next.id);
  assert.equal(h.store.cycle(next.id).state, 'completed'); assert.equal(h.delivered.filter(text => text === 'retained message').length, 1);
  assert.equal(h.delivered.filter(text => text === 'continue').length, 0); assert.equal(h.compactCount(), 1);
});

test('continue from current progress cannot replace an active task or a cycle with a compact intent', async t => {
  const h = await harness(t); h.controller.attention(h.store.cycle(h.cycle.id), '等待用户核对');
  const paused = h.store.cycle(h.cycle.id);
  await assert.rejects(h.controller.restartFromCurrent(paused.id), /当前回复结束/);
  assert.deepEqual(h.store.cycle(paused.id), paused); assert.equal(h.delivered.length, 1);
  h.endTurn();
  h.store.updateCycle(paused.id, 'needs_attention', { previousState: 'compacting', compactIntentAt: new Date().toISOString() });
  await assert.rejects(h.controller.restartFromCurrent(paused.id), /压缩.*原结果/);
  assert.equal(h.store.activeCycle(h.target).id, paused.id); assert.equal(h.compactCount(), 0);
});

test('replacement creation failure atomically restores the old maintenance lock, tokens and queue', async t => {
  const h = await harness(t); h.endTurn(); h.controller.attention(h.store.cycle(h.cycle.id), '等待用户核对');
  const old = h.store.cycle(h.cycle.id), tokens = h.store.getSetting('cycle-tokens:' + old.id);
  const create = h.store.createCycle; h.store.createCycle = () => { throw Error('fixture database conflict'); };
  await assert.rejects(h.controller.restartFromCurrent(old.id), /database conflict/); h.store.createCycle = create;
  assert.deepEqual(h.store.cycle(old.id), old); assert.deepEqual(h.store.getSetting('cycle-tokens:' + old.id), tokens);
  assert.equal(h.store.activeCycle(h.target).id, old.id); assert.equal(h.delivered.length, 1);
});

for (const limited of [false, true]) test(`confirmed failed compaction recovers from ${limited ? 'a quota-limited' : 'a reopened idle'} session with fresh progress, one compact and FIFO release`, async t => {
  const h = await harness(t); const old = h.cycle;
  await mkdir(dirname(old.handoffPath), { recursive: true }); await writeFile(old.handoffPath, 'Old accepted progress');
  await h.receipt('handoff'); h.endTurn(); const saved = h.store.checkpoint(old.id, 'handoff');
  const at = new Date().toISOString();
  h.store.updateCycle(old.id, 'waiting_client', { previousState: 'compacting', compactDispatched: true, compactIntentAt: at,
    compactRequestId: 'failed-compact', compactResult: { requestId: 'failed-compact', status: 'not_compacted', completedAt: at } });
  Object.assign(h.state, { instanceId: 'new-owner', lastCompletedTurnId: 'failed-compact', ...(limited ? { activity: 'quota_limited',
    quota: { kind: 'five_hour', turnId: 'failed-compact', autoResume: true } } : {}) });
  let quota = 'exhausted', resumes = 0;
  h.runtime.quota = async () => ({ status: quota, queriedAt: new Date().toISOString() });
  h.runtime.resumeQuota = async (...args) => { resumes++; h.state.quota = null; return h.runtime.sendControl(...args); };
  h.store.restartConfirmation = { blocks: () => true, assertAllowed() {} };
  await h.controller.advance(old.id); // Query is read-only, even before restart consent.
  assert.equal(h.store.cycle(old.id).maintenanceQuota.status, 'exhausted');
  assert.equal(h.delivered.length, 1); assert.equal(h.compactCount(), 0);
  await assert.rejects(h.controller.restartFromCurrent(old.id), /额度仍不足/);
  quota = 'unknown'; await assert.rejects(h.controller.restartFromCurrent(old.id), /尚未确认可用/);
  quota = 'available'; h.store.restartConfirmation = null;
  const queued = await h.service.mailbox.send({ id: randomUUID(), createdAt: at, from: { ...h.target, client: 'codex' }, to: h.target, text: 'retained-after-quota' });
  const next = await h.controller.restartFromCurrent(old.id);
  assert.equal(next.state, 'writing_handoff'); assert.equal(resumes, Number(limited)); assert.equal(h.compactCount(), 0);
  assert.deepEqual(h.store.checkpoint(old.id, 'handoff'), saved); assert.equal(await readFile(old.handoffPath, 'utf8'), 'Old accepted progress');
  const receipt = stage => h.checkpoints.accept({ from: h.target, cycleId: next.id, stage,
    receiptToken: h.store.getSetting('cycle-tokens:' + next.id)[stage], documentPath: next.handoffPath });
  await writeFile(next.handoffPath, 'New progress'); await receipt('handoff'); h.endTurn();
  for (let i = 0; i < 4; i++) await h.controller.advance(next.id);
  assert.equal(h.compactCount(), 1); assert.equal(h.store.cycle(next.id).state, 'restoring');
  await receipt('restored'); await h.service.mailbox.flush(); assert.equal(h.store.getMessage(queued.id).status, 'queued');
  h.endTurn(); await h.controller.advance(next.id); await h.service.mailbox.flush();
  assert.equal(h.store.cycle(next.id).state, 'completed'); assert.equal(h.delivered.filter(x => x === 'retained-after-quota').length, 1);
  await assert.rejects(h.controller.restartFromCurrent(old.id)); assert.equal(h.compactCount(), 1);
});

test('failed-compaction restart rejects late success, missing settings, new input during quota check and cancelled work', async t => {
  const h = await harness(t); h.endTurn(); const id = h.cycle.id, at = new Date().toISOString();
  h.store.updateCycle(id, 'needs_attention', { previousState: 'compacting', compactDispatched: true, compactIntentAt: at,
    compactRequestId: 'failure', compactResult: { requestId: 'failure', status: 'failed', completedAt: at } });
  h.runtime.quota = async () => ({ status: 'available', queriedAt: new Date().toISOString() });
  h.state.lastCompaction = { requestId: 'failure', status: 'completed' };
  await assert.rejects(h.controller.restartFromCurrent(id), /已经完成/); h.state.lastCompaction = null;
  h.state.model = null; await assert.rejects(h.controller.restartFromCurrent(id), /未读取完成/); h.state.model = 'fixed';
  h.runtime.quota = async () => { h.state.activityRevision++; return { status: 'available', queriedAt: new Date().toISOString() }; };
  await assert.rejects(h.controller.restartFromCurrent(id), /状态已改变/);
  h.runtime.quota = async () => { await h.controller.cancel(id, false); return { status: 'available', queriedAt: new Date().toISOString() }; };
  await assert.rejects(h.controller.restartFromCurrent(id), /流程.*变化/);
  assert.equal(h.store.cycle(id).state, 'cancelled'); assert.equal(h.delivered.length, 1); assert.equal(h.compactCount(), 0);
});

test('Codex quota-paused handoff polls quota and passes a fresh reading to its native resume operation', async t => {
  const h = await harness(t, false, false, undefined, 'codex'); h.endTurn();
  Object.assign(h.state, { client: 'codex', activity: 'quota_limited', quota: { turnId: 'failed-turn', autoResume: true } });
  h.store.updateCycle(h.cycle.id, 'needs_attention', { previousState: 'writing_handoff', quotaWaiting: true });
  let reads = 0, resumes = 0; h.controller.quotaRecovery.read = async () => { reads++; return { status: 'available', queriedAt: new Date().toISOString() }; };
  h.runtime.resumeQuota = async (text, state, options) => {
    assert.equal(options.quota?.status, 'available'); assert.ok(Date.now() - Date.parse(options.quota.queriedAt) < 60000);
    resumes++; h.state.quota = null; return h.runtime.sendControl(text, state);
  };
  await h.controller.advance(h.cycle.id); assert.equal(h.store.cycle(h.cycle.id).maintenanceQuota.status, 'available');
  const next = await h.controller.restartFromCurrent(h.cycle.id);
  assert.equal(next.state, 'writing_handoff'); assert.equal(resumes, 1); assert.ok(reads >= 3); assert.equal(h.compactCount(), 0);
});

test('waiting-client reasons follow settings and activity changes without resetting the saved stage deadline', async t => {
  const h = await harness(t); h.endTurn();
  h.controller.waitForClient(h.store.cycle(h.cycle.id)); const first = h.store.cycle(h.cycle.id);
  h.controller.waitForClient(first, '等待客户端同步原模型、思考强度和权限选项，再核对接续。');
  const next = h.store.cycle(first.id); assert.notEqual(next.reason, first.reason);
  assert.equal(next.disconnectedAt, first.disconnectedAt); assert.equal(next.remainingStageMs, first.remainingStageMs);
  h.controller.waitForClient(next, next.reason); assert.equal(h.store.cycle(first.id).revision, next.revision);
});

test('maintenance uses customized handoff, next-stage restore and continuation while preserving real checkpoint gates', async t => {
  const h = await harness(t, true), settings = new PromptSettings(h.root), values = defaultPromptValues();
  values.maintenance = { handoff: 'CUSTOM HANDOFF {{documentPath}}\n{{checkpoint}}', restore: 'OLD RESTORE\n{{checkpoint}}', continue: 'CUSTOM CONTINUE {{sessionId}}' };
  await settings.save(values, 0);
  await h.controller.advance(h.cycle.id); await h.controller.advance(h.cycle.id);
  assert.ok(h.delivered[0].startsWith('CUSTOM HANDOFF ')); assert.ok(h.delivered[0].includes(h.cycle.handoffPath));
  await mkdir(dirname(h.cycle.handoffPath), { recursive: true }); await writeFile(h.cycle.handoffPath, 'custom flow handoff');
  await h.receipt('handoff'); h.endTurn();
  values.maintenance.restore = 'UPDATED RESTORE {{cycleId}}\n{{checkpoint}}'; await settings.save(values, 1);
  for (let i = 0; i < 4; i++) await h.controller.advance(h.cycle.id);
  assert.ok(h.delivered[1].startsWith('UPDATED RESTORE ' + h.cycle.id));
  assert.equal(h.store.cycle(h.cycle.id).controlPromptRevision, 2);
  h.service.mailbox.deliverResume = async item => { h.delivered.push(item.text); return { status: 'submitted' }; };
  await h.receipt('restored'); h.endTurn(); await h.controller.advance(h.cycle.id);
  assert.equal(h.store.cycle(h.cycle.id).state, 'completed');
  assert.equal(h.delivered[2], 'CUSTOM CONTINUE ' + h.target.id); assert.equal(h.compactCount(), 1);
});
test('native user intervention leaves the lock and queue for the user to resolve', async t => {
  const h = await harness(t); h.state.activeTurnId = 'new-native-user-turn';
  await h.controller.advance(h.cycle.id); assert.equal(h.store.cycle(h.cycle.id).state, 'user_intervened');
  assert.equal(h.compactCount(), 0);
  assert.equal(h.store.activeCycle(h.target).id, h.cycle.id);
});
test('a finished control turn without its receipt requires attention; explicit retry reuses the existing lock', async t => {
  const h = await harness(t); h.endTurn(); await h.controller.advance(h.cycle.id);
  assert.equal(h.store.cycle(h.cycle.id).state, 'needs_attention'); assert.equal(h.compactCount(), 0);
  await h.controller.retry(h.cycle.id);
  assert.equal(h.store.cycle(h.cycle.id).state, 'writing_handoff');
  assert.equal(h.store.activeCycle(h.target).id, h.cycle.id); assert.equal(h.compactCount(), 0);
});
test('reconciliation resumes a confirmed compaction without sending another compact command', async t => {
  const h = await harness(t); const id = h.cycle.id, cycle = h.store.cycle(id);
  await mkdir(dirname(cycle.handoffPath), { recursive: true }); await writeFile(cycle.handoffPath, 'context');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.compactCount(), 1);
  h.store.updateCycle(id, 'needs_attention', { previousState: 'compacting', reason: 'simulated restart' });
  await h.controller.reconcile(id);
  assert.equal(h.store.cycle(id).state, 'restoring'); assert.equal(h.compactCount(), 1);
  assert.equal(h.store.cycle(id).compactDispatched, true);
  h.endTurn(); await h.controller.advance(id); await h.controller.retry(id);
  assert.equal(h.compactCount(), 1); assert.equal(h.store.cycle(id).compactDispatched, true);
});

test('shutdown waits for the active observation despite later timer ticks', async t => {
  let began, release, monitorClosed = false;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const controller = new MaintenanceController({ root: resolve('.'), intervalMs: 2,
    store: { activeCycles: () => [], policies: () => [], event() {} }, service: {},
    monitor: { async observeAll() { began(); await gate; return new Map(); }, close() { monitorClosed = true; } },
  });
  t.after(async () => { release(); await controller.close(); });
  controller.start();
  // Keep the test alive while the controller's unref'ed interval starts.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await started;
    const active = controller.tickPromise;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(controller.tickPromise, active);
    const closing = controller.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(monitorClosed, false);
    release(); await closing;
    assert.equal(monitorClosed, true);
  } finally { clearTimeout(keepAlive); }
});

test('a Claude HTTP timeout keeps polling and restores after the same compaction completes late', async t => {
  const h = await harness(t), id = h.cycle.id, c = h.store.cycle(id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'context');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id);
  const compact = h.runtime.compact; let completion;
  h.runtime.compact = async () => {
    const previous = h.state.lastCompletedTurnId;
    completion = await compact();
    h.state.activity = 'running'; h.state.activeTurnId = completion.requestId;
    h.state.lastCompletedTurnId = previous; h.state.compactionRequestId = completion.requestId;
    return { status: 'unknown', requestId: completion.requestId, sessionId: h.target.id };
  };
  await h.controller.advance(id); assert.equal(h.store.cycle(id).state, 'compacting');
  await h.controller.advance(id); assert.equal(h.store.cycle(id).state, 'compacting');
  assert.equal(h.compactCount(), 1); assert.equal(h.delivered.length, 1);
  h.state.activity = 'idle'; h.state.activeTurnId = null; h.state.compactionRequestId = null;
  h.state.lastCompletedTurnId = completion.requestId; h.state.lastCompaction = completion;
  await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'restoring'); assert.equal(h.delivered.length, 2);
  assert.equal(h.store.cycle(id).compactResult.status, 'completed');
  await h.receipt('restored'); h.endTurn(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'completed'); assert.equal(h.compactCount(), 1);
});

test('late compaction reconciliation rejects another request or a newer native turn', async t => {
  const h = await harness(t), id = h.cycle.id, c = h.store.cycle(id);
  await mkdir(dirname(c.handoffPath), { recursive: true }); await writeFile(c.handoffPath, 'context');
  await h.receipt('handoff'); h.endTurn(); await h.controller.advance(id); await h.controller.advance(id);
  const completion = h.store.cycle(id).compactResult;
  h.store.updateCycle(id, 'needs_attention', { previousState: 'compacting', compactResult: { status: 'unknown', requestId: completion.requestId } });
  h.state.lastCompaction = { ...completion, requestId: 'different-request' };
  await assert.rejects(h.controller.reconcile(id), /没有足够/);
  h.state.lastCompaction = completion; h.state.lastCompletedTurnId = 'newer-native-turn';
  await assert.rejects(h.controller.reconcile(id), /没有足够/);
  assert.equal(h.store.cycle(id).state, 'needs_attention'); assert.equal(h.compactCount(), 1);
  h.state.lastCompletedTurnId = completion.requestId;
  await h.controller.reconcile(id);
  assert.equal(h.store.cycle(id).state, 'restoring'); assert.equal(h.compactCount(), 1);
});


test('hard maintenance waits for original native completion after interrupt acknowledgment before sending a visible prompt', async t => {
  const h = await harness(t, true, true), id = h.cycle.id;
  assert.equal(h.interruptCount(), 1); assert.equal(h.delivered.length, 0);
  await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.state.activity, 'running'); assert.equal(h.delivered.length, 0); assert.equal(h.interruptCount(), 1);
  h.endTurn(); await h.controller.advance(id);
  assert.equal(h.delivered.length, 0);
  await h.controller.advance(id);
  assert.equal(h.delivered.length, 1); assert.ok(h.delivered[0].includes('context_checkpoint'));
  assert.equal(h.compactCount(), 0);
});


async function reconnect(h, instance = 'restarted') {
  h.state.instanceId = instance; h.state.activity = 'idle'; h.state.activeTurnId = null;
  h.state.lastCompletedTurnId = null; h.state.activityRevision++;
  h.controller.recoveryPollAt.clear(); await h.controller.advance(h.cycle.id);
}
for (const client of ['claude', 'codex']) test(`${client}: service restart before the still-live client is ready preserves and advances an accepted handoff`, async t => {
  const h = await harness(t, false, false, undefined, client), id = h.cycle.id;
  await mkdir(dirname(h.cycle.handoffPath), { recursive: true }); await writeFile(h.cycle.handoffPath, 'saved handoff');
  await h.receipt('handoff'); h.store.recoverInFlight();
  await h.controller.advance(id); assert.equal(h.delivered.length, 1); assert.equal(h.compactCount(), 0);
  h.endTurn(); h.controller.recoveryPollAt.clear(); await h.controller.advance(id); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'compacting'); assert.equal(h.delivered.length, 1);
});
test('service restart reopens the original running handoff receipt gate without resending', async t => {
  const h = await harness(t), id = h.cycle.id;
  h.store.recoverInFlight(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state, 'writing_handoff'); assert.equal(h.delivered.length, 1);
  await mkdir(dirname(h.cycle.handoffPath), { recursive: true }); await writeFile(h.cycle.handoffPath, 'saved');
  assert.equal((await h.receipt('handoff')).status, 'accepted');
});
test('offline maintenance pauses its deadline and keeps queued messages until the same client returns', async t => {
  const h=await harness(t), id=h.cycle.id;
  h.state.connected=false; h.store.updateCycle(id,h.store.cycle(id).state,{deadlineAt:new Date(0).toISOString()});
  await h.controller.advance(id); assert.equal(h.store.cycle(id).state,'waiting_client');
  assert.equal(h.store.activeCycle(h.target).id,id); assert.equal(h.compactCount(),0);
  h.state.connected=true; h.controller.recoveryPollAt.clear(); await h.controller.advance(id);
  assert.equal(h.store.cycle(id).state,'writing_handoff'); assert.equal(h.delivered.length,1);
});
test('new Claude instance retries only the unfinished maintenance prompt once', async t => {
  let lastInputId='control-1';
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId,source:'fixture'}));
  await reconnect(h); assert.equal(h.store.cycle(h.cycle.id).controlDispatched,false);
  assert.equal(h.delivered.length,1); await h.controller.advance(h.cycle.id);
  assert.equal(h.delivered.length,2); assert.equal(h.interruptCount(),0); assert.equal(h.compactCount(),0);
  await h.controller.advance(h.cycle.id); assert.equal(h.delivered.length,2);
});
test('accepted handoff survives a new instance without resending or compacting twice', async t => {
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1',source:'fixture'}));
  const c=h.store.cycle(h.cycle.id); await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'unchanged document');
  await h.receipt('handoff'); await reconnect(h);
  assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');
  await h.controller.advance(c.id);await h.controller.advance(c.id);
  assert.equal(h.compactCount(),1);assert.equal(h.delivered.length,1);
});
test('late handoff receipt is accepted while waiting for reconnection', async t => {
  const h=await harness(t),c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');
  h.state.connected=false;await h.controller.advance(c.id);
  assert.equal(h.store.cycle(c.id).state,'waiting_client');
  assert.equal((await h.receipt('handoff')).status,'accepted');
  assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');
});
test('new business input never auto-resumes or triggers another prompt', async t => {
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'new-business-input',source:'fixture'}));
  await reconnect(h);assert.equal(h.store.cycle(h.cycle.id).state,'needs_attention');assert.equal(h.store.cycle(h.cycle.id).recoveryBlocked,true);
  await h.controller.advance(h.cycle.id);assert.equal(h.delivered.length,1);
});
test('restored receipt after restart releases FIFO and continues only after verified idle boundary', async t => {
  let lastInputId='control-1';
  const h=await harness(t,true,false,async()=>({verified:true,lastInputId,source:'fixture'})),id=h.cycle.id;
  await h.controller.advance(id);await h.controller.advance(id);
  const c=h.store.cycle(id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');
  await h.receipt('handoff');h.endTurn();await h.controller.advance(id);await h.controller.advance(id);await h.controller.advance(id);await h.controller.advance(id);
  await h.receipt('restored');lastInputId=h.store.cycle(id).controlTurnId;
  await h.service.mailbox.send({id:randomUUID(),createdAt:new Date().toISOString(),from:{...h.target,client:'codex'},to:h.target,text:'queued-after-restore'});
  await reconnect(h);assert.equal(h.store.cycle(id).state,'awaiting_restore_end');
  await h.controller.advance(id);assert.equal(h.store.cycle(id).state,'completed');
  assert.deepEqual(h.delivered.slice(-2),['continue','queued-after-restore']);assert.equal(h.compactCount(),1);
});


test('changed document and changed selected settings block restart recovery', async t => {
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1',source:'fixture'}));
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'before');await h.receipt('handoff');
  await writeFile(c.handoffPath,'changed');await reconnect(h);
  assert.equal(h.store.cycle(c.id).recoveryBlocked,true);assert.equal(h.compactCount(),0);
});
test('a known model change never triggers an automatic resend after restart',async t=>{
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1'}));
  h.state.model='different';await reconnect(h);assert.equal(h.store.cycle(h.cycle.id).recoveryBlocked,true);assert.equal(h.delivered.length,1);
});
test('reopened maintenance waits for selected settings to arrive instead of treating unknown as unchanged', async t => {
  const h = await harness(t, false, false, async () => ({ verified: true, lastInputId: 'control-1' }));
  h.state.model = null; await reconnect(h);
  assert.equal(h.store.cycle(h.cycle.id).state, 'waiting_client'); assert.equal(h.delivered.length, 1);
  h.state.model = 'fixed'; h.controller.recoveryPollAt.clear(); await h.controller.advance(h.cycle.id);
  assert.equal(h.store.cycle(h.cycle.id).controlDispatched, false);
});

for (const client of ['claude', 'codex']) test(`${client}: a changed or missing effort never blocks reconnecting the original maintenance turn`, async t => {
  const h = await harness(t, false, false, async () => ({ verified: true, lastInputId: 'control-1' }), client);
  h.store.updateCycle(h.cycle.id, 'writing_handoff', { triggerRuntime: { ...h.cycle.triggerRuntime, effort: 'high' } });
  h.state.effort = null; h.state.selectionKnown = ['model', 'effort']; await reconnect(h);
  assert.equal(h.store.cycle(h.cycle.id).state, 'writing_handoff'); assert.equal(h.store.cycle(h.cycle.id).controlDispatched, false);
  assert.equal(h.delivered.length, 1);
});
test('a receipt arriving during recovery evidence read is not overwritten',async t=>{
  let accept;
  const h=await harness(t,false,false,async()=>{await accept();return {verified:true,lastInputId:'control-1'};});
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');accept=()=>h.receipt('handoff');
  await reconnect(h);assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');assert.equal(h.delivered.length,1);
});


test('Codex instance recovery uses the native completed turn ID and retains accepted handoff',async t=>{
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'control-1',terminal:true,source:'codex-native-head'}));
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');await h.receipt('handoff');
  h.store.updateCycle(c.id,'awaiting_handoff_end',{session:{...c.session,client:'codex'}});
  h.state.latestTurn={id:'control-1',status:'completed',itemTypes:['userMessage']};
  await reconnect(h);assert.equal(h.store.cycle(c.id).state,'awaiting_handoff_end');
  await h.controller.advance(c.id);assert.equal(h.store.cycle(c.id).state,'compacting');assert.equal(h.delivered.length,1);
});
test('missing or unknown completion after new instance stops compaction rather than repeating it',async t=>{
  const h=await harness(t,false,false,async()=>({verified:true,lastInputId:'compact-unknown',compactCompleted:false,source:'fixture'}));
  const c=h.store.cycle(h.cycle.id);await mkdir(dirname(c.handoffPath),{recursive:true});await writeFile(c.handoffPath,'doc');await h.receipt('handoff');
  h.store.updateCycle(c.id,'compacting',{compactDispatched:true,compactIntentAt:new Date().toISOString()});
  await reconnect(h);assert.equal(h.store.cycle(c.id).recoveryBlocked,true);assert.equal(h.compactCount(),0);
});
