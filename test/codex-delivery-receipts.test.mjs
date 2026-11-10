import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { messageEnvelope } from '../src/address.mjs';
import { codexDeliveryReceipt, CodexDeliveryReceipts } from '../src/codex-delivery-receipts.mjs';
import { ManagementStore, sessionKey } from '../src/management-store.mjs';
import { SessionMailbox } from '../src/session-mailbox.mjs';

async function fixture(t) {
  const base = resolve('.plexus'), root = await mkdtemp(join(base, 'delivery-receipt-'));
  const store = await new ManagementStore(root).init();
  const from = { client: 'claude', id: randomUUID(), name: 'sender', cwd: root }, to = { client: 'codex', id: randomUUID(), name: 'receiver', cwd: root };
  const record = text => ({ id: randomUUID(), createdAt: '2026-10-18T08:30:00.000Z', from, to, text });
  const filename = join(root, 'native.jsonl');
  await writeFile(filename, JSON.stringify({ type: 'session_meta', payload: { id: to.id } }) + '\n');
  const reader = new CodexDeliveryReceipts({ locate: async () => filename });
  const rendered = m => messageEnvelope(m.from, m.text, m.id);
  const row = (m, text = rendered(m), time = '2026-10-18T08:31:00.000Z') => ({ timestamp: time, type: 'response_item',
    payload: { type: 'function_call_output', namespace: 'codex_app', name: 'send_message_to_thread',
      output: `<codex_delegation>\n  <source_thread_id>${from.id}</source_thread_id>\n  <input>${text}</input>\n</codex_delegation>` } });
  const receive = m => appendFile(filename, JSON.stringify(row(m)) + '\n');
  t.after(async () => { store.close(); assert.ok(root.startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  return { root, store, from, to, record, filename, reader, rendered, row, receive };
}

test('native delivery proof requires the exact payload, target session, and a timestamp after admission', async t => {
  const h = await fixture(t), m = h.record('完整报告：已完成');
  await appendFile(h.filename, JSON.stringify(h.row(m, h.rendered(m), '2026-10-18T08:29:00.000Z')) + '\n');
  assert.equal(await h.reader.find(m, h.rendered(m)), null);
  await appendFile(h.filename, JSON.stringify(h.row(m, h.rendered(m) + 'changed')) + '\n');
  assert.equal(await h.reader.find(m, h.rendered(m)), null);
  await h.receive(m);
  const proof = await h.reader.find(m, h.rendered(m));
  assert.equal(proof.messageId, m.id); assert.equal(proof.sessionId, h.to.id);
  assert.equal(proof.receivedAt, '2026-10-18T08:31:00.000Z');
  assert.equal(JSON.stringify(proof).includes('完整报告'), false);
  await writeFile(h.filename, JSON.stringify({ type: 'session_meta', payload: { id: randomUUID() } }) + '\n' + JSON.stringify(h.row(m)) + '\n');
  // A new observer must not trust even an otherwise exact receipt in another thread.
  const other = new CodexDeliveryReceipts({ locate: async () => h.filename });
  assert.equal(await other.find(m, h.rendered(m)), null);
});

test('quoted IDs and envelopes in ordinary tool output, assistant text, or another namespace are not receipts', async t => {
  const h = await fixture(t), m = h.record('report'), native = h.row(m);
  for (const row of [
    { ...native, type: 'event_msg' },
    { ...native, payload: { ...native.payload, namespace: 'shell' } },
    { ...native, payload: { ...native.payload, name: 'read_thread' } },
    { ...native, payload: { type: 'message', role: 'assistant', content: [{ text: native.payload.output }] } },
    { ...native, payload: { ...native.payload, output: 'Quoted evidence: ' + native.payload.output } },
  ]) assert.equal(codexDeliveryReceipt(row), null);
});

test('a receipt split across reads, including UTF-8 bytes, is recognized only after the full row arrives', async t => {
  const h = await fixture(t), m = h.record('中文输入');
  const data = Buffer.from(JSON.stringify(h.row(m)) + '\n');
  const split = data.indexOf(Buffer.from('中文')) + 1;
  await appendFile(h.filename, data.subarray(0, split));
  assert.equal(await h.reader.find(m, h.rendered(m)), null);
  await appendFile(h.filename, data.subarray(split));
  assert.equal((await h.reader.find(m, h.rendered(m))).messageId, m.id);
});

test('a lost acknowledgement is reconciled automatically and later messages continue without resending the first', async t => {
  const h = await fixture(t), first = h.record('first'), second = h.record('second'), sent = [];
  const mailbox = new SessionMailbox({ store: h.store, reconciliationIntervalMs: 0,
    reconcileMessage: m => h.reader.find(m, h.rendered(m)),
    deliverMessage: async m => { sent.push(m.id); return { status: m.id === first.id ? 'unknown' : 'submitted' }; } });
  t.after(() => mailbox.close());
  assert.equal((await mailbox.send(first)).status, 'unknown');
  assert.equal((await mailbox.send(second)).status, 'queued');
  await mailbox.flush(); assert.deepEqual(sent, [first.id], 'Absence of a receipt must never authorize a retry');
  await h.receive(first);
  await mailbox.flush();
  assert.deepEqual(sent, [first.id, second.id]);
  assert.equal(h.store.getMessage(first.id).status, 'submitted');
  assert.equal(h.store.getMessage(first.id).deliveryReceipt.kind, 'codex-native-receipt');
  assert.equal(h.store.mailbox(sessionKey(h.to)).blocked, 0);
  assert.equal(h.store.queueCount(h.to), 0);
});

test('a late receipt is reconciled even with no later message, while restart consent still gates the next send', async t => {
  const h = await fixture(t), first = h.record('first'), sent = [];
  const mailbox = new SessionMailbox({ store: h.store, reconciliationIntervalMs: 0,
    reconcileMessage: m => h.reader.find(m, h.rendered(m)), deliverMessage: async m => { sent.push(m.id); return { status: 'unknown' }; } });
  t.after(() => mailbox.close());
  await mailbox.send(first); await h.receive(first); await mailbox.flush();
  assert.equal(h.store.getMessage(first.id).status, 'submitted'); assert.deepEqual(sent, [first.id]);
  const next = h.record('next'); h.store.admit(next);
  h.store.restartConfirmation = { canDrain: () => false };
  await mailbox.flush(); assert.deepEqual(sent, [first.id]); assert.equal(h.store.getMessage(next.id).status, 'queued');
});

test('slow acknowledgement returns durable pending status promptly and finishes in the background once', async t => {
  const h = await fixture(t); let complete, calls = 0;
  const mailbox = new SessionMailbox({ store: h.store, admissionWaitMs: 10,
    deliverMessage: () => { calls++; return new Promise(resolve => { complete = resolve; }); } });
  t.after(() => mailbox.close());
  const m = h.record('slow delivery'), result = await mailbox.send(m);
  assert.equal(result.status, 'pending'); assert.match(result.detail, /无需重复发送/);
  complete({ status: 'submitted' }); await mailbox.drain(sessionKey(h.to));
  assert.equal(h.store.getMessage(m.id).status, 'submitted'); assert.equal(calls, 1);
});
