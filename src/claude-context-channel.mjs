import { randomUUID } from 'node:crypto';
import { publicNativeContext } from './context-usage.mjs';
import { publicClaudeQuota } from './quota-state.mjs';
import { knownModel } from './model-identity.mjs';

export function publicClaudeSelection(value) {
  const applied = value?.applied;
  // get_settings also contains raw files and environment values. Keep only
  // the native process's applied model and effort; never return that payload.
  return { model: knownModel(applied?.model), ...(applied && Object.hasOwn(applied, 'effort')
    && (applied.effort === null || typeof applied.effort === 'string' && /^[a-z0-9_-]{1,32}$/i.test(applied.effort)
      || Number.isFinite(applied.effort)) ? { effort: applied.effort } : {}) };
}

// Responses to our own read-only requests must not leak into the IDE SDK's
// request map. Every other line is forwarded byte-for-byte, including CRLF.
export class NativeContextChannel {
  constructor(write, canQuery, { timeoutMs = 15000 } = {}) {
    this.write = write; this.canQuery = canQuery; this.timeoutMs = timeoutMs; this.requests = new Map();
    this.buffer = Buffer.alloc(0); this.passthrough = false; this.active = false;
    this.namespace = randomUUID(); this.sequence = 0;
  }
  owns(id) {
    if (typeof id !== 'string') return false;
    for (const kind of ['context', 'interrupt']) {
      const prefix = `cooperation-${kind}-${this.namespace}-`;
      if (id.startsWith(prefix)) { const suffix = id.slice(prefix.length); return /^[1-9]\d*$/.test(suffix) && Number(suffix) <= this.sequence; }
    }
    return false;
  }
  async query() {
    return this.request('get_context_usage');
  }
  async interrupt() { return this.request('interrupt'); }
  async quota() { return this.request('get_usage'); }
  async selection() { return this.request('get_settings'); }
  async request(subtype) {
    if (this.active || this.requests.size >= 32 || !this.canQuery(subtype)) throw new Error('The session is not at an available input boundary.');
    this.active = true;
    const requestId = `cooperation-${subtype === 'interrupt' ? 'interrupt' : 'context'}-${this.namespace}-${++this.sequence}`;
    this.currentRequestId = requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const request = this.requests.get(requestId);
        if (request) { request.expired = true; request.reject(Object.assign(new Error('Native control request timed out; outcome unknown.'), { outcome: 'unknown' })); }
        // A failed read cannot consume a permanent slot. The channel namespace
        // still identifies late replies after their promise has been removed.
        if (subtype !== 'interrupt') { this.requests.delete(requestId); this.active = false; this.currentRequestId = null; }
      }, this.timeoutMs);
      this.requests.set(requestId, { resolve, reject, timer, expired: false, subtype });
      try { this.write(Buffer.from(JSON.stringify({ type: 'control_request', request_id: requestId,
        request: { subtype, ...(subtype === 'get_usage' ? { skip_behaviors: true } : {}) } }) + '\n')); }
      catch (error) { clearTimeout(timer); this.requests.delete(requestId); this.active = false; reject(error); }
    });
  }
  push(chunk, forward) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length) {
      const end = this.buffer.indexOf(10);
      if (end < 0) {
        if (this.buffer.length > 32 * 1024 * 1024) { forward(this.buffer); this.buffer = Buffer.alloc(0); this.passthrough = true; }
        return;
      }
      const line = this.buffer.subarray(0, end + 1); this.buffer = this.buffer.subarray(end + 1);
      let message;
      if (!this.passthrough) { try { message = JSON.parse(line.toString('utf8')); } catch { /* forward unchanged */ } }
      const owned = message?.type === 'control_response' ? this.requests.get(message.response?.request_id) : null;
      if (owned) {
        clearTimeout(owned.timer); this.requests.delete(message.response.request_id);
        if (this.currentRequestId === message.response.request_id) { this.active = false; this.currentRequestId = null; }
        if (!owned.expired) {
          if (message.response.subtype === 'success') owned.resolve(owned.subtype === 'interrupt'
            ? { stillQueuedIds: Array.isArray(message.response.response?.still_queued) ? message.response.response.still_queued.filter(id => typeof id === 'string') : [] }
            : owned.subtype === 'get_usage' ? publicClaudeQuota(message.response.response)
            : owned.subtype === 'get_settings' ? publicClaudeSelection(message.response.response) : publicNativeContext(message.response.response));
          else owned.reject(Object.assign(new Error('Claude rejected the native control request.'), { outcome: 'failed' }));
        }
      } else if (!(message?.type === 'control_response' && this.owns(message.response?.request_id))) forward(line);
      this.passthrough = false;
    }
  }
  end(forward) { if (this.buffer.length) forward(this.buffer); this.buffer = Buffer.alloc(0); }
  close() { for (const entry of this.requests.values()) { clearTimeout(entry.timer); if (!entry.expired) entry.reject(new Error('Claude process exited.')); } this.requests.clear(); this.active = false; }
}
