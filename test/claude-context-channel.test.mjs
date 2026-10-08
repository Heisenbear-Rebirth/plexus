import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeContextChannel } from '../src/claude-context-channel.mjs';

test('more than 32 timed-out reads recover without slot exhaustion, late replies cannot reach the IDE or complete another request', async () => {
  const sent = [], forwarded = [];
  const channel = new NativeContextChannel(bytes => sent.push(JSON.parse(bytes)), () => true, { timeoutMs: 2 });
  for (let i = 0; i < 40; i++) await assert.rejects(channel.selection(), /timed out/);
  assert.equal(channel.requests.size, 0); assert.equal(channel.active, false);
  const current = channel.query(); const latest = sent.at(-1).request_id;
  const respond = (id, used) => channel.push(Buffer.from(JSON.stringify({ type: 'control_response', response: {
    request_id: id, subtype: 'success', response: { totalTokens: used, rawMaxTokens: 100 } } }) + '\n'), line => forwarded.push(line));
  for (const request of sent.slice(0, -1)) respond(request.request_id, 99);
  assert.equal(channel.active, true); respond(latest, 10); assert.equal((await current).usedPercent, 10);
  respond('cooperation-context-some-other-owner-1', 20); assert.equal(forwarded.length, 1); channel.close();
});

test('a timed-out native interrupt stays blocked until its own late acknowledgment', async () => {
  let sent; const channel = new NativeContextChannel(bytes => { sent = JSON.parse(bytes); }, () => true, { timeoutMs: 2 });
  await assert.rejects(channel.interrupt(), /timed out/); assert.equal(channel.active, true);
  await assert.rejects(channel.query(), /input boundary/);
  channel.push(Buffer.from(JSON.stringify({ type: 'control_response', response: { request_id: sent.request_id, subtype: 'success', response: {} } })+'\n'),()=>assert.fail('late interrupt leaked'));
  assert.equal(channel.active, false); assert.equal(channel.requests.size, 0); channel.close();
});

test('native query response can share chunks with IDE replies and preserves UTF8/CRLF bytes', async () => {
  let sent; const channel = new NativeContextChannel(bytes => { sent = JSON.parse(bytes); }, () => true);
  const result = channel.query(); const forwarded = [];
  const ordinary = Buffer.from('{"type":"assistant","text":"中文🙂"}\r\n');
  const owned = Buffer.from(JSON.stringify({ type: 'control_response', response: { request_id: sent.request_id, subtype: 'success', response: { totalTokens: 10, rawMaxTokens: 100 } } }) + '\n');
  const other = Buffer.from('{"type":"control_response","response":{"request_id":"ide-owned"}}\n');
  const all = Buffer.concat([ordinary, owned, other]);
  for (let index = 0; index < all.length; index += 3) channel.push(all.subarray(index, index + 3), part => forwarded.push(part));
  assert.deepEqual(Buffer.concat(forwarded), Buffer.concat([ordinary, other]));
  assert.equal((await result).usedPercent, 10); channel.close();
});
test('context request refuses a busy input boundary without writing to Claude', async () => {
  let wrote = false; const channel = new NativeContextChannel(() => { wrote = true; }, () => false);
  await assert.rejects(channel.query(), /input boundary/); assert.equal(wrote, false); channel.close();
});

test('get_usage projects authoritative server windows and incomplete fallback without leaking session data', async () => {
  let sent; const channel = new NativeContextChannel(bytes => { sent = JSON.parse(bytes); }, () => true);
  for (const [rate_limits, expected] of [
    [{ limits: [{ kind: 'session', percent: 0 }, { kind: 'weekly_all', percent: 50 }] }, 'available'],
    [{ seven_day: { utilization: 50 } }, 'unknown'],
  ]) {
    const read = channel.quota(); assert.equal(sent.request.skip_behaviors, true);
    channel.push(Buffer.from(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: sent.request_id,
      response: { rate_limits_available: true, rate_limits, session: { secret: 'never-retain' } } } }) + '\n'), () => assert.fail('Owned response leaked'));
    const result = await read; assert.equal(result.status, expected); assert.doesNotMatch(JSON.stringify(result), /never-retain/);
  }
  channel.close();
});
