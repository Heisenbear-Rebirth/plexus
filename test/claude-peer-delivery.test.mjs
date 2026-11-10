import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClaudeProtocolState } from '../src/claude-wrapper-state.mjs';
import { ClaudeRuntime } from '../src/runtime/claude-runtime.mjs';
import { ManagementStore, sessionKey } from '../src/management-store.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';
import { peerDeliveryOutcome } from '../src/peer-delivery.mjs';

const project = resolve('.');
const sender = { client: 'claude', id: randomUUID(), cwd: project, name: 'author' };
const recipient = { client: 'claude', id: randomUUID(), cwd: project, name: 'receiver' };
const record = (to = recipient) => ({ id: randomUUID(), status: 'pending', createdAt: new Date().toISOString(), from: sender, to, text: 'fixture' });
async function storeFixture(t) {
  const dir = await mkdtemp(join(project, '.management-test-')); const store = await new ManagementStore(dir).init(); store.acquireManager();
  t.after(async () => { store.close(); assert.ok(resolve(dir).startsWith(project + '\\') || resolve(dir).startsWith(project + '/')); await rm(dir, { recursive: true, force: true }); });
  return store;
}
const hold = (messageId, cause = 'mode-mismatch') => ({ messageId, state: 'held', cause, observedAt: new Date().toISOString() });
const expired = (messageId, cause = 'mode-mismatch') => ({ messageId, state: 'dropped', cause, outcome: 'expired', heldAt: new Date().toISOString(), observedAt: new Date().toISOString() });

test('wrapper keeps each recent message outcome so a later acceptance cannot hide an earlier drop', () => {
  const s = new ClaudeProtocolState(randomUUID()); s.initialized = true;
  const [held, accepted] = [randomUUID(), randomUUID()]; s.expectPeer(held); s.expectPeer(accepted);
  const event = { type: 'system', subtype: 'peer_message_hold', session_id: s.sessionId, lane: 'socket' };
  s.child({ ...event, message_uuid: held, state: 'held', cause: 'mode-mismatch' });
  s.child({ ...event, message_uuid: held, state: 'dropped', outcome: 'expired' });
  s.child({ type: 'user', session_id: s.sessionId, uuid: accepted, origin: { kind: 'peer' }, isReplay: true, message: { role: 'user', content: 'fixture' } });
  const state = s.publicState();
  assert.equal(state.peerDelivery.messageId, accepted);
  const byId = new Map(state.peerDeliveries.map(entry => [entry.messageId, entry]));
  assert.deepEqual([byId.get(held).state, byId.get(held).outcome, byId.get(held).cause], ['dropped', 'expired', 'mode-mismatch']);
  assert.equal(byId.get(accepted).state, 'received');
  for (let i = 0; i < 40; i++) s.expectPeer(randomUUID());
  assert.equal(s.publicState().peerDeliveries.length, 32, 'the outcome log stays bounded');
});

test('a native parity hold observed right after submission is reported to the sender, not a bare submission', async () => {
  const r = new ClaudeRuntime(randomUUID(), { peerVerdictMs: 1000 }), requestId = randomUUID(); let polls = 0;
  const capabilities = { peerQuotaRecovery: true, peerDeliveryLifecycle: true, peerMessageVisibility: true };
  r.status = async () => ({ instanceId: 'receiver', activity: 'running', capabilities,
    peerDeliveries: ++polls > 2 ? [hold(requestId)] : [{ messageId: requestId, state: 'pending' }] });
  r.request = async (path, body) => { assert.equal(path, '/peer-intent'); assert.equal(body.action, 'prepare'); return { status: 'ready' }; };
  r.sendPeer = async () => ({ status: 'submitted', transport: 'claude-peer-inbox' });
  const sent = await r.sendMessage('peer', { requestId });
  assert.equal(sent.status, 'submitted'); assert.equal(sent.nativeDelivery.state, 'held'); assert.equal(sent.nativeDelivery.cause, 'mode-mismatch');
  assert.match(sent.detail, /原生接收策略暂存.*权限类别不一致/);
});

test('without a native verdict the submission is reported unchanged after a bounded wait', async () => {
  const r = new ClaudeRuntime(randomUUID(), { peerVerdictMs: 200 }), requestId = randomUUID();
  r.status = async () => ({ instanceId: 'receiver', activity: 'idle', capabilities: { peerQuotaRecovery: true, peerDeliveryLifecycle: true, peerMessageVisibility: true },
    peerDelivery: { messageId: requestId, state: 'pending' } });
  r.request = async () => ({ status: 'ready' });
  r.sendPeer = async () => ({ status: 'submitted', transport: 'claude-peer-inbox' });
  const started = Date.now(), sent = await r.sendMessage('peer', { requestId });
  assert.ok(Date.now() - started < 2000);
  assert.equal(sent.status, 'submitted'); assert.equal(sent.nativeDelivery, undefined); assert.equal(sent.detail, undefined);
});

