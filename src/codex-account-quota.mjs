import { readCodexUsageLimits } from './adapters/codex.mjs';
import { publicCodexQuota } from './quota-state.mjs';

// One read per account per minute, independent of model turns or user input.
// Do not persist account IDs, reset-credit IDs or authentication information.
export class CodexAccountQuota {
  constructor({ context, read = readCodexUsageLimits, intervalMs = 60000, now = Date.now } = {}) {
    Object.assign(this, { context, reader: read, intervalMs, now }); this.nextRead = 0; this.value = null; this.closed = false;
  }
  read() {
    if (this.inFlight) return this.inFlight;
    if (this.closed || this.now() < this.nextRead) return Promise.resolve(this.value);
    this.nextRead = this.now() + this.intervalMs;
    this.inFlight = (async () => publicCodexQuota(await this.reader(await this.context?.())))()
      .catch(() => ({ source: 'codex-account-rate-limits', status: 'unknown', queriedAt: new Date(this.now()).toISOString(), windows: [] }))
      .then(value => { this.value = { ...value, nextCheckAt: new Date(this.nextRead).toISOString() }; return this.value; })
      .finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async close() { this.closed = true; await this.inFlight; }
}
