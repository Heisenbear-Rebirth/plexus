import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { startServer } from '../src/http-server.mjs';
import { readWrapperDirectories, wrapperEnabledFor } from '../src/wrapper-directories.mjs';

test('management HTTP persists multiple roots and policies, limits mutations to the UI, and hides receipt secrets', async t => {
  const root = await mkdtemp(join(resolve('.'), '.http-test-')); const child = join(root, 'child'); await mkdir(child);
  const session = { client: 'codex', id: '11111111-1111-4111-8111-111111111111', name: 'fixture', cwd: child };
  const server = await startServer({ root, port: 0, startMonitoring: false, adapters: { codex: { find: async () => session, list: async () => ({ sessions: [session], warnings: [] }), send: async () => ({ status: 'submitted' }) } },
    runtimeFactory: () => ({ status: async () => ({ connected: true, activity: 'idle', model: 'fixture', capabilities: {} }), close() {} }) });
  t.after(async () => { await server.close(); assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); });
  const config = await (await fetch(server.url + '/api/config')).json();
  assert.equal(config.installationDirectory, root);
  const post = (path, body, token = config.csrfToken) => fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Coop-UI': token }, body: JSON.stringify(body) });
  assert.equal((await post('/api/directories', { path: child }, 'wrong')).status, 403);
  const directories = await (await post('/api/directories', { path: child })).json(); assert.equal(directories.directories.length, 2);
  assert.equal(directories.directories.find(d => d.id === directories.directory.id).claudeControlEnabled, false);
  const allowed = await (await post('/api/directories/claude-control', { id: directories.directory.id, enabled: true })).json();
  assert.equal(allowed.directories.find(d => d.id === directories.directory.id).claudeControlEnabled, true);
  const sessions = await (await post('/api/sessions', { directoryIds: directories.directories.map(d => d.id) })).json(); assert.equal(sessions.sessions.length, 1);
  const saved = await (await post('/api/policies', { address: 'codex:' + session.id, policy: { enabled: true, mode: 'observe', softPercent: 35, hardPercent: 60 } })).json();
  assert.equal(saved.policy.softPercent, 35); assert.equal(saved.policy.mode, 'observe');
  assert.equal((await post('/api/send', {})).status, 401);
  assert.equal((await post('/api/checkpoint', {})).status, 401);
  await assert.rejects(startServer({ root, port: 0, startMonitoring: false }), /已经运行/);
  server.store.createCycle({ session, state: 'writing_handoff', receiptHashes: { handoff: 'private-hash' } });
  server.store.saveSnapshot(session, { session, runtime: { activity: 'idle' } });
  const response = await fetch(server.url + '/api/monitoring');
  assert.equal((await response.text()).includes('private-hash'), false);
  assert.equal((await post('/api/directories/remove', { id: directories.directory.id })).status, 400);
  const connection = JSON.parse(await readFile(join(root, '.cooperation', 'connection.json'), 'utf8'));
  assert.equal(config.token, undefined); assert.ok(connection.token);
});

test('recursive project control is inherited by discovered Claude children and cannot be revoked during their maintenance', async t => {
  const root = await mkdtemp(join(resolve('.'), '.http-test-recursive-')), child = join(root, 'author'); await mkdir(child);
  const session = { client: 'claude', id: '22222222-2222-4222-8222-222222222222', name: 'author', cwd: child };
  const server = await startServer({ root, port: 0, startMonitoring: false, adapters: { claude: {
    find: async () => session, list: async () => ({ sessions: [session], warnings: [] }),
  } } });
  t.after(async () => { await server.close(); assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); });
  const config = await (await fetch(server.url + '/api/config')).json();
  const post = (path, body) => fetch(server.url + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-coop-ui': config.csrfToken }, body: JSON.stringify(body) });
  const parent = (await (await post('/api/directories', { path: root, recursive: true })).json()).directory;
  assert.equal((await post('/api/directories/claude-control', { id: parent.id, enabled: true })).status, 200);
  const sessions = await (await post('/api/sessions', { directoryIds: [parent.id] })).json();
  assert.equal(sessions.sessions[0].controlAccess.directoryEnabled, true);
  assert.equal(server.store.directories().length, 1, 'No separate child project is needed');
  const cycle = server.store.createCycle({ session, state: 'writing_handoff' });
  assert.equal((await post('/api/directories', { path: root, recursive: false })).status, 400);
  assert.equal((await post('/api/directories/claude-control', { id: parent.id, enabled: false })).status, 400);
  assert.equal(server.store.directories()[0].recursive, true);
  assert.equal(wrapperEnabledFor(await readWrapperDirectories(root), child), true);
  server.store.releaseCycle(cycle.id, { cancel: true, releaseMessages: false });
  assert.equal((await post('/api/directories', { path: root, recursive: false })).status, 200);
  assert.equal(wrapperEnabledFor(await readWrapperDirectories(root), child), false);
  assert.equal((await post('/api/directories', { path: root, recursive: true })).status, 200);
  assert.equal(wrapperEnabledFor(await readWrapperDirectories(root), child), true);
  assert.equal((await post('/api/directories/remove', { id: parent.id })).status, 200);
  assert.equal(wrapperEnabledFor(await readWrapperDirectories(root), child), false);
});
