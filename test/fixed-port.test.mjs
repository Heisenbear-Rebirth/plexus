import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { DEFAULT_PORT, servePort } from '../src/loopback-server.mjs';
import { startServer } from '../src/http-server.mjs';

test('the manager uses one fixed default port unless the user chooses another', () => {
  assert.equal(DEFAULT_PORT, 47821);
  assert.equal(servePort(undefined, {}), 47821);
  assert.equal(servePort('31000', { PLEXUS_PORT: '32000' }), 31000, '--port wins over the environment');
  assert.equal(servePort(undefined, { PLEXUS_PORT: '32000' }), 32000);
  assert.equal(servePort(undefined, { PLEXUS_PORT: '0' }), 0, '0 keeps a random port');
  for (const bad of ['-1', '65536', '12.5', 'abc']) assert.throws(() => servePort(bad, {}), /端口/);
});

test('a taken default port falls back with a visible warning; an explicit port fails instead', async t => {
  const blocker = createServer(); await new Promise(ok => blocker.listen(0, '127.0.0.1', ok));
  const taken = blocker.address().port, roots = [], servers = [];
  t.after(async () => {
    for (const server of servers) await server.close();
    await new Promise(ok => blocker.close(ok));
    for (const root of roots) { assert.ok(root.startsWith(resolve('.') + '\\') || root.startsWith(resolve('.') + '/')); await rm(root, { recursive: true, force: true }); }
  });
  const root = await mkdtemp(join(resolve('.'), '.http-test-port-')); roots.push(root);
  await assert.rejects(startServer({ root, port: taken, startMonitoring: false, adapters: {} }), { code: 'EADDRINUSE' });
  const fallback = await startServer({ root, port: taken, portFallback: true, startMonitoring: false, adapters: {} }); servers.push(fallback);
  assert.notEqual(new URL(fallback.url).port, String(taken));
  assert.match(fallback.store.warnings.join('\n'), new RegExp(`固定端口 ${taken} 已被其他程序占用`));
  const config = await (await fetch(fallback.url + '/api/config')).json();
  assert.ok(config.warnings.some(w => w.includes(String(taken))), 'the management page receives the warning');
});
