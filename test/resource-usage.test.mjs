import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { instanceRecords } from '../src/claude-instance-registry.mjs';
import { ManagementStore, sessionKey } from '../src/management-store.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';
import { startServer } from '../src/http-server.mjs';

// Closers run before the folder is removed: SQLite keeps its files open.
async function scratch(t, prefix, closers = []) {
  const base = path.join(process.cwd(), 'test'), root = await mkdtemp(path.join(base, prefix));
  t.after(async () => { for (const close of closers.reverse()) await close(); assert.equal(path.dirname(path.resolve(root)), base); await rm(root, { recursive: true, force: true }); });
  return root;
}
async function exitedPid() {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise(resolve => child.once('close', resolve)); return child.pid;
}

test('wrapper records of exited processes are deleted, live ones are indexed once and seen at once when added', async t => {
  const folder = await scratch(t, '.instances-'), dead = await exitedPid();
  const record = (pid, extra = {}) => ({ sessionId: randomUUID(), instanceId: randomUUID(), endpoint: 'http://127.0.0.1:1', token: 'a'.repeat(64), wrapperPid: pid, ...extra });
  const live = record(process.pid, { childPid: process.pid }), orphan = record(process.pid, { childPid: dead });
  await writeFile(path.join(folder, `${dead}-${randomUUID()}.json`), JSON.stringify(record(dead)));
  await writeFile(path.join(folder, `${dead}-${randomUUID()}.json.tmp`), '{');
  await writeFile(path.join(folder, `${process.pid}-${live.instanceId}.json`), JSON.stringify(live));
  await writeFile(path.join(folder, `${process.pid}-${orphan.instanceId}.json`), JSON.stringify(orphan));
  const manual = record(dead); await writeFile(path.join(folder, 'manual.json'), JSON.stringify(manual));
  const first = await instanceRecords(folder);
  // Files not named by a wrapper are listed as before; the HTTP check still rejects them.
  assert.deepEqual(first.map(r => r.instanceId).sort(), [live.instanceId, manual.instanceId].sort());
  assert.deepEqual((await readdir(folder)).sort(), [`${process.pid}-${live.instanceId}.json`, 'manual.json'].sort(), 'only owned records of exited processes are deleted');
  assert.equal(await instanceRecords(folder), first, 'an unchanged folder is answered from the index');
  const added = record(process.pid, { childPid: process.pid }), file = path.join(folder, `${process.pid}-${added.instanceId}.json`);
  await writeFile(file + '.tmp', JSON.stringify(added)); await rename(file + '.tmp', file);
  assert.ok((await instanceRecords(folder)).some(r => r.instanceId === added.instanceId), 'a new wrapper is visible without waiting for the index age');
});

