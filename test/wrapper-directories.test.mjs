import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { WrapperDirectorySettings, readWrapperDirectories, wrapperEnabledFor } from '../src/wrapper-directories.mjs';

test('recursive control follows real directory boundaries, including Windows path normalization', () => {
  const config = { enabled: true, directoryScopes: [{ path: 'E:\\Work\\Project', enabled: true, recursive: true }] };
  for (const path of ['e:/work/project', 'E:/Work/Project/author', '\\\\?\\E:\\Work\\Project\\author\\draft']) assert.equal(wrapperEnabledFor(config, path), true);
  for (const path of ['E:/Work/Project-other', 'E:/Work/Other', 'E:/Work/Project/../Other']) assert.equal(wrapperEnabledFor(config, path), false);
  config.directoryScopes[0].recursive = false;
  assert.equal(wrapperEnabledFor(config, 'E:/Work/Project'), true);
  assert.equal(wrapperEnabledFor(config, 'E:/Work/Project/author'), false);
});

test('more specific project settings override inheritance without granting similarly named siblings', () => {
  const config = { enabled: true, directoryScopes: [
    { path: '/work', enabled: true, recursive: true },
    { path: '/work/private', enabled: false, recursive: true },
    { path: '/work/private/allowed', enabled: true, recursive: false },
  ] };
  assert.equal(wrapperEnabledFor(config, '/work/private'), false);
  assert.equal(wrapperEnabledFor(config, '/work/private/draft'), false);
  assert.equal(wrapperEnabledFor(config, '/work/private/allowed'), true);
  assert.equal(wrapperEnabledFor(config, '/work/private/allowed-more'), false);
  assert.equal(wrapperEnabledFor(config, '/work/public'), true);
  config.enabled = false; assert.equal(wrapperEnabledFor(config, '/work/private/allowed'), false);
});

test('legacy exact scopes stay exact until migrated; invalid new rules never fall back to compatibility paths', () => {
  const legacy = { enabled: true, directories: ['/work'] };
  assert.equal(wrapperEnabledFor(legacy, '/work'), true);
  assert.equal(wrapperEnabledFor(legacy, '/work/child'), false);
  assert.equal(wrapperEnabledFor({ ...legacy, directoryScopes: null }, '/work'), false);
  assert.equal(wrapperEnabledFor({ ...legacy, directoryScopes: [{ path: '/work', enabled: 'true', recursive: true }] }, '/work'), false);
});

async function fixture(t) {
  const base = resolve('.plexus'), root = await mkdtemp(join(base, 'wrapper-scope-'));
  const folder = join(root, '.plexus', 'claude-wrapper'); await mkdir(folder, { recursive: true });
  const file = join(folder, 'config.json'), settings = new WrapperDirectorySettings(root);
  t.after(async () => { assert.ok(root.startsWith(base + sep)); await rm(root, { recursive: true, force: true }); });
  return { root, file, settings };
}

test('existing recursive projects migrate once and retain unrelated wrapper configuration', async t => {
  const h = await fixture(t), parent = join(h.root, 'project'), child = join(parent, 'author');
  await writeFile(h.file, JSON.stringify({ enabled: true, directories: [parent], peerMessageVisibility: false, peerHistoryVisibility: true }));
  await h.settings.synchronize([{ path: parent, recursive: true }], [child]);
  let config = await readWrapperDirectories(h.root);
  assert.equal(wrapperEnabledFor(config, child), true); assert.ok(config.directories.includes(child));
  const raw = JSON.parse(await readFile(h.file, 'utf8')); assert.equal(raw.peerMessageVisibility, false); assert.equal(raw.peerHistoryVisibility, true);
  const original = await readFile(h.file, 'utf8'); await h.settings.synchronize([{ path: parent, recursive: true }], [child]);
  assert.equal(await readFile(h.file, 'utf8'), original);
  await h.settings.synchronize([{ path: parent, recursive: false }], [child]);
  config = await readWrapperDirectories(h.root); assert.equal(wrapperEnabledFor(config, child), false); assert.equal(config.directories.includes(child), false);
});

test('removing a redundant child project preserves inherited access for old wrappers and parent disable revokes it', async t => {
  const h = await fixture(t), parent = join(h.root, 'project'), child = join(parent, 'author');
  await h.settings.set(parent, true, { recursive: true, knownPaths: [child] });
  await h.settings.set(child, true);
  await h.settings.remove(child, [child]);
  let config = await readWrapperDirectories(h.root);
  assert.equal(config.directoryScopes.some(s => s.path === child), false);
  assert.equal(wrapperEnabledFor(config, child), true); assert.ok(config.directories.includes(child));
  await h.settings.set(parent, false, { recursive: true, knownPaths: [child] });
  config = await readWrapperDirectories(h.root);
  assert.equal(wrapperEnabledFor(config, child), false); assert.equal(config.directories.includes(child), false);
});

test('a refused scope change leaves persisted permissions unchanged', async t => {
  const h = await fixture(t), parent = join(h.root, 'project');
  await h.settings.set(parent, true, { recursive: true }); const before = await readFile(h.file, 'utf8');
  await assert.rejects(h.settings.synchronize([{ path: parent, recursive: false }], [], () => { throw Error('maintenance in progress'); }), /maintenance/);
  assert.equal(await readFile(h.file, 'utf8'), before);
  await h.settings.set(parent, false, { recursive: true });
  assert.equal(wrapperEnabledFor(await readWrapperDirectories(h.root), parent), false);
});
