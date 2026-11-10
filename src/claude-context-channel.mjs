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

const INBOUND_RANK = { accept: 0, hold: 1, refuse: 2 };
// Mirror the native crossSessionInbound resolution: managed, flag and user
// settings decide in that order; project files may only make it stricter.
// Only this one key is returned, never the raw settings payload.
export function publicInboundPolicy(value) {
  const sources = new Map((Array.isArray(value?.sources) ? value.sources : []).map(s => [s?.source, s?.settings?.crossSessionInbound]));
  let decided, decidedBy = null;
  for (const source of ['policySettings', 'flagSettings', 'userSettings']) {
    if (sources.get(source) !== undefined) { decided = sources.get(source); decidedBy = source; break; }
  }
  if (decided !== undefined && !Object.hasOwn(INBOUND_RANK, decided)) return { value: 'hold', decidedBy: 'invalidSetting', flag: null };
  for (const source of ['localSettings', 'projectSettings']) {
    const candidate = sources.get(source);
    if (Object.hasOwn(INBOUND_RANK, candidate ?? '') && INBOUND_RANK[candidate] > INBOUND_RANK[decided ?? 'accept']) { decided = candidate; decidedBy = source; }
  }
  const flag = sources.get('flagSettings');
  return { value: decided ?? null, decidedBy, flag: Object.hasOwn(INBOUND_RANK, flag ?? '') ? flag : null };
}

// Responses to our own read-only requests must not leak into the IDE SDK's
// request map. Every other line is forwarded byte-for-byte, including CRLF.
export class NativeContextChannel {
  constructor(write, canQuery, { timeoutMs = 15000 } = {}) {
    this.write = write; this.canQuery = canQuery; this.timeoutMs = timeoutMs; this.requests = new Map();
    this.parts = []; this.size = 0; this.passthrough = false; this.active = false;
    this.namespace = randomUUID(); this.sequence = 0;
  }
  owns(id) {
    if (typeof id !== 'string') return false;
    for (const kind of ['context', 'interrupt', 'flags']) {
      const prefix = `plexus-${kind}-${this.namespace}-`;
      if (id.startsWith(prefix)) { const suffix = id.slice(prefix.length); return /^[1-9]\d*$/.test(suffix) && Number(suffix) <= this.sequence; }
    }
    return false;
  }
  async query() {
    return this.request('get_context_usage');
  }
  // Local 'summary' detail: last response usage plus estimates, no token-count
  // API calls. Used only to learn the window size while a turn is running.
  async capacity() {
    return this.request('get_context_usage', undefined, { fields: { detail: 'summary' }, gate: 'capacity' });
  }
  async interrupt() { return this.request('interrupt'); }
  async quota() { return this.request('get_usage'); }
  async selection() { return this.request('get_settings'); }
  async inboundPolicy() { return this.request('get_settings', publicInboundPolicy); }
  // Flag settings are session-scoped and may change while a turn runs, so this
  // does not take the idle query slot. The caller still writes at a line boundary.
  applyFlagSettings(settings) {
    if (this.requests.size >= 32) return Promise.reject(new Error('Too many pending native control requests.'));
    const requestId = `plexus-flags-${this.namespace}-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.requests.delete(requestId)) reject(Object.assign(new Error('Native flag settings request timed out; outcome unknown.'), { outcome: 'unknown' }));
      }, this.timeoutMs);
      this.requests.set(requestId, { resolve, reject, timer, expired: false, subtype: 'apply_flag_settings', transform: () => ({}) });
      try { this.write(Buffer.from(JSON.stringify({ type: 'control_request', request_id: requestId, request: { subtype: 'apply_flag_settings', settings } }) + '\n')); }
      catch (error) { clearTimeout(timer); this.requests.delete(requestId); reject(error); }
    });
  }
  async request(subtype, transform, { fields = {}, gate = subtype } = {}) {
    if (this.active || this.requests.size >= 32 || !this.canQuery(gate)) throw new Error('The session is not at an available input boundary.');
    this.active = true;
    const requestId = `plexus-${subtype === 'interrupt' ? 'interrupt' : 'context'}-${this.namespace}-${++this.sequence}`;
    this.currentRequestId = requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const request = this.requests.get(requestId);
        if (request) { request.expired = true; request.reject(Object.assign(new Error('Native control request timed out; outcome unknown.'), { outcome: 'unknown' })); }
        // A failed read cannot consume a permanent slot. The channel namespace
        // still identifies late replies after their promise has been removed.
        if (subtype !== 'interrupt') { this.requests.delete(requestId); this.active = false; this.currentRequestId = null; }
      }, this.timeoutMs);
      this.requests.set(requestId, { resolve, reject, timer, expired: false, subtype, transform });
      try { this.write(Buffer.from(JSON.stringify({ type: 'control_request', request_id: requestId,
        request: { subtype, ...fields, ...(subtype === 'get_usage' ? { skip_behaviors: true } : {}) } }) + '\n')); }
      catch (error) { clearTimeout(timer); this.requests.delete(requestId); this.active = false; reject(error); }
    });
  }
  push(chunk, forward) {
    // A long line arrives in many chunks; keep the pieces and join them once.
    let offset = 0;
    while (offset < chunk.length) {
      const end = chunk.indexOf(10, offset), part = chunk.subarray(offset, end < 0 ? chunk.length : end + 1);
      offset += part.length;
      if (this.passthrough && end < 0) { forward(part); return; }
      if (end < 0) {
        this.parts.push(part); this.size += part.length;
        if (this.size > 32 * 1024 * 1024) { for (const saved of this.parts) forward(saved); this.parts = []; this.size = 0; this.passthrough = true; }
        return;
      }
      const line = this.parts.length ? Buffer.concat([...this.parts, part], this.size + part.length) : part;
      this.parts = []; this.size = 0;
      let message;
      // Only replies to our own requests are withheld, and each carries a
      // plexus- request ID; every other line is forwarded without parsing.
      if (!this.passthrough && line.includes('control_response') && line.includes('plexus-')) {
        try { message = JSON.parse(line.toString('utf8')); } catch { /* forward unchanged */ }
      }
      const owned = message?.type === 'control_response' ? this.requests.get(message.response?.request_id) : null;
      if (owned) {
        clearTimeout(owned.timer); this.requests.delete(message.response.request_id);
        if (this.currentRequestId === message.response.request_id) { this.active = false; this.currentRequestId = null; }
        if (!owned.expired) {
          if (message.response.subtype === 'success') owned.resolve(owned.transform ? owned.transform(message.response.response)
            : owned.subtype === 'interrupt'
            ? { stillQueuedIds: Array.isArray(message.response.response?.still_queued) ? message.response.response.still_queued.filter(id => typeof id === 'string') : [] }
            : owned.subtype === 'get_usage' ? publicClaudeQuota(message.response.response)
            : owned.subtype === 'get_settings' ? publicClaudeSelection(message.response.response) : publicNativeContext(message.response.response));
          else owned.reject(Object.assign(new Error('Claude rejected the native control request.'), { outcome: 'failed' }));
        }
      } else if (!(message?.type === 'control_response' && this.owns(message.response?.request_id))) forward(line);
      this.passthrough = false;
    }
  }
  end(forward) { for (const part of this.parts) forward(part); this.parts = []; this.size = 0; }
  close() { for (const entry of this.requests.values()) { clearTimeout(entry.timer); if (!entry.expired) entry.reject(new Error('Claude process exited.')); } this.requests.clear(); this.active = false; }
}
