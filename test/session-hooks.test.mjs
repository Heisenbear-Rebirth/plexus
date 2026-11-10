import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startServer } from '../src/http-server.mjs';
import { notifyViaManager, sessionHookViaManager } from '../src/client.mjs';
import { messageEnvelope } from '../src/address.mjs';
import { hookWarning, httpExample } from '../public/session-hook.mjs';

const target = { client: 'claude', id: '55555555-5555-4555-8555-555555555555', name: 'researcher', status: 'running', live: true };
const other = { client: 'claude', id: '66666666-6666-4666-8666-666666666666', name: 'author', status: 'running', live: true };

async function fixture(t) {
  const root = await mkdtemp(join(resolve('.'), '.http-test-hooks-')), cwd = join(root, 'work'); await mkdir(cwd);
  const sessions = [{ ...target, cwd }, { ...other, cwd }], payloads = [];
  const server = await startServer({ root, port: 0, startMonitoring: false,
    adapters: { claude: { find: async id => sessions.find(s => s.id === id) || null, list: async () => ({ sessions, warnings: [] }),
      send: async payload => { payloads.push(payload); return { status: 'submitted', transport: 'fixture' }; } } },
    runtimeFactory: () => ({ status: async () => ({ connected: true, activity: 'idle', sessionId: target.id, cwd, permissionMode: 'bypassPermissions', capabilities: {} }), close() {} }) });
  t.after(async () => { await server.close(); assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); });
  const config = await (await fetch(server.url + '/api/config')).json();
  const connection = JSON.parse(await readFile(join(root, '.plexus', 'connection.json'), 'utf8'));
  const ui = (body, token = config.csrfToken) => fetch(server.url + '/api/session-hook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-plexus-ui': token }, body: JSON.stringify(body) });
  const notify = (key, body) => fetch(server.url + '/api/hooks/notify', { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) }, body: JSON.stringify(body) });
  return { root, server, payloads, ui, notify, connection };
}

