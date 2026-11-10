import test from 'node:test';
import assert from 'node:assert/strict';
import { CodexIpc } from '../src/runtime/codex-ipc.mjs';

function encode(value) {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function receiver() {
  const ipc = new CodexIpc(), broadcasts = [], errors = [];
  ipc.connected = true;
  ipc.socket = { writable: true, destroy() { this.writable = false; } };
  ipc.on('broadcast', frame => broadcasts.push(frame));
  ipc.on('disconnected', error => errors.push(error.code));
  return { ipc, broadcasts, errors };
}

test('a long native conversation snapshot above 32 MiB remains connected', () => {
  const h = receiver();
  // Native desktop snapshots include history; legitimate conversations exceed
  // the old limit even though Plexus only retains projected control state.
  const frame = encode({ type: 'broadcast', method: 'thread-stream-state-changed',
    params: { description: '研究记录', padding: 'x'.repeat(33 * 1024 * 1024) } });
  for (let offset = 0; offset < frame.length; offset += 64 * 1024) h.ipc.receive(frame.subarray(offset, offset + 64 * 1024));
  assert.equal(h.ipc.connected, true);
  assert.deepEqual(h.errors, []);
  assert.equal(h.broadcasts.length, 1);
  assert.equal(h.broadcasts[0].params.description, '研究记录');
  assert.equal(h.broadcasts[0].params.padding.length, 33 * 1024 * 1024);
  h.ipc.close();
});

test('fragmented headers, UTF-8 text, and adjacent frames are decoded exactly once', () => {
  const h = receiver();
  const values = ['第一条🐧', '第二条', 'third'].map(text => ({ type: 'broadcast', params: { text } }));
  const bytes = Buffer.concat(values.map(encode));
  for (let offset = 0; offset < bytes.length; offset += 3) h.ipc.receive(bytes.subarray(offset, offset + 3));
  assert.deepEqual(h.broadcasts, values); assert.deepEqual(h.errors, []);
  h.ipc.close();
});

test('a frame above the bounded 128 MiB limit is rejected from its header alone', () => {
  const h = receiver(), header = Buffer.alloc(4); header.writeUInt32LE(128 * 1024 * 1024 + 1);
  h.ipc.receive(header);
  assert.equal(h.ipc.connected, false); assert.equal(h.ipc.socket.writable, false);
  assert.deepEqual(h.errors, ['CODEX_IPC_FRAME_TOO_LARGE']); assert.deepEqual(h.broadcasts, []);
});

test('invalid JSON disconnects without publishing the following frame', () => {
  const h = receiver(), invalid = Buffer.from([1, 0, 0, 0, 123]);
  h.ipc.receive(Buffer.concat([invalid, encode({ type: 'broadcast', params: { text: 'must not arrive' } })]));
  assert.equal(h.ipc.connected, false);
  assert.deepEqual(h.errors, ['CODEX_IPC_INVALID_FRAME']); assert.deepEqual(h.broadcasts, []);
});
