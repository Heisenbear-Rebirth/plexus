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
