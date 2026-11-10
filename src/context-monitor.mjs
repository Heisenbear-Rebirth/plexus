import { publicSession } from './address.mjs';
import { createRuntime } from './runtime/factory.mjs';
import { IncrementalContextReader } from './context-usage.mjs';
import { evaluatePolicy } from './context-policy.mjs';
import { sessionKey } from './management-store.mjs';
import { readAccessPolicy } from './access-policy.mjs';

export class ContextMonitor {
  constructor({ store, service, runtimeFactory, onUpdate = () => {}, onSessions = () => {} }) {
    this.store = store; this.service = service; this.onUpdate = onUpdate; this.onSessions = onSessions; this.clients = new Map(); this.readers = new Map();
    this.injectedRuntime = Boolean(runtimeFactory);
    this.runtimeFactory = runtimeFactory || service.runtimeFactory || (session => createRuntime(session, { opencode: service.adapters?.opencode }));
    this.inFlight = new Map(); this.discovered = []; this.discoveryAt = 0; this.discoverySignature = ''; this.closed = false;
    this.nextSampleAt = new Map(); this.nativeQueryAt = new Map(); this.missing = new Map();
  }
  runtime(session) { const key = sessionKey(session); if (!this.clients.has(key)) this.clients.set(key, this.runtimeFactory(session)); return this.clients.get(key); }
  async observeAll() {
    if (this.closed) return new Map();
    const directories = this.store.directories(), signature = JSON.stringify(directories);
    if (signature !== this.discoverySignature || Date.now() - this.discoveryAt >= 15000) {
      const result = await this.service.sessions({ directories });
      this.discovered = result.sessions;
      const listed = JSON.stringify(result.sessions.map(s => [s.address, s.name, s.cwd, s.status, s.live]));
      if (this.listed !== undefined && listed !== this.listed) this.onSessions();
      this.listed = listed;
      this.discoverySignature = signature; this.discoveryAt = Date.now();
      const retained = new Set([...this.discovered, ...this.store.policies().filter(p => p.enabled).map(p => p.session),
        ...this.store.activeCycles().map(c => c.session)].map(sessionKey));
      for (const [key, client] of this.clients) if (!retained.has(key)) {
        client.close(); this.clients.delete(key); this.readers.delete(key); this.nextSampleAt.delete(key); this.nativeQueryAt.delete(key);
      }
    }
    const result = new Map();
    // Pausing maintenance must not freeze its connection/settings display.
    // Retain paused sessions even when native discovery temporarily omits them.
    const paused = new Map(this.store.activeCycles().filter(c => ['needs_attention', 'user_intervened'].includes(c.state))
      .map(c => [sessionKey(c.session), c.session]));
    const sessions = [...new Map([...paused, ...this.discovered.map(s => [sessionKey(s), s])]).values()]; let index = 0;
    // Keep large directory sets from starting unbounded native operations.
    const worker = async () => {
      while (!this.closed && index < sessions.length) {
        const session = sessions[index++], key = sessionKey(session);
        const cycle = this.store.activeCycle(session);
        if (cycle && !['needs_attention', 'user_intervened'].includes(cycle.state)) continue;
        if (Date.now() < (this.nextSampleAt.get(key) || 0)) { const cached = this.store.getSnapshot(session); if (cached) result.set(key, cached); continue; }
        const sample = await this.sample(session); result.set(key, sample);
        this.nextSampleAt.set(key, Date.now() + (sample.runtime.connected ? 1800 : 10000));
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(4, sessions.length) }, worker)); return result;
  }
  sample(session, { native = false } = {}) {
    const key = sessionKey(session); if (this.inFlight.has(key)) return this.inFlight.get(key);
    // An enabled policy can outlive its session. Searching every client record
    // for it on each 2 s tick cost most of the idle file I/O; retry once a minute.
    const missing = this.missing.get(key);
    if (!native && missing && Date.now() < missing.until) return Promise.reject(missing.error);
    const work = this.readSample(session, native).finally(() => this.inFlight.delete(key)); this.inFlight.set(key, work); return work;
  }
  async readSample(session, native) {
    const access = await readAccessPolicy();
    const key = sessionKey(session);
    const metadata = session.cwd ? session : await this.service.adapters?.[session.client]?.find(session.id);
    if (metadata?.cwd) { access.assert(metadata.cwd); this.missing.delete(key); }
    else if (!this.injectedRuntime) {
      const error = new Error('无法在获准目录内确认该会话，停止原生观察。');
      this.missing.set(key, { error, until: Date.now() + 60000 }); throw error;
    }
    const adapter = this.runtime(session);
    let runtime, usage, error;
    try {
      runtime = await adapter.status();
      if (session.client === 'claude') {
        usage = runtime.usage;
        if (runtime.activity === 'idle' && (native || !usage || !(usage.contextWindowTokens > 0) || usage.historyChangedAfterMeasurement)
          && (native || Date.now() - (this.nativeQueryAt.get(key) || 0) >= 15000)) {
          this.nativeQueryAt.set(key, Date.now());
          try { usage = (await adapter.context()).usage; runtime = await adapter.status(); usage = runtime.usage || usage; }
          catch (e) { error = e.message; }
        }
      } else if (session.client === 'opencode') {
        usage = runtime.usage;
      } else if (session.client === 'codex') {
        if (!this.readers.has(key)) this.readers.set(key, new IncrementalContextReader(session.client, session.id));
        try { usage = await this.readers.get(key).read(); } catch (e) { error = e.message; }
      }
    } catch (e) { error = e.message; runtime = { connected: false, activity: 'offline', observedAt: new Date().toISOString(), capabilities: {} }; this.clients.delete(key); adapter.close(); }
    if (session.client === 'claude' && runtime.connected) {
      try { for (const id of this.store.observePeerDeliveries?.(session, runtime) || []) this.service.onMessage?.(id); }
      catch { /* Ledger sync retries on the next sample; observation must not stop. */ }
    }
    if (!usage && ['codex', 'claude'].includes(session.client)) {
      try {
        if (!this.readers.has(key)) this.readers.set(key, new IncrementalContextReader(session.client, session.id));
        usage = await this.readers.get(key).read();
      } catch { /* No native process or saved record is represented as unknown, never zero. */ }
    }
    const policy = this.store.getPolicy(session);
    const cycle = this.store.activeCycle(session), lastCycle = this.store.lastCycle(session);
    const decision = evaluatePolicy({ policy, runtime, usage, cycle, lastCycle });
    const sample = { session: { ...publicSession(session), hostId: session.hostId || 'local' }, runtime, usage: usage || null, decision,
      quotaRecovery: this.store.getSetting('quota-recovery:' + key), error: error || null, observedAt: new Date().toISOString() };
    // Pages are told about real changes only.
    if (this.store.saveSnapshot(session, sample) !== false) this.onUpdate(session);
    return sample;
  }
  close() { this.closed = true; for (const adapter of this.clients.values()) adapter.close(); this.clients.clear(); }
}
