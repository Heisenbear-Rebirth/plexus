import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ContextMonitor } from '../src/context-monitor.mjs';
import { ManagementStore, sessionKey } from '../src/management-store.mjs';

for (const pausedState of ['needs_attention', 'user_intervened']) test(`monitor refreshes ${pausedState} sessions without resuming maintenance, even when discovery omits them`, async t => {
  const root = await mkdtemp(join(resolve('.plexus'), 'monitor-paused-'));
  const store = await new ManagementStore(join(root, '.plexus')).init();
  const session = { client: 'opencode', id: randomUUID(), cwd: root };
  const cycle = store.createCycle({ session, state: pausedState, previousState: 'restoring', reason: '等待人工检查' });
  store.saveSnapshot(session, { session, runtime: { connected: false, activity: 'offline' } });
  let connected = true, reads = 0;
  const monitor = new ContextMonitor({ store, service: { sessions: async () => ({ sessions: [] }) },
    runtimeFactory: () => ({ status: async () => { reads++; return { connected, activity: connected ? 'idle' : 'offline', usage: {} }; },
      sendControl() { assert.fail('Paused maintenance must not submit control messages'); }, close() {} }) });
  t.after(async () => { monitor.close(); store.close(); assert.ok(root.startsWith(resolve('.plexus') + sep)); await rm(root, { recursive: true, force: true }); });
  await monitor.observeAll();
  assert.equal(store.getSnapshot(session).runtime.connected, true);
  await monitor.observeAll(); assert.equal(reads, 1, 'paused sessions share observation throttling');
  connected = false; monitor.nextSampleAt.set(sessionKey(session), 0); await monitor.observeAll();
  assert.equal(store.getSnapshot(session).runtime.connected, false); assert.equal(reads, 2);
  assert.deepEqual(store.cycle(cycle.id), cycle);
  assert.equal(store.mailbox(sessionKey(session)).locked_cycle, cycle.id);
});
