import { sessionKey } from './management-store.mjs';

export class SessionMailbox {
  constructor({ store, deliverMessage, deliverResume, reconcileMessage, onMessage = () => {}, admissionWaitMs = 5000, reconciliationIntervalMs = 15000 }) {
    this.store = store; this.deliverMessage = deliverMessage; this.deliverResume = deliverResume; this.onMessage = onMessage;
    this.running = new Map(); this.closed = false; this.backoff = new Map();
    this.reconcileMessage = reconcileMessage; this.nextReconciliation = new Map();
    this.admissionWaitMs = admissionWaitMs; this.reconciliationIntervalMs = reconciliationIntervalMs;
  }
  async send(record) {
    const saved = this.store.admit(record); this.onMessage(saved.id);
    const key = sessionKey(record.to);
    if (!this.store.mailbox(key).locked_cycle) {
      let timer;
      try { await Promise.race([this.drain(key), new Promise(resolve => { timer = setTimeout(resolve, this.admissionWaitMs); })]); }
      finally { clearTimeout(timer); }
    }
    const current = this.store.getMessage(saved.id);
    return current.status === 'pending' ? { ...current, detail: '消息正在投递，结果会自动更新；无需重复发送。' } : current;
  }
  drain(key) {
    if (this.closed) return Promise.resolve();
    if (this.running.has(key)) return this.running.get(key);
    const task = this.dispatch(key).finally(() => this.running.delete(key));
    this.running.set(key, task); return task;
  }
  async dispatch(key) {
    await this.reconcile(key);
    while (!this.closed) {
      const item = this.store.claimNext(key); if (!item) return;
      let result;
      try {
        result = item.kind === 'message' ? await this.deliverMessage(this.store.getMessage(item.messageId)) : await this.deliverResume(item);
        if (item.kind === 'message' && result?.status === 'deferred' && result.notSubmitted === true) {
          this.store.deferOutbox(item.id, result); this.onMessage(item.messageId);
          // Retry after 2, 4, 8, then every 16 s, or at once when the receiver's observed state changes.
          const delay = Math.min((this.backoff.get(key)?.delay || 1000) * 2, 16000);
          this.backoff.set(key, { delay, until: Date.now() + delay, readiness: this.readiness(key) }); return;
        }
        if (!['submitted', 'unknown', 'failed'].includes(result?.status)) result = { status: 'failed', error: '原生客户端未接受该操作。' };
      } catch (error) { result = { status: error.outcome === 'unknown' ? 'unknown' : 'failed', error: error.message }; }
      this.backoff.delete(key);
      if (result.status === 'unknown' && item.to?.client === 'codex' && this.reconcileMessage)
        result = { ...result, detail: '发送确认未返回，正在自动核对接收记录；核对成功后会继续队列。' };
      this.store.finishOutbox(item.id, result); this.onMessage(item.messageId || item.id);
      if (result.status === 'unknown') await this.reconcile(key, true);
    }
  }
  async reconcile(key, force = false) {
    if (!this.reconcileMessage || this.closed || !force && Date.now() < (this.nextReconciliation.get(key) || 0)) return;
    this.nextReconciliation.set(key, Date.now() + this.reconciliationIntervalMs);
    for (const record of this.store.unknownMessages(key)) {
      if (record.to.client !== 'codex') continue;
      let receipt;
      try { receipt = await this.reconcileMessage(record); } catch { continue; }
      if (!this.closed && receipt && this.store.confirmNativeDelivery(record.id, receipt)) this.onMessage(record.id);
    }
  }
  async flush() {
    const now = Date.now(), due = key => { const entry = this.backoff.get(key); return !entry || entry.until <= now || entry.readiness !== this.readiness(key); };
    await Promise.all(this.store.readyTargets().filter(due).map(key => this.drain(key)));
  }
  readiness(key) {
    const r = this.store.getSnapshot?.(key)?.runtime;
    return JSON.stringify([r?.connected, r?.activity, r?.selectionPending, Boolean(r?.quota), r?.quotaRestart?.pending, r?.instanceId, r?.accountQuota?.status]);
  }
  async close() { this.closed = true; await Promise.allSettled([...this.running.values()]); }
}
