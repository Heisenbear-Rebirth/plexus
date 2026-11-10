import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CodexAccountQuota } from '../src/codex-account-quota.mjs';
import { accountQuotaBlocked } from '../src/quota-state.mjs';
import { ContextMonitor } from '../src/context-monitor.mjs';
import { MaintenanceController } from '../src/maintenance-controller.mjs';
import { ManagementStore, sessionKey } from '../src/management-store.mjs';
import { PlexusService } from '../src/service.mjs';
import { quotaSettingKey } from '../src/quota-recovery.mjs';

test('account observer shares in-flight queries, polls without model calls and replaces failed/stale results with unknown', async () => {
  let at = Date.now(), reads = 0, fail = false, used = 100, release;
  const gate = new Promise(resolve => { release = resolve; });
  const observer = new CodexAccountQuota({ now: () => at, context: async () => ({ caller: 'fixture' }), read: async context => {
    assert.equal(context.caller, 'fixture'); reads++; await gate;
    if (fail) throw Error('private connection information');
    return { accountId: 'private-account', rateLimitResetCredits: { private: true }, rateLimits: { primary: { usedPercent: used } } };
  } });
  const first = observer.read(), second = observer.read(); assert.equal(first, second); release();
  const exhausted = await first; assert.equal(reads, 1); assert.equal(exhausted.status, 'exhausted');
  assert.doesNotMatch(JSON.stringify(exhausted), /private/); assert.equal(accountQuotaBlocked({ accountQuota: exhausted }), true);
  await observer.read(); assert.equal(reads, 1);
  at += 60001; used = 20; assert.equal((await observer.read()).status, 'available'); assert.equal(reads, 2);
  at += 60001; fail = true; assert.equal((await observer.read()).status, 'unknown'); assert.equal(reads, 3);
  assert.equal(accountQuotaBlocked({ accountQuota: { ...exhausted, queriedAt: new Date(Date.now() - 121000).toISOString() } }), false);
  await observer.close(); at += 60001; await observer.read(); assert.equal(reads, 3);
});

test('idle Codex sessions with exhausted account quota stay observable, hold FIFO and never fabricate an interrupted task', async t => {
  const root = await mkdtemp(join(resolve('.plexus'), 'account-quota-'));
  const store = await new ManagementStore(join(root, '.plexus')).init();
  const session = { client: 'codex', id: randomUUID(), cwd: root }, sender = { client: 'claude', id: randomUUID(), cwd: root };
  let used = 100, reads = 0, controls = 0, deliveries = 0;
  const observer = new CodexAccountQuota({ read: async () => { reads++; return { rateLimits: { primary: { usedPercent: used } } }; } });
  const runtimeFactory = target => ({ status: async () => ({ client: 'codex', sessionId: target.id, cwd: root, connected: true,
    activity: 'idle', latestTurn: { id: 'already-completed', status: 'completed' }, accountQuota: await observer.read(),
    capabilities: { automaticMaintenance: true, readActivity: true, sendControl: true, compact: true, observeCompletion: true } }),
    sendControl: async () => { controls++; throw Error('Completed task must not be resumed'); },
    compact: async () => { controls++; throw Error('Exhausted account must not be compacted'); }, close() {} });
  const service = new PlexusService({ root, store, runtimeFactory, adapters: {
    codex: { find: async () => session, list: async () => ({ sessions: [session] }), send: async () => { deliveries++; return { status: 'submitted' }; } },
    claude: { find: async () => sender, list: async () => ({ sessions: [] }) },
  } });
  service.codexQuota = observer;
  store.saveDirectory({ id: randomUUID(), path: root, normalized: root.toLowerCase(), enabled: true });
  store.savePolicy(session, { enabled: true, mode: 'automatic' });
  const monitor = new ContextMonitor({ store, service, runtimeFactory });
  monitor.readers.set(sessionKey(session), { read: async () => ({ usedTokens: 80, contextWindowTokens: 100 }) });
  const controller = new MaintenanceController({ root, store, service, monitor });
  t.after(async () => { await controller.close(); await service.mailbox.close(); await observer.close(); store.close(); assert.ok(root.startsWith(resolve('.plexus') + sep)); await rm(root, { recursive: true, force: true }); });
  await controller.tick();
  const sample = store.getSnapshot(session); assert.equal(sample.runtime.activity, 'idle'); assert.equal(sample.decision.action, 'wait_quota');
  assert.equal(sample.runtime.quota, undefined); assert.equal(store.getSetting(quotaSettingKey(session)), null);
  assert.equal(store.activeCycle(session), null); assert.equal(controls, 0);
  const queued = await service.send({ from: sender, to: 'codex:' + session.id, message: 'queued for later' });
  assert.equal(queued.status, 'queued'); assert.equal(deliveries, 0); assert.equal(reads, 1);
  // Even a stale idle snapshot cannot bypass the final account check.
  store.saveSnapshot(session, { session, runtime: { activity: 'idle', connected: true } });
  await service.mailbox.flush(); assert.equal(deliveries, 0);
  assert.equal(store.getSnapshot(session).runtime.accountQuota.status, 'exhausted');
  used = 5; observer.nextRead = 0; await monitor.sample(session); await service.mailbox.flush();
  assert.equal(deliveries, 1); assert.equal(controls, 0); assert.equal(store.getSetting(quotaSettingKey(session)), null);
});
