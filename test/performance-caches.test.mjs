import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, rm, stat, utimes, writeFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { listClaudeSessions } from '../src/adapters/claude.mjs';
import { IncrementalContextReader } from '../src/context-usage.mjs';
import { persistedMap } from '../src/persisted-cache.mjs';
import { PlexusService } from '../src/service.mjs';

async function scratch(t, prefix) {
  const base = path.join(process.cwd(), 'test'), root = await mkdtemp(path.join(base, prefix));
  t.after(async () => { assert.equal(path.dirname(path.resolve(root)), base); await rm(root, { recursive: true, force: true }); });
  return root;
}
const line = value => JSON.stringify(value) + '\n';

test('discovery reads only appended transcript bytes and rescans a truncated file', async t => {
  const root = await scratch(t, '.claude-fixture-'), cwd = path.join(root, 'project'), id = randomUUID();
  await mkdir(path.join(root, 'sessions'), { recursive: true });
  const folder = path.join(root, 'projects', path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-')); await mkdir(folder, { recursive: true });
  const file = path.join(folder, id + '.jsonl');
  await writeFile(file, line({ type: 'user', sessionId: id, cwd, message: { content: 'x'.repeat(100000) } }) + line({ type: 'custom-title', sessionId: id, customTitle: 'First' }));
  const list = async () => (await listClaudeSessions({ directory: cwd, configDir: root })).sessions[0];
  assert.equal((await list()).name, 'First');
  // Rewrite already-scanned bytes in place; only a rescan could observe this.
  const text = await readFile(file, 'utf8'), handle = await open(file, 'r+');
  await handle.write(Buffer.from('"customTitle":"Wrong"'), 0, 21, Buffer.byteLength(text.slice(0, text.indexOf('"customTitle":"First"'))));
  await handle.close();
  await appendFile(file, line({ type: 'ai-title', sessionId: id, aiTitle: 'Generated' }));
  const appended = await list();
  assert.equal(appended.name, 'First', 'the scanned prefix is not read again'); assert.equal(appended.cwd, cwd);
  await appendFile(file, '{"type":"custom-title","sessionId":"' + id + '","customTitle":"Half');
  assert.equal((await list()).name, 'First', 'an unterminated line waits for its newline');
  await appendFile(file, ' written"}\n');
  assert.equal((await list()).name, 'Half written');
  await writeFile(file, line({ type: 'user', sessionId: id, cwd }) + line({ type: 'custom-title', sessionId: id, customTitle: 'Rewritten' }));
  assert.equal((await list()).name, 'Rewritten', 'a shorter file is scanned from the start');
});

test('a persisted cache survives a restart and ignores a damaged file', async t => {
  const root = await scratch(t, '.cache-fixture-'), file = path.join(root, 'nested', 'cache.json');
  const first = persistedMap({ delayMs: 5 }); first.persistTo(file);
  first.map.set('a', { offset: 10 }); first.saveSoon();
  await new Promise(resolve => setTimeout(resolve, 80));
  const second = persistedMap(); second.persistTo(file); await second.load();
  assert.deepEqual(second.map.get('a'), { offset: 10 });
  await writeFile(file, '{ damaged');
  const third = persistedMap(); third.persistTo(file); await third.load();
  assert.equal(third.map.size, 0);
});

test('the Claude fallback reads only the transcript tail and matches the last response', async t => {
  const root = await scratch(t, '.claude-fixture-'), id = randomUUID(), file = path.join(root, id + '.jsonl');
  const assistant = (tokens, timestamp) => line({ type: 'assistant', sessionId: id, timestamp, message: { model: 'm', usage: { input_tokens: tokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 } } });
  const filler = line({ type: 'user', sessionId: id, message: { content: 'y'.repeat(1024 * 1024) } });
  await writeFile(file, assistant(1, 't0') + line({ type: 'system', subtype: 'compact_boundary', sessionId: id, timestamp: 'old-boundary' }) + filler.repeat(6) + assistant(42, 't1'));
  const reader = new IncrementalContextReader('claude', id); reader.filename = file;
  const result = await reader.read();
  assert.equal(result.usedTokens, 42); assert.equal(result.historyChangedAfterMeasurement, false);
  assert.equal(result.contextEpoch, 'unknown', 'a compaction before the window is not reported as the initial epoch');
  assert.ok(reader.offset === (await stat(file)).size);
  await appendFile(file, line({ type: 'user', sessionId: id, message: { content: 'next' } }));
  assert.equal((await reader.read()).historyChangedAfterMeasurement, true);
  await appendFile(file, line({ type: 'system', subtype: 'compact_boundary', sessionId: id, timestamp: 'new-boundary' }));
  const compacted = await reader.read();
  assert.equal(compacted.available, false); assert.equal(compacted.contextEpoch, 'new-boundary');
});

test('a compressed Codex rollout is read once, and a resumed plain rollout takes over', async t => {
  const root = await scratch(t, '.codex-fixture-'), id = randomUUID(), plain = path.join(root, 'rollout.jsonl'), archive = plain + '.zst';
  const rows = [
    { type: 'turn_context', payload: { model: 'gpt', turn_id: 't' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't', model_context_window: 1000 } },
    { type: 'event_msg', timestamp: 'x', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 250 }, model_context_window: 1000 } } },
  ];
  await writeFile(archive, zlib.zstdCompressSync(Buffer.from(rows.map(line).join(''))));
  await utimes(archive, 1700000000, 1700000000); // Whole seconds survive a later reset exactly.
  const reader = new IncrementalContextReader('codex', id); reader.filename = archive;
  assert.equal((await reader.read()).usedPercent, 25);
  // Same size and time: the cached result is used without decompressing again.
  const info = await stat(archive);
  await writeFile(archive, Buffer.alloc(info.size, 0)); await utimes(archive, 1700000000, 1700000000);
  assert.equal((await reader.read()).usedPercent, 25);
  await writeFile(plain, rows.slice(0, 2).map(line).join('') + line({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 500 }, model_context_window: 1000 } } }));
  assert.equal((await reader.read()).usedPercent, 50); assert.equal(reader.filename, plain);
});

test('overlapping discovery requests share one scan per directory', async t => {
  const root = await scratch(t, '.discovery-fixture-'); let calls = 0;
  const adapter = { list: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { sessions: [], warnings: [] }; } };
  const service = new PlexusService({ store: {}, root, adapters: { claude: adapter }, accessPolicy: { permits: () => true, assert: () => {} } });
  const directories = [{ path: root, recursive: false }];
  await Promise.all([service.sessions({ directories }), service.sessions({ directories }), service.sessions({ directories })]);
  assert.equal(calls, 1);
  await service.sessions({ directories: [{ path: root, recursive: true }] });
  assert.equal(calls, 2, 'a different scope is scanned separately');
});
