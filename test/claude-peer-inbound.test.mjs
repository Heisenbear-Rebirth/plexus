import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { publicInboundPolicy } from '../src/claude-context-channel.mjs';
import { peerInboundSummary } from '../public/peer-settings.mjs';
import { startServer } from '../src/http-server.mjs';
import { WrapperDirectorySettings, readWrapperDirectories } from '../src/wrapper-directories.mjs';

const sources = entries => ({ sources: Object.entries(entries).map(([source, value]) => ({ source, settings: { crossSessionInbound: value, env: { SECRET: 'x' } } })) });

test('the read-back mirrors native crossSessionInbound precedence and returns no other settings', () => {
  assert.deepEqual(publicInboundPolicy(sources({ flagSettings: 'accept' })), { value: 'accept', decidedBy: 'flagSettings', flag: 'accept' });
  assert.deepEqual(publicInboundPolicy({}), { value: null, decidedBy: null, flag: null });
  // Managed settings win over the flag layer; user settings lose to it.
  assert.equal(publicInboundPolicy(sources({ policySettings: 'hold', flagSettings: 'accept' })).decidedBy, 'policySettings');
  assert.equal(publicInboundPolicy(sources({ userSettings: 'hold', flagSettings: 'accept' })).value, 'accept');
  // Project files can only tighten the decision.
  assert.deepEqual(publicInboundPolicy(sources({ flagSettings: 'accept', projectSettings: 'refuse' })), { value: 'refuse', decidedBy: 'projectSettings', flag: 'accept' });
  assert.equal(publicInboundPolicy(sources({ flagSettings: 'hold', localSettings: 'accept' })).value, 'hold');
  assert.equal(publicInboundPolicy(sources({ flagSettings: 'sometimes' })).decidedBy, 'invalidSetting');
  assert.doesNotMatch(JSON.stringify(publicInboundPolicy(sources({ flagSettings: 'accept' }))), /SECRET/);
});

test('the switch summary counts only verified sessions as active and names sessions that need a reopen', () => {
  const claude = (peerInbound, capabilities = { peerInboundControl: true }) => ({ client: 'claude', monitoring: { runtime: { connected: true, capabilities, peerInbound } } });
  const sessions = [
    claude({ mode: 'accept', state: 'applied', effective: 'accept', verifiedAt: 'now' }),
    claude({ mode: 'accept', state: 'applied', effective: null, verifiedAt: null }),
    claude({ mode: 'accept', state: 'applied', effective: 'hold', decidedBy: 'policySettings', verifiedAt: 'now' }),
    claude({ mode: 'default', state: 'failed' }),
    claude(undefined, {}),
    { client: 'claude', monitoring: { runtime: { connected: false } } },
    { client: 'codex', monitoring: { runtime: { connected: true } } },
  ];
  const on = peerInboundSummary(sessions, true);
  for (const part of ['已生效 1 个', '1 个正在应用', '1 个被托管策略', '1 个应用失败', '1 个需在任务结束后重开面板']) assert.ok(on.includes(part), on);
  assert.match(peerInboundSummary(sessions, false), /已关闭；3 个 Claude 会话正在恢复/, 'sessions still holding accept are restoring');
  assert.match(peerInboundSummary([claude({ mode: 'default', state: 'ready' })], false), /按原生规则暂存/);
});

test('the switch is off by default, keeps other wrapper settings, and changes only from the management page', async t => {
  const root = await mkdtemp(join(resolve('.'), '.http-test-peer-inbound-'));
  const folder = join(root, '.cooperation', 'claude-wrapper'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'config.json'), JSON.stringify({ enabled: true, directories: [root], directoryScopes: [{ path: root, enabled: true, recursive: true }], peerMessageVisibility: false }));
  const server = await startServer({ root, port: 0, startMonitoring: false, adapters: { claude: { find: async () => null, list: async () => ({ sessions: [], warnings: [] }) } } });
  t.after(async () => { await server.close(); assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); });
  const config = await (await fetch(server.url + '/api/config')).json();
  assert.equal(config.claudePeerCrossModeAccept, false);
  const before = JSON.parse(await readFile(join(folder, 'config.json'), 'utf8'));
  const post = (body, token = config.csrfToken) => fetch(server.url + '/api/claude-peer-inbound', { method: 'POST', headers: { 'content-type': 'application/json', 'x-coop-ui': token }, body: JSON.stringify(body) });
  assert.equal((await post({ enabled: true }, 'wrong')).status, 403);
  assert.equal((await post({ enabled: 'yes' })).status, 400);
  assert.deepEqual(await (await post({ enabled: true })).json(), { claudePeerCrossModeAccept: true });
  const saved = JSON.parse(await readFile(join(folder, 'config.json'), 'utf8'));
  assert.deepEqual(saved, { ...before, peerCrossModeAccept: true }, 'only the switch changes');
  assert.equal((await (await fetch(server.url + '/api/config')).json()).claudePeerCrossModeAccept, true);
  await post({ enabled: false });
  assert.equal((await readWrapperDirectories(root)).peerCrossModeAccept, false);
  assert.ok(server.store.db.prepare("SELECT 1 FROM events WHERE type='claude_peer_inbound'").get());
});

test('every browser module imported by the management page is served by the static whitelist', async () => {
  const server = await readFile(resolve('src/http-server.mjs'), 'utf8'), seen = new Set(), pending = ['app.js'];
  while (pending.length) {
    const file = pending.pop(); if (seen.has(file)) continue; seen.add(file);
    const source = await readFile(resolve('public', file), 'utf8');
    for (const [, name] of source.matchAll(/from '\.\/([\w-]+\.m?js)'/g)) pending.push(name);
  }
  for (const file of seen) assert.ok(server.includes(`'/${file}': ['${file}', 'text/javascript']`), `${file} must be whitelisted`);
  assert.ok(seen.has('peer-settings.mjs'));
});

test('a fresh installation without wrapper configuration can still record the switch', async t => {
  const root = await mkdtemp(join(resolve('.'), '.http-test-peer-inbound-fresh-'));
  t.after(async () => { assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); });
  assert.equal((await readWrapperDirectories(root)).peerCrossModeAccept, undefined);
  await new WrapperDirectorySettings(root).setPeerCrossModeAccept(true);
  assert.equal((await readWrapperDirectories(root)).peerCrossModeAccept, true);
});