test('a snapshot that differs only in sampling times stays in memory and is not rewritten', async t => {
  const closers = [], directory = await scratch(t, '.snapshots-', closers), store = await new ManagementStore(directory).init();
  closers.push(() => store.close());
  const session = { client: 'codex', id: randomUUID(), cwd: directory }, stored = () => JSON.parse(store.db.prepare('SELECT data FROM snapshots').get().data);
  const sample = (at, activity = 'idle') => ({ session, runtime: { connected: true, activity, observedAt: at, accountQuota: { status: 'ok', queriedAt: at } }, observedAt: at });
  assert.equal(store.saveSnapshot(session, sample('2026-01-01T00:00:00.000Z')), true);
  assert.equal(store.saveSnapshot(session, sample('2026-01-01T00:00:02.000Z')), false);
  assert.equal(stored().observedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(store.getSnapshot(session).observedAt, '2026-01-01T00:00:02.000Z', 'readers see the latest sample');
  assert.equal(store.saveSnapshot(session, sample('2026-01-01T00:00:04.000Z', 'running')), true);
  assert.equal(stored().runtime.activity, 'running');
  // A write rolled back with its transaction is written again by the next sample.
  assert.throws(() => store.transaction(() => { store.saveSnapshot(session, sample('2026-01-01T00:00:06.000Z', 'idle')); throw new Error('rollback'); }), /rollback/);
  assert.equal(stored().runtime.activity, 'running');
  assert.equal(store.saveSnapshot(session, sample('2026-01-01T00:00:08.000Z', 'idle')), true);
  assert.equal(stored().runtime.activity, 'idle');
  store.close();
  const reopened = await new ManagementStore(directory).init();
  closers.push(() => reopened.close());
  assert.equal(reopened.getSnapshot(session).runtime.activity, 'idle');
  assert.equal(reopened.saveSnapshot(session, sample('2026-01-01T00:00:10.000Z', 'idle')), false);
});

test('a deferred message backs off, and retries at once when the receiver changes', async t => {
  const closers = [], directory = await scratch(t, '.mailbox-', closers), store = await new ManagementStore(directory).init();
  store.acquireManager();
  let ready = false, calls = 0;
  const mailbox = new SessionMailbox({ store, deliverResume: async () => ({ status: 'submitted' }), deliverMessage: async () => {
    calls++; return ready ? { status: 'submitted' } : { status: 'deferred', notSubmitted: true, reason: 'receiver_unavailable', detail: 'not yet' };
  } });
  closers.push(async () => { await mailbox.close(); store.close(); });
  const to = { client: 'claude', id: randomUUID(), cwd: directory }, key = sessionKey(to);
  const sent = await mailbox.send({ id: randomUUID(), text: 'hello', from: { client: 'codex', id: randomUUID() }, to, createdAt: new Date().toISOString() });
  assert.equal(sent.status, 'queued'); assert.equal(calls, 1);
  await mailbox.flush(); await mailbox.flush();
  assert.equal(calls, 1, 'no retry before the delay');
  store.saveSnapshot(to, { session: to, runtime: { connected: true, activity: 'idle' } });
  await mailbox.flush(); assert.equal(calls, 2, 'a changed receiver is retried at once');
  await mailbox.flush(); assert.equal(calls, 2);
  assert.equal(mailbox.backoff.get(key).delay, 4000);
  ready = true; mailbox.backoff.get(key).until = 0;
  await mailbox.flush(); assert.equal(calls, 3);
  assert.equal(store.getMessage(sent.id).status, 'submitted'); assert.equal(mailbox.backoff.has(key), false);
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM events WHERE type='dispatch_deferred'").get().n, 2);
});

test('the message list answers an unchanged revision without the list', async t => {
  const closers = [], root = await scratch(t, '.messages-revision-', closers);
  const server = await startServer({ root, port: 0, startMonitoring: false, adapters: { codex: { find: async () => null, list: async () => ({ sessions: [], warnings: [] }) } } });
  closers.push(() => server.close());
  const get = async query => (await fetch(server.url + '/api/messages?' + new URLSearchParams(query))).json();
  const first = await get({}); assert.ok(first.revision); assert.deepEqual(first.messages, []);
  assert.deepEqual(await get({ revision: first.revision }), { unchanged: true, revision: first.revision });
  const to = { client: 'codex', id: randomUUID() };
  server.store.create({ id: randomUUID(), text: 'x', from: { client: 'claude', id: randomUUID() }, to, status: 'queued', createdAt: new Date().toISOString() });
  const changed = await get({ revision: first.revision });
  assert.notEqual(changed.revision, first.revision); assert.equal(changed.messages.length, 1);
});

// Minimal Codex IPC host: answers initialize and owner discovery.
async function ipcHost(t) {
  const { createServer } = await import('node:net'); const sockets = new Set(); let initializes = 0;
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); let buffered = Buffer.alloc(0);
    socket.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes]);
      while (buffered.length >= 4 && buffered.length >= buffered.readUInt32LE() + 4) {
        const length = buffered.readUInt32LE(), frame = JSON.parse(buffered.subarray(4, length + 4)); buffered = buffered.subarray(length + 4);
        if (frame.type !== 'request') continue;
        if (frame.method === 'initialize') initializes++;
        const body = Buffer.from(JSON.stringify({ type: 'response', requestId: frame.requestId, resultType: 'success', result: frame.method === 'initialize' ? { clientId: 'one-client' } : {} }));
        const size = Buffer.alloc(4); size.writeUInt32LE(body.length); socket.write(Buffer.concat([size, body]));
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return { endpoint: { host: '127.0.0.1', port: server.address().port }, sockets, initializes: () => initializes, close: () => new Promise(resolve => { for (const socket of sockets) socket.destroy(); server.close(resolve); }) };
}

test('Codex conversations share one IPC connection, and closing one conversation keeps it open', async t => {
  const { CodexIpc } = await import('../src/runtime/codex-ipc.mjs'), { CodexRuntime } = await import('../src/runtime/codex-runtime.mjs');
  const host = await ipcHost(t), ipc = new CodexIpc({ endpoint: host.endpoint, timeoutMs: 1000 }); ipc.shared = true;
  t.after(() => ipc.close());
  const runtimes = Array.from({ length: 5 }, () => new CodexRuntime(randomUUID(), { ipc, timeoutMs: 500 }));
  const states = await Promise.all(runtimes.map(runtime => runtime.status()));
  assert.ok(states.every(state => state.activity === 'unloaded'));
  assert.equal(host.initializes(), 1, 'concurrent callers register once'); assert.equal(host.sockets.size, 1);
  runtimes[0].close();
  assert.equal(ipc.connected, true); assert.equal((await runtimes[1].status()).activity, 'unloaded'); assert.equal(host.initializes(), 1);
});

