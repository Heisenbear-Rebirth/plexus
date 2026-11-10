import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

const versions = { initialize: 0, 'thread-owner-discovery': 1, 'thread-follower-start-turn': 2,
  'thread-follower-compact-thread': 1, 'thread-follower-interrupt-turn': 4 };
const fail = (code, outcome = 'not_submitted') => Object.assign(new Error(code), { code, outcome, retryable: false });
// Desktop snapshots contain conversation history, including long research runs.
// Keep a finite limit while accepting these legitimate, larger native frames.
const MAX_FRAME_BYTES = 128 * 1024 * 1024;

// Normal independent desktop peer. Never claims ownership or another client's ID.
export class CodexIpc extends EventEmitter {
  constructor({ endpoint = '\\\\.\\pipe\\codex-ipc', timeoutMs = 5000 } = {}) {
    super(); this.endpoint = endpoint; this.timeoutMs = timeoutMs; this.clientId = 'initializing-client';
    this.header = Buffer.alloc(4); this.headerBytes = 0; this.frame = null; this.frameBytes = 0;
    this.pending = new Map(); this.connected = false;
  }
  async connect() {
    if (this.connected) return this;
    this.socket = createConnection(this.endpoint);
    this.socket.on('data', bytes => this.receive(bytes));
    this.socket.on('error', () => this.disconnect(fail('CODEX_IPC_OFFLINE', 'unknown')));
    this.socket.on('close', () => this.disconnect(fail('CODEX_IPC_CLOSED', 'unknown')));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.destroy(); reject(fail('CODEX_IPC_CONNECT_TIMEOUT')); }, this.timeoutMs);
      this.socket.once('connect', () => { clearTimeout(timer); this.connected = true; resolve(); });
      this.socket.once('error', error => { clearTimeout(timer); reject(fail(`CODEX_IPC_OFFLINE:${error.code || 'UNKNOWN'}`)); });
    });
    try {
      const result = await this.request('initialize', { clientType: 'cooperation-runtime' });
      if (typeof result.result?.clientId !== 'string') throw fail('CODEX_IPC_REGISTRATION_FAILED');
      this.clientId = result.result.clientId; return this;
    } catch (error) { this.close(); throw error; }
  }
  send(frame) {
    if (!this.connected || !this.socket?.writable) throw fail('CODEX_IPC_OFFLINE');
    const body = Buffer.from(JSON.stringify(frame));
    const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    this.socket.write(Buffer.concat([header, body]));
  }
  request(method, params, targetClientId, timeoutMs = this.timeoutMs) {
    if (!(method in versions)) return Promise.reject(fail('CODEX_METHOD_NOT_ALLOWED'));
    if (method === 'thread-follower-interrupt-turn' && !params.expectedTurnId) return Promise.reject(fail('CODEX_EXPECTED_TURN_REQUIRED'));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(fail('CODEX_IPC_TIMEOUT', 'unknown')); }, timeoutMs + 500);
      this.pending.set(requestId, { resolve, reject, timer });
      try { this.send({ type: 'request', requestId, sourceClientId: this.clientId, version: versions[method], method, params,
        ...(targetClientId ? { targetClientId } : {}), timeoutMs }); }
      catch (error) { clearTimeout(timer); this.pending.delete(requestId); reject(error); }
    });
  }
  following(conversationId, ownerId, following = true) {
    this.send({ type: 'broadcast', method: 'thread-stream-following-changed', version: 1, sourceClientId: this.clientId,
      targetClientIds: [ownerId], params: { hostId: 'local', conversationId, following } });
  }
  receive(bytes) {
    let offset = 0;
    while (offset < bytes.length && this.connected) {
      if (!this.frame) {
        const count = Math.min(4 - this.headerBytes, bytes.length - offset);
        bytes.copy(this.header, this.headerBytes, offset, offset + count); this.headerBytes += count; offset += count;
        if (this.headerBytes < 4) return;
        const size = this.header.readUInt32LE(); this.headerBytes = 0;
        if (size > MAX_FRAME_BYTES) { this.disconnect(fail('CODEX_IPC_FRAME_TOO_LARGE', 'unknown')); this.socket.destroy(); return; }
        this.frame = Buffer.allocUnsafe(size); this.frameBytes = 0;
      }
      // Copy each chunk once instead of repeatedly copying the growing history.
      const count = Math.min(this.frame.length - this.frameBytes, bytes.length - offset);
      bytes.copy(this.frame, this.frameBytes, offset, offset + count); this.frameBytes += count; offset += count;
      if (this.frameBytes < this.frame.length) return;
      let frame;
      try { frame = JSON.parse(this.frame.toString('utf8')); }
      catch { this.disconnect(fail('CODEX_IPC_INVALID_FRAME', 'unknown')); this.socket.destroy(); return; }
      this.frame = null; this.frameBytes = 0;
      if (frame.type === 'client-discovery-request') {
        this.send({ type: 'client-discovery-response', requestId: frame.requestId, response: { canHandle: false } });
      } else if (frame.type === 'response') {
        const p = this.pending.get(frame.requestId); if (!p) continue;
        clearTimeout(p.timer); this.pending.delete(frame.requestId); p.resolve(frame);
      } else if (frame.type === 'broadcast') this.emit('broadcast', frame);
    }
  }
  disconnect(error) {
    const wasConnected = this.connected; this.connected = false;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.headerBytes = 0; this.frame = null; this.frameBytes = 0;
    if (wasConnected) this.emit('disconnected', error);
  }
  close() { this.disconnect(fail('CODEX_IPC_CLOSED', 'unknown')); this.socket?.destroy(); }
}