test('the mailbox records a native hold as receiver_held and the sender sees it immediately', async t => {
  const store = await storeFixture(t);
  const mailbox = new SessionMailbox({ store, admissionWaitMs: 2000,
    deliverMessage: async message => ({ status: 'submitted', transport: 'claude-peer-inbox', messageId: message.id, deliveryConfirmed: false, nativeDelivery: hold(message.id) }) });
  const saved = await mailbox.send(record());
  assert.equal(saved.status, 'receiver_held'); assert.match(saved.detail, /暂存/);
  assert.equal(store.queueCount(recipient), 0, 'the transport submission is final and is never resent automatically');
});

test('native expiry turns a submitted Claude peer message into a final undelivered record', async t => {
  const store = await storeFixture(t);
  const mailbox = new SessionMailbox({ store, deliverMessage: async message => ({ status: 'submitted', transport: 'claude-peer-inbox', messageId: message.id }) });
  const saved = await mailbox.send(record()); assert.equal(saved.status, 'submitted');
  // Old wrappers expose only the latest outcome; that is enough for one message.
  assert.deepEqual(store.observePeerDeliveries(recipient, { peerDelivery: expired(saved.id) }), [saved.id]);
  const message = store.getMessage(saved.id);
  assert.equal(message.status, 'undelivered'); assert.equal(message.nativeDelivery.outcome, 'expired');
  assert.match(message.detail, /未送达.*过期.*权限类别不一致.*不会自动重发/);
  assert.deepEqual(store.observePeerDeliveries(recipient, { peerDelivery: expired(saved.id) }), [], 'repeated samples do not rewrite the record');
  assert.deepEqual(store.observePeerDeliveries(recipient, { peerDeliveries: [{ messageId: saved.id, state: 'received' }] }), []);
  assert.equal(store.getMessage(saved.id).status, 'undelivered', 'an undelivered result is final');
});

test('ledger sync clears a hold on release, ignores ordinary acceptance, other sessions and other transports', async t => {
  const store = await storeFixture(t);
  const mailbox = new SessionMailbox({ store, deliverMessage: async message => ({ status: 'submitted', transport: message.text === 'codex' ? 'codex-app-tools' : 'claude-peer-inbox',
    messageId: message.id, ...(message.text === 'held' ? { nativeDelivery: hold(message.id) } : {}), detail: message.text === 'plain' ? 'visibility note' : undefined }) });
  const held = await mailbox.send({ ...record(), text: 'held' }), plain = await mailbox.send({ ...record(), text: 'plain' });
  const other = await mailbox.send({ ...record({ ...recipient, id: randomUUID() }), text: 'other' });
  const codex = await mailbox.send({ ...record(), text: 'codex' });
  assert.equal(store.getMessage(held.id).status, 'receiver_held');
  assert.deepEqual(store.observePeerDeliveries(recipient, { peerDeliveries: [
    { messageId: plain.id, state: 'received' }, expired(other.id), expired(codex.id), { messageId: held.id, state: 'released' },
  ] }), [held.id]);
  assert.equal(store.getMessage(held.id).status, 'submitted'); assert.match(store.getMessage(held.id).detail, /放行/);
  assert.equal(store.getMessage(plain.id).detail, 'visibility note');
  assert.equal(store.getMessage(other.id).status, 'submitted'); assert.equal(store.getMessage(codex.id).status, 'submitted');
  assert.deepEqual(store.observePeerDeliveries(recipient, { peerDeliveries: [{ messageId: held.id, state: 'received' }] }), [held.id]);
  assert.equal(store.getMessage(held.id).detail, null);
  assert.ok(store.db.prepare("SELECT 1 FROM events WHERE type='peer_delivery_observed'").get());
  assert.equal(sessionKey(recipient), `local:claude:${recipient.id}`);
});

test('every native hold cause and drop outcome has a specific explanation', () => {
  for (const cause of ['explicit-setting', 'managed-setting', 'repo-setting', 'invalid-setting', 'bypass-default', 'mode-unknown', 'mode-mismatch', 'no-mode-asserted']) {
    const outcome = peerDeliveryOutcome({ messageId: 'x', state: 'held', cause });
    assert.equal(outcome.status, 'receiver_held'); assert.doesNotMatch(outcome.detail, /跨会话接收策略暂存了这条消息/);
  }
  for (const reason of ['expired', 'refused', 'dropped', 'discarded'])
    assert.equal(peerDeliveryOutcome({ messageId: 'x', state: 'dropped', outcome: reason }).status, 'undelivered');
  assert.equal(peerDeliveryOutcome({ messageId: 'x', state: 'pending' }), null);
  assert.equal(peerDeliveryOutcome({ messageId: 'x', state: 'cancelled' }), null);
});