test('a missing Codex pipe is probed once per retry delay, and a replaced socket cannot disconnect the new one', async t => {
  const { CodexIpc } = await import('../src/runtime/codex-ipc.mjs');
  const missing = new CodexIpc({ endpoint: '\\\\.\\pipe\\plexus-test-missing-' + randomUUID(), timeoutMs: 1000, retryDelayMs: 60000 });
  await assert.rejects(missing.connect(), /CODEX_IPC_OFFLINE/);
  const first = missing.socket; await assert.rejects(missing.connect(), /CODEX_IPC_OFFLINE/);
  assert.equal(missing.socket, first, 'no second attempt within the retry delay');
  const host = await ipcHost(t), ipc = new CodexIpc({ endpoint: host.endpoint, timeoutMs: 1000 });
  t.after(() => ipc.close());
  await ipc.connect(); const old = ipc.socket; ipc.close(); await ipc.connect();
  old.emit('close');
  assert.equal(ipc.connected, true); assert.equal(host.initializes(), 2);
});

test('saved Codex connections whose pipe is gone are not probed, and a connected bridge rechecks only its pipe', async t => {
  const { createServer } = await import('node:net');
  const { CodexBridgeConnection, pipeExists, rememberCodexBridge } = await import('../src/codex-bridge-connection.mjs');
  const pipe = '\\\\.\\pipe\\plexus-test-bridge-' + randomUUID(), server = createServer(socket => socket.destroy());
  await new Promise(resolve => server.listen(pipe, resolve));
  let open = true; t.after(() => open && new Promise(resolve => server.close(resolve)));
  assert.equal(await pipeExists(pipe), true); assert.equal(await pipeExists(pipe + '-gone'), false); assert.equal(await pipeExists('/tmp/socket'), true);
  const root = await scratch(t, '.bridge-'), caller = '11111111-1111-4111-8111-111111111111';
  await rememberCodexBridge(root, { pipePath: pipe, callerThreadId: caller });
  let probes = 0;
  const bridge = await new CodexBridgeConnection({ root, intervalMs: 600000, probe: async context => { probes++; if (!await pipeExists(context.pipePath)) throw Error('gone'); } }).init();
  t.after(() => bridge.close());
  assert.equal(bridge.status().connected, true); assert.equal(probes, 1);
  await bridge.refresh({ periodic: true }); await bridge.refresh({ periodic: true });
  assert.equal(probes, 1, 'periodic checks while connected start no probe');
  await new Promise(resolve => server.close(resolve)); open = false;
  await bridge.refresh({ periodic: true });
  assert.equal(bridge.status().connected, false); assert.equal(probes, 2);
});

test('OpenCode registrations of exited backends are deleted, and a refused backend is not asked again at once', async t => {
  const { createServer } = await import('node:net'), { createOpenCodeAdapter } = await import('../src/adapters/opencode.mjs');
  const root = await scratch(t, '.opencode-registry-'), folder = path.join(root, '.plexus', 'opencode', 'instances'), dead = await exitedPid();
  const probe = createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const closedPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const registration = pid => ({ instanceId: randomUUID(), token: 'b'.repeat(64), endpoint: 'http://127.0.0.1:' + closedPort, directory: root, pid, startedAt: new Date().toISOString(), protocol: 1 });
  const exited = registration(dead), refused = registration(process.pid);
  await (await import('node:fs/promises')).mkdir(folder, { recursive: true });
  for (const record of [exited, refused]) await writeFile(path.join(folder, record.instanceId + '.json'), JSON.stringify(record));
  const original = globalThis.fetch; let requests = 0;
  globalThis.fetch = (...args) => { requests++; return original(...args); }; t.after(() => { globalThis.fetch = original; });
  const adapter = createOpenCodeAdapter({ root, timeout: 2000 });
  assert.equal(await adapter.find('ses_missing'), null);
  assert.deepEqual(await readdir(folder), [refused.instanceId + '.json'], 'only the exited backend is removed');
  assert.equal(requests, 1);
  assert.equal(await adapter.find('ses_missing'), null); assert.equal(requests, 1, 'a refused backend is skipped for a while');
});

