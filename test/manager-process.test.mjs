import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { managerProcessAlive } from '../src/manager-process.mjs';

const record = { pid: 12345, started_at: '2026-01-01T12:00:00.000Z' };
const acquiredAt = Date.parse(record.started_at);

function processFixture(t, { probeError = 'EPERM', metadata, metadataError = false }) {
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, record.pid);
    assert.equal(signal, 0, 'Identity checks must never terminate a process');
    if (probeError) throw Object.assign(new Error('Process probe failed'), { code: probeError });
    return true;
  });
  const query = t.mock.method(childProcess, 'execFileSync', () => {
    if (metadataError) throw new Error('Process metadata unavailable');
    return metadata;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return query;
}

for (const probeError of ['EPERM', 'EACCES']) {
  test(`Windows reclaims a stale lock when its PID belongs to a newer protected process (${probeError})`, { skip: process.platform !== 'win32' }, t => {
    processFixture(t, { probeError, metadata: String(acquiredAt + 1000) });
    assert.equal(managerProcessAlive(record), false);
  });
}

test('Windows retains a live manager lock even when its process probe is denied', { skip: process.platform !== 'win32' }, t => {
  processFixture(t, { metadata: String(acquiredAt - 1000) });
  assert.equal(managerProcessAlive(record), true);
});

for (const fixture of [{ metadataError: true }, { metadata: '' }, { metadata: 'unavailable' }]) {
  test(`Windows retains a protected process lock when metadata is unknown: ${JSON.stringify(fixture)}`, { skip: process.platform !== 'win32' }, t => {
    processFixture(t, fixture);
    assert.equal(managerProcessAlive(record), true);
  });
}

test('Windows reclaims a protected process lock when the process exits before the metadata read', { skip: process.platform !== 'win32' }, t => {
  processFixture(t, { metadata: 'missing' });
  assert.equal(managerProcessAlive(record), false);
});

test('A missing PID releases the lock without a metadata query', t => {
  const query = processFixture(t, { probeError: 'ESRCH' });
  assert.equal(managerProcessAlive(record), false);
  assert.equal(query.mock.callCount(), 0);
});

test('Unexpected process-probe errors retain the lock', t => {
  const query = processFixture(t, { probeError: 'EIO', metadata: String(acquiredAt + 1000) });
  assert.equal(managerProcessAlive(record), true);
  assert.equal(query.mock.callCount(), 0);
});
