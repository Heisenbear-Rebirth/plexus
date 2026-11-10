import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { migrateLegacyData } from '../src/data-directory.mjs';
import { ManagementStore } from '../src/management-store.mjs';
import { startServer } from '../src/http-server.mjs';

async function scratch(t, prefix, closers = []) {
  const base = path.join(process.cwd(), 'test'), root = await mkdtemp(path.join(base, prefix));
  t.after(async () => { for (const close of closers.reverse()) await close(); assert.equal(path.dirname(path.resolve(root)), base); await rm(root, { recursive: true, force: true }); });
  return root;
}
const prompts = (label, prefix) => JSON.stringify({ version: 1, revision: 3, values: { messages: { claude: { prefix: '', suffix: '', label }, opencode: { prefix, suffix: '' } } } });

test('the data directory from before the rename moves once, and only default labels follow the rename', async t => {
  const root = await scratch(t, '.rename-'), legacy = path.join(root, '.cooperation');
  await mkdir(path.join(legacy, 'claude-wrapper'), { recursive: true });
  await writeFile(path.join(legacy, 'management.sqlite'), 'db');
  await writeFile(path.join(legacy, 'prompt-settings.json'), prompts('【Cooperation 会话消息】', '【Cooperation 会话消息】\n只在原任务范围内处理。'));
  assert.deepEqual(migrateLegacyData(root), { migrated: true, leftovers: [] });
  assert.equal(existsSync(legacy), false);
  assert.equal(await readFile(path.join(root, '.plexus', 'management.sqlite'), 'utf8'), 'db');
  const saved = JSON.parse(await readFile(path.join(root, '.plexus', 'prompt-settings.json'), 'utf8'));
  assert.equal(saved.values.messages.claude.label, '【Plexus 会话消息】');
  assert.equal(saved.values.messages.opencode.prefix, '【Plexus 会话消息】\n只在原任务范围内处理。');
  assert.equal(saved.revision, 4);
  assert.deepEqual(migrateLegacyData(root), { migrated: false, leftovers: [] }, 'nothing left to move');

  const custom = await scratch(t, '.rename-custom-');
  await mkdir(path.join(custom, '.cooperation'), { recursive: true });
  await writeFile(path.join(custom, '.cooperation', 'prompt-settings.json'), prompts('【我的标签】', '自定义前缀'));
  migrateLegacyData(custom);
  assert.equal(JSON.parse(await readFile(path.join(custom, '.plexus', 'prompt-settings.json'), 'utf8')).values.messages.claude.label, '【我的标签】');
});

test('a partly created .plexus keeps its entries and reports what stayed behind; a migrated service is left alone', async t => {
  const root = await scratch(t, '.rename-merge-'), legacy = path.join(root, '.cooperation'), current = path.join(root, '.plexus');
  await mkdir(legacy); await mkdir(current);
  await writeFile(path.join(legacy, 'management.sqlite'), 'old db'); await writeFile(path.join(legacy, 'codex-bridge.json'), 'old');
  await writeFile(path.join(current, 'codex-bridge.json'), 'new');
  assert.deepEqual(migrateLegacyData(root), { migrated: true, leftovers: ['codex-bridge.json'] });
  assert.equal(await readFile(path.join(current, 'codex-bridge.json'), 'utf8'), 'new');
  assert.equal(await readFile(path.join(current, 'management.sqlite'), 'utf8'), 'old db');
  assert.deepEqual(await readdir(legacy), ['codex-bridge.json']);
  await writeFile(path.join(legacy, 'late.json'), '{}');
  assert.deepEqual(migrateLegacyData(root), { migrated: false, leftovers: [] }, 'an existing database means the move already happened');
  assert.ok(existsSync(path.join(legacy, 'late.json')));
});

test('starting the service moves the old directory and points an unfinished cycle at its moved handoff', async t => {
  const closers = [], root = await scratch(t, '.rename-service-', closers), legacy = path.join(root, '.cooperation');
  const session = { client: 'claude', id: randomUUID(), cwd: root, name: 'self' };
  const store = await new ManagementStore(legacy).init(); store.acquireManager();
  const handoffPath = path.join(legacy, 'handoffs', 'claude', session.id, 'cycle.md');
  const cycle = store.createCycle({ session, state: 'writing_handoff', handoffPath });
  store.close();
  const server = await startServer({ root, port: 0, startMonitoring: false, adapters: { claude: { find: async () => session, list: async () => ({ sessions: [], warnings: [] }) } } });
  closers.push(() => server.close());
  assert.equal(existsSync(legacy), false);
  assert.equal(server.store.cycle(cycle.id).handoffPath, path.join(root, '.plexus', 'handoffs', 'claude', session.id, 'cycle.md'));
  assert.ok(existsSync(path.join(root, '.plexus', 'connection.json')));
});