test('policies, settings and cycles are read from memory, and writes and rollbacks keep those reads exact', async t => {
  const { StatementSync } = await import('node:sqlite');
  const closers = [], directory = await scratch(t, '.store-cache-', closers), store = await new ManagementStore(directory).init();
  closers.push(() => store.close()); store.acquireManager();
  const session = { client: 'codex', id: randomUUID(), cwd: directory }, quotaKey = 'quota-recovery:' + sessionKey(session);
  store.savePolicy(session, { enabled: true }); store.setSetting(quotaKey, { state: 'idle' });
  const cycle = store.createCycle({ session, state: 'writing_handoff' });
  const reads = () => [store.getPolicy(session), store.getSetting(quotaKey), store.getSetting('absent'), store.activeCycle(session), store.policies(), store.activeCycles(), store.lastCycle(session)];
  reads();
  const methods = ['get', 'all'], originals = methods.map(name => StatementSync.prototype[name]); let executed = 0;
  const restore = () => methods.forEach((name, i) => { StatementSync.prototype[name] = originals[i]; }); t.after(restore);
  methods.forEach((name, i) => { StatementSync.prototype[name] = function (...args) { executed++; return originals[i].apply(this, args); }; });
  for (let i = 0; i < 20; i++) reads();
  restore();
  assert.equal(executed, 0, 'a maintenance tick over unchanged state runs no query');
  const [policy, quota, absent, active] = reads();
  assert.equal(policy.enabled, true); assert.equal(quota.state, 'idle'); assert.equal(absent, null); assert.equal(active.id, cycle.id);
  active.state = 'changed by a caller'; assert.equal(store.activeCycle(session).state, 'writing_handoff', 'callers get private copies');
  assert.throws(() => store.transaction(() => {
    store.setSetting('absent', 1); store.savePolicy(session, { enabled: false }); store.updateCycle(cycle.id, 'compacting'); throw new Error('rollback');
  }), /rollback/);
  assert.equal(store.getSetting('absent'), null); assert.equal(store.getPolicy(session).enabled, true); assert.equal(store.activeCycle(session).state, 'writing_handoff');
  store.releaseCycle(cycle.id, { cancel: true });
  assert.equal(store.activeCycle(session), null); assert.equal(store.lastCycle(session).state, 'cancelled');
  store.close();
  const reopened = await new ManagementStore(directory).init(); closers.push(() => reopened.close());
  assert.equal(reopened.getPolicy(session).enabled, true); assert.equal(reopened.getSetting(quotaKey).state, 'idle'); assert.equal(reopened.lastCycle(session).state, 'cancelled');
});

test('a policy whose session no longer exists is looked up once a minute, not on every tick', async t => {
  const { ContextMonitor } = await import('../src/context-monitor.mjs');
  let lookups = 0;
  const monitor = new ContextMonitor({ store: {}, service: { adapters: { claude: { find: async () => { lookups++; return null; } } } } });
  t.after(() => monitor.close());
  const session = { client: 'claude', id: randomUUID(), hostId: 'local' };
  await assert.rejects(monitor.sample(session), /无法在获准目录内确认该会话/);
  await assert.rejects(monitor.sample(session), /无法在获准目录内确认该会话/);
  assert.equal(lookups, 1);
  await assert.rejects(monitor.sample(session, { native: true }), /无法在获准目录内确认该会话/);
  assert.equal(lookups, 2, 'an explicit refresh still looks it up');
});

test('an unchanged Codex history database is not opened again for discovery', async t => {
  const { DatabaseSync } = await import('node:sqlite'), { listCodexSessions } = await import('../src/adapters/codex.mjs');
  const closers = [], root = await scratch(t, '.codex-history-', closers);
  const database = new DatabaseSync(path.join(root, 'state_5.sqlite')); closers.push(() => { try { database.close(); } catch {} });
  database.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, source TEXT DEFAULT 'vscode', thread_source TEXT DEFAULT 'user')");
  const insert = database.prepare('INSERT INTO threads (id,title,cwd) VALUES (?,?,?)'); insert.run('first', 'First', '/project');
  const prepare = DatabaseSync.prototype.prepare; let opened = 0;
  DatabaseSync.prototype.prepare = function (sql, ...rest) { if (String(sql).includes('table_info(threads)')) opened++; return prepare.call(this, sql, ...rest); };
  t.after(() => { DatabaseSync.prototype.prepare = prepare; });
  const ids = async () => (await listCodexSessions({ codexHome: root })).sessions.map(s => s.id).sort();
  assert.deepEqual(await ids(), ['first']); assert.deepEqual(await ids(), ['first']);
  assert.equal(opened, 1);
  insert.run('second', 'Second', '/project');
  assert.deepEqual(await ids(), ['first', 'second']); assert.equal(opened, 2);
});