test('the management page opens one interface per session; its key wakes that session through the ordinary mailbox', async t => {
  const f = await fixture(t);
  assert.equal((await f.ui({ address: 'claude:' + target.id, action: 'create' }, 'wrong')).status, 403);
  assert.deepEqual(await (await f.ui({ address: 'claude:' + target.id, action: 'get' })).json(), { hook: null }, 'nothing exists until requested');
  const { hook } = await (await f.ui({ address: 'claude:' + target.id, action: 'create' })).json();
  assert.match(hook.key, /^hk_[0-9a-f]{16}\.[0-9a-f]{48}$/); assert.equal(hook.enabled, true);
  assert.match(hook.command, /bin\/plexus\.mjs" notify --hook hk_/); assert.equal(hook.http.url, f.server.url + '/api/hooks/notify');
  assert.equal((await (await f.ui({ address: 'claude:' + target.id, action: 'create' })).json()).hook.key, hook.key, 'repeating create keeps the key');
  const sent = await (await f.notify(hook.key, { text: '任务已完成：结果在 out/report.md', source: 'ssh-vps job 42' })).json();
  assert.equal(sent.status, 'submitted'); assert.equal(sent.to, 'claude:' + target.id);
  const [payload] = f.payloads;
  assert.equal(payload.targetId, target.id);
  assert.match(payload.text, /^发送方：外部程序「ssh-vps job 42」（会话接口 [0-9a-f]{16}）\n说明：.*没有可回复的会话地址/);
  assert.match(payload.text, /任务已完成：结果在 out\/report\.md$/);
  assert.equal(payload.readSenderPermissionClass, undefined, 'an external program never gets an invented permission class');
  const record = f.server.store.getMessage(sent.messageId);
  assert.equal(record.from.client, 'external'); assert.equal(record.source.kind, 'session-hook'); assert.equal(record.from.cwd, record.to.cwd);
  assert.equal((await (await f.ui({ address: 'claude:' + target.id, action: 'get' })).json()).hook.uses, 1);
  const monitoring = await (await fetch(f.server.url + '/api/monitoring')).text(), config = await (await fetch(f.server.url + '/api/config')).text();
  assert.equal(monitoring.includes(hook.key.split('.')[1]) || config.includes(hook.key.split('.')[1]), false, 'secrets stay out of shared views');
});

test('invalid, rotated, disabled and runaway keys are refused without reaching any session', async t => {
  const f = await fixture(t);
  const { hook } = await (await f.ui({ address: 'claude:' + target.id, action: 'create' })).json();
  assert.equal((await f.notify(null, { text: 'x' })).status, 401);
  assert.equal((await f.notify(hook.key.slice(0, -1) + (hook.key.endsWith('0') ? '1' : '0'), { text: 'x' })).status, 401);
  assert.equal((await f.notify(hook.key, { text: 'x', to: 'claude:' + other.id })).status, 400, 'the key alone decides the target');
  assert.equal((await f.notify(hook.key, { text: '   ' })).status, 400);
  const rotated = (await (await f.ui({ address: 'claude:' + target.id, action: 'rotate' })).json()).hook;
  assert.equal(rotated.id, hook.id); assert.notEqual(rotated.key, hook.key);
  assert.equal((await f.notify(hook.key, { text: 'old key' })).status, 401);
  await f.ui({ address: 'claude:' + target.id, action: 'disable' });
  assert.equal((await f.notify(rotated.key, { text: 'disabled' })).status, 403);
  await f.ui({ address: 'claude:' + target.id, action: 'enable' });
  for (let i = 0; i < 30; i++) assert.equal((await f.notify(rotated.key, { text: 'burst ' + i })).status, 200);
  assert.equal((await f.notify(rotated.key, { text: 'one too many' })).status, 429);
  assert.equal(f.payloads.length, 30);
  assert.ok(f.payloads.every(p => p.targetId === target.id));
});

test('an agent can fetch its own interface but cannot re-enable one the user disabled; the CLI path uses the key only', async t => {
  const f = await fixture(t);
  const self = await sessionHookViaManager(f.root, { from: { client: 'claude', id: other.id } });
  assert.equal(self.session.id, other.id); assert.equal(self.createdBy, 'agent');
  assert.equal((await sessionHookViaManager(f.root, { from: { client: 'claude', id: other.id } })).key, self.key, 'repeat calls return the same interface');
  const sent = await notifyViaManager(f.root, { key: self.key, text: 'CLI wake', source: 'cli' });
  assert.equal(sent.to, 'claude:' + other.id); assert.equal(f.payloads.at(-1).targetId, other.id);
  await f.ui({ address: 'claude:' + other.id, action: 'disable' });
  await assert.rejects(sessionHookViaManager(f.root, { from: { client: 'claude', id: other.id } }), /已被用户停用/);
  await assert.rejects(notifyViaManager(f.root, { key: '', text: 'x' }), /会话接口密钥/);
  const forged = await fetch(f.server.url + '/api/session-hook/self', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + self.key }, body: JSON.stringify({ from: { client: 'claude', id: target.id } }) });
  assert.equal(forged.status, 401, 'an interface key cannot mint interfaces for other sessions');
  assert.ok(f.connection.token);
});

test('external envelopes, HTTP examples and bypass warnings are explicit', () => {
  const text = messageEnvelope({ client: 'external', id: '0123456789abcdef', name: 'job\nrunner' }, 'done', 'message-1');
  assert.match(text, /^发送方：外部程序「job runner」（会话接口 0123456789abcdef）/); assert.doesNotMatch(text, /发送方地址/);
  const hook = { http: { url: 'http://127.0.0.1:1/api/hooks/notify', headers: { Authorization: 'Bearer hk_x' }, body: { text: 't', source: 's' } } };
  assert.equal(httpExample(hook), 'POST http://127.0.0.1:1/api/hooks/notify\nAuthorization: Bearer hk_x\nContent-Type: application/json\n\n{"text":"t","source":"s"}');
  const bypass = { client: 'claude', monitoring: { runtime: { permissionMode: 'bypassPermissions' } } };
  assert.match(hookWarning(bypass, { claudePeerCrossModeAccept: false }), /通信设置/);
  assert.equal(hookWarning(bypass, { claudePeerCrossModeAccept: true }), '');
  assert.equal(hookWarning({ client: 'codex' }, {}), '');
});
