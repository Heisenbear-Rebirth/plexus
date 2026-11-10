import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonLineObserver, ClaudeProtocolState, launchOption } from './claude-wrapper-state.mjs';
import { NativeContextChannel } from './claude-context-channel.mjs';
import { PeerMessageVisibility } from './claude-peer-visibility.mjs';
import { claudeDisplayLabel } from './prompt-settings.mjs';
import { loadPeerHistory } from './claude-peer-history.mjs';
import { freshAvailableQuota } from './quota-state.mjs';
import { listenLoopback } from './loopback-server.mjs';
import { ClaudeQuotaJournal } from './claude-quota-journal.mjs';
import { wrapperEnabledFor } from './wrapper-directories.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const normalize = value => resolve(value).replace(/^\\\\\?\\/, '').replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
const dataDirectory = process.env.COOP_WRAPPER_DATA_DIRECTORY ? resolve(process.env.COOP_WRAPPER_DATA_DIRECTORY) : join(root, '.cooperation', 'claude-wrapper');
if (!normalize(dataDirectory).startsWith(normalize(root) + '/')) throw new Error('Wrapper data must stay inside the Cooperation project.');
const [binary, ...args] = process.argv.slice(2);
if (!binary) { process.stderr.write('[Cooperation] Missing original Claude executable.\n'); process.exit(1); }
let enabled = false;
let peerMessageVisibility = process.env.COOP_PEER_MESSAGE_VISIBILITY !== '0';
// Reopening must not append old messages as if they were new arrivals.
let peerHistoryVisibility = process.env.COOP_PEER_HISTORY_VISIBILITY === '1';
try {
  const config = JSON.parse(await readFile(join(dataDirectory, 'config.json'), 'utf8'));
  peerMessageVisibility &&= config.peerMessageVisibility !== false;
  peerHistoryVisibility = process.env.COOP_PEER_HISTORY_VISIBILITY !== '0'
    && (peerHistoryVisibility || config.peerHistoryVisibility === true);
  enabled = wrapperEnabledFor(config, process.cwd()) && launchOption(args, '--input-format') === 'stream-json';
} catch { /* No project configuration means pure passthrough. */ }
const child = spawn(binary, args, { cwd: process.cwd(), env: process.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const resumeArg = launchOption(args, '--resume');
const resumed = /^[0-9a-f-]{36}$/i.test(resumeArg || '') ? resumeArg.toLowerCase() : null;
const state = new ClaudeProtocolState(resumed, args);
const quotaJournal = enabled ? new ClaudeQuotaJournal({ directory: join(dataDirectory, 'quota-state'), sessionId: resumed, cwd: process.cwd() }) : null;
const instanceId = randomUUID();
const token = randomBytes(32).toString('hex');
const registryFile = join(dataDirectory, 'instances', `${process.pid}-${instanceId}.json`);
let server, endpoint, pending, closing = false, writing = Promise.resolve(), lastSnapshot = '', lastCompaction = null;
let controlPending = null, lastControl = null;
let lastQuotaRead = null;
let selectionReading = null, nextSelectionRead = 0;
let selectionRead = null;
const controlOperations = new Map();
let registryTimer;
const nativeUiInstanceId = /^[0-9a-f-]{36}$/.test(process.env.COOP_NATIVE_UI_INSTANCE_ID || '') ? process.env.COOP_NATIVE_UI_INSTANCE_ID : null;
let nativeLifecycleOperationId = null;
let visibilityHistory = { status: enabled && peerMessageVisibility && peerHistoryVisibility ? 'pending' : 'disabled', count: 0 };
let historyRestoreSession = null;
// Session-scoped native flag layer; a new process starts without our value.
let peerInbound = { desired: 'default', mode: 'default', state: 'ready', effective: null, decidedBy: null, verifiedAt: null, updatedAt: null };
let peerInboundApplying = null, peerInboundVerifying = null, nextPeerInboundAttempt = 0;
const auditFile = join(dataDirectory, 'compactions.jsonl');
const audit = event => appendFile(auditFile, JSON.stringify({ at: new Date().toISOString(), instanceId, ...event }) + '\n', 'utf8');
function publicState() { return { ...state.publicState(), wrapperPid: process.pid, childPid: child.pid, instanceId, cwd: process.cwd(),
  selectionRead,
  ...(quotaJournal?.pending ? { activity: state.activity() === 'idle' ? 'unknown' : state.activity(),
    quotaRestart: { pending: true, stage: quotaJournal.stage, missingFields: quotaJournal.missingSelection(state), reason: quotaJournal.reason } } : {}),
  nativeUiInstanceId, nativeLifecycleOperationId, peerInbound,
  protocolVersion: 2, connected: !closing && !state.inputEnded, observedAt: new Date().toISOString(),
  capabilities: { readActivity: true, interrupt: true, sendControl: true, compact: true, observeCompletion: true, passiveUsage: true,
    quotaRecovery: true, peerQuotaRecovery: true, peerDeliveryLifecycle: true, peerInboundControl: true, inputLifecycle: true, restartRecovery: true, restartSelection: true, restartSelectionV2: true, selectionRefresh: true,
    hardAutomation: false, peerMessageVisibility: enabled && peerMessageVisibility, peerHistoryVisibility: enabled && peerMessageVisibility && peerHistoryVisibility },
  visibilityHistory,
  canCompact: Boolean(!quotaJournal?.pending && !pending && !controlPending && !contextChannel.active && state.canCompact(inputObserver.atBoundary)),
  compactionRequestId: pending?.id || null, lastCompaction, controlPending, lastControl }; }
function persist() {
  if (!enabled || !endpoint || closing) return;
  // The registry only locates this wrapper; live state is read from /status.
  // Writing full state here rewrote the file several times a second while working.
  const signature = JSON.stringify({ sessionId: state.sessionId, instanceId, cwd: process.cwd(), endpoint, token,
    wrapperPid: process.pid, childPid: child.pid, initialized: state.initialized, protocolVersion: 2, createdAt: startedAt });
  if (signature === lastSnapshot) return; lastSnapshot = signature;
  if (registryTimer) return;
  registryTimer = setTimeout(() => {
    registryTimer = null;
    writing = writing.then(async () => { await writeFile(registryFile + '.tmp', lastSnapshot + '\n', 'utf8'); await rename(registryFile + '.tmp', registryFile); })
      .catch(() => { lastSnapshot = ''; process.stderr.write('[Cooperation] Could not publish wrapper state.\n'); });
  }, 100);
}
async function finishCompaction(status, extra = {}) {
  const operation = pending;
  if (!operation) return;
  clearTimeout(operation.timer);
  pending = null;
  lastCompaction = { requestId: operation.id, sessionId: operation.sessionId, status, ...extra, completedAt: new Date().toISOString() };
  await audit({ type: 'finished', ...lastCompaction }).catch(() => {});
  operation.resolve(lastCompaction); persist();
}
const inputObserver = new JsonLineObserver(message => {
  if (nativeUiInstanceId && !nativeLifecycleOperationId && message.type === 'user') {
    const content = message.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
    nativeLifecycleOperationId = /^\[Cooperation native session:([0-9a-f-]{36})\]\n/.exec(text)?.[1] || null;
  }
  state.host(message); quotaJournal?.observe(state); persist();
});
const outputObserver = new JsonLineObserver(message => {
  state.child(message);
  quotaJournal?.observe(state);
  if (message.parent_tool_use_id || (message.session_id && state.sessionId !== message.session_id.toLowerCase())) return;
  if (message.type === 'result' && controlPending) {
    lastControl = { ...controlPending, status: state.lastCompletedTurnId === controlPending.requestId ? 'completed' : 'unknown',
      resultSubtype: message.subtype, isError: message.is_error === true, completedAt: state.lastResultAt };
    controlPending = null;
    void audit({ type: 'control_finished', ...lastControl }).catch(() => {});
  }
  if (pending && message.session_id && message.session_id.toLowerCase() !== pending.sessionId) { persist(); return; }
  if (pending && message.type === 'system' && message.subtype === 'compact_boundary') {
    pending.boundary = { trigger: message.compact_metadata?.trigger, preTokens: message.compact_metadata?.pre_tokens, observedAt: new Date().toISOString() };
    void audit({ type: 'compact_boundary', requestId: pending.id, sessionId: pending.sessionId, ...pending.boundary }).catch(() => {});
  }
  if (pending && message.type === 'result') {
    const boundary = pending.boundary;
    void finishCompaction(boundary && message.is_error !== true ? 'completed' : message.is_error ? 'failed' : 'not_compacted', {
      boundary: boundary || null, resultSubtype: message.subtype, isError: message.is_error === true,
      ...(boundary ? {} : { detail: 'The command ended without an observed compact_boundary.' }),
    });
  }
  persist();
});
const startedAt = new Date().toISOString();
const contextChannel = new NativeContextChannel(bytes => child.stdin.write(bytes), subtype => !pending &&
  (subtype === 'capacity' ? state.initialized && !state.inputEnded && inputObserver.atBoundary
    : subtype === 'interrupt' ? state.initialized && state.active && !state.inputEnded && inputObserver.atBoundary
    : !controlPending && (subtype === 'get_usage' ? state.canReadQuota(inputObserver.atBoundary)
      : subtype === 'get_settings' ? state.canQuery(inputObserver.atBoundary) : state.canCompact(inputObserver.atBoundary))));
// The window size is otherwise learned only when a turn ends or from an idle
// query, so a session already working when the manager starts showed no
// percentage until then. One local read fills it in, retried at most every 30 s.
let capacityReading = null, nextCapacityRead = 0;
function refreshCapacity() {
  if (!state.usage || state.usage.contextWindowTokens > 0 || capacityReading || contextChannel.active || Date.now() < nextCapacityRead) return;
  nextCapacityRead = Date.now() + 30000;
  capacityReading = contextChannel.capacity().then(native => { if (state.observeCapacity(native)) persist(); })
    .catch(() => {}).finally(() => { capacityReading = null; });
}
function refreshRestartSelection() {
  const needsSettings = () => state.selectionPending || !state.model || quotaJournal?.missingSelection(state).some(key => ['model', 'effort'].includes(key));
  if (!state.sessionId || !needsSettings()
    || selectionReading || contextChannel.active || !state.canQuery(inputObserver.atBoundary) || Date.now() < nextSelectionRead) return;
  nextSelectionRead = Date.now() + 5000;
  selectionRead = { state: 'reading', queriedAt: new Date().toISOString(), nextCheckAt: new Date(nextSelectionRead).toISOString() };
  const revision = state.activityRevision, candidate = quotaJournal.candidate;
  // Do not delay /status while native settings are being read: a slow read
  // must not turn a connected client into a connection timeout in the UI.
  selectionReading = (async () => {
    try {
      const selection = await contextChannel.selection();
      if (closing || quotaJournal.candidate !== candidate || !needsSettings()
        || state.activityRevision !== revision || !state.canQuery(inputObserver.atBoundary)) return;
      quotaJournal.selectionError = !state.observeNativeSelection(selection);
      selectionRead = { ...selectionRead, state: quotaJournal.selectionError ? 'unavailable' : 'ready' };
      quotaJournal.nextRead = 0; await quotaJournal.restore(state); persist();
    } catch { quotaJournal.selectionError = true; quotaJournal.nextRead = 0; selectionRead = { ...selectionRead, state: 'unavailable' }; persist(); }
  })().finally(() => { selectionReading = null; });
}
process.stdin.on('data', chunk => { if (enabled) inputObserver.push(chunk); if (!child.stdin.destroyed && !child.stdin.write(chunk)) process.stdin.pause(); });
child.stdin.on('drain', () => process.stdin.resume());
process.stdin.on('end', () => { state.inputEnded = true; child.stdin.end(); persist(); });
process.stdin.on('error', () => child.stdin.end());
child.stdin.on('error', () => { state.inputEnded = true; persist(); });
const peerVisibility = new PeerMessageVisibility(() => state.sessionId, 1024 * 1024, () => claudeDisplayLabel(root));
function writeIdeOutput(chunk) { if (!process.stdout.write(chunk)) child.stdout.pause(); }
function forwardOutput(chunk) {
  // Activity and maintenance observe original native messages, not display copies.
  if (enabled) outputObserver.push(chunk);
  if (enabled && peerMessageVisibility) peerVisibility.push(chunk, writeIdeOutput);
  else writeIdeOutput(chunk);
  if (enabled && peerMessageVisibility && peerHistoryVisibility && state.initialized && state.sessionId && !historyRestoreSession) {
    historyRestoreSession = state.sessionId;
    const restoreEpoch = state.contextEpoch;
    void loadPeerHistory({ sessionId: historyRestoreSession, cwd: process.cwd() }).then(result => {
      if (closing || state.sessionId !== historyRestoreSession) return;
      if (pending || state.contextEpoch !== restoreEpoch) {
        visibilityHistory = { status: 'unavailable', count: 0, reason: 'context_changed_during_restore' }; persist(); return;
      }
      peerVisibility.restoreHistory(result.frames, writeIdeOutput);
      visibilityHistory = { status: result.status, count: result.frames.length, truncated: result.truncated || false,
        ...(result.reason ? { reason: result.reason } : {}) };
      persist();
    }).catch(() => { visibilityHistory = { status: 'unavailable', count: 0, reason: 'history_read_failed' }; persist(); });
  }
}
child.stdout.on('data', chunk => { if (enabled) contextChannel.push(chunk, forwardOutput); else forwardOutput(chunk); });
child.stdout.on('end', () => { contextChannel.end(forwardOutput); peerVisibility.end(writeIdeOutput); });
process.stdout.on('drain', () => child.stdout.resume());
process.stdout.on('error', () => child.kill());
child.stderr.pipe(process.stderr);
child.once('error', async () => { process.stderr.write('[Cooperation] Failed to launch the original Claude process.\n'); await cleanup(1); });
child.once('close', (code, signal) => { void cleanup(code ?? (signal ? 1 : 0)); });
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => { child.kill(); setTimeout(() => process.exit(1), 3000).unref(); });
async function cleanup(code) {
  if (closing) return; closing = true;
  clearTimeout(registryTimer);
  contextChannel.close();
  if (pending) await finishCompaction('unknown', { detail: 'The original Claude process exited before completion was confirmed.' });
  server?.close(); server?.closeAllConnections();
  await writing;
  if (enabled) { await unlink(registryFile).catch(() => {}); await unlink(registryFile + '.tmp').catch(() => {}); }
  process.exit(code);
}
function authorized(request) {
  const value = request.headers.authorization || '';
  const expected = `Bearer ${token}`;
  return value.length === expected.length && timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}
async function readControlConfig() {
  try { const config = JSON.parse(await readFile(join(dataDirectory, 'config.json'), 'utf8'));
    const controls = wrapperEnabledFor(config, process.cwd());
    return { controls, acceptCrossMode: controls && config.peerCrossModeAccept === true };
  } catch { return { controls: false, acceptCrossMode: false }; }
}
// The user's switch maps to Claude's own crossSessionInbound setting in this
// process's flag layer: 'accept' when enabled, removed (null) when disabled.
function syncPeerInbound(accept) {
  const desired = accept ? 'accept' : 'default';
  if (peerInbound.desired !== desired) { peerInbound = { ...peerInbound, desired }; nextPeerInboundAttempt = 0; }
  if (peerInboundApplying) return peerInboundApplying;
  if (peerInbound.mode === desired) {
    if (!['ready', 'applied'].includes(peerInbound.state)) peerInbound = { ...peerInbound, state: 'applied' };
    verifyPeerInbound(); return Promise.resolve();
  }
  if (closing || Date.now() < nextPeerInboundAttempt || !state.initialized || state.inputEnded || !inputObserver.atBoundary) {
    if (peerInbound.state !== 'failed') peerInbound = { ...peerInbound, state: 'pending' };
    return Promise.resolve();
  }
  peerInbound = { ...peerInbound, state: 'applying' };
  peerInboundApplying = contextChannel.applyFlagSettings({ crossSessionInbound: desired === 'accept' ? 'accept' : null })
    .then(() => { peerInbound = { ...peerInbound, mode: desired, state: 'applied', verifiedAt: null, updatedAt: new Date().toISOString() };
      void audit({ type: 'peer_inbound_applied', mode: desired }).catch(() => {}); })
    .catch(error => { nextPeerInboundAttempt = Date.now() + 30000;
      peerInbound = { ...peerInbound, mode: error.outcome === 'unknown' ? null : peerInbound.mode, state: 'failed', updatedAt: new Date().toISOString() }; })
    .finally(() => { peerInboundApplying = null; persist(); verifyPeerInbound(); });
  return peerInboundApplying;
}
// Read back what the native receive policy will actually use, when idle.
function verifyPeerInbound() {
  if (peerInbound.verifiedAt || peerInbound.state !== 'applied' || peerInboundVerifying || contextChannel.active
    || pending || controlPending || !state.canQuery(inputObserver.atBoundary)) return;
  const mode = peerInbound.mode;
  peerInboundVerifying = contextChannel.inboundPolicy()
    .then(policy => { if (peerInbound.mode === mode) peerInbound = { ...peerInbound, effective: policy.value, decidedBy: policy.decidedBy, verifiedAt: new Date().toISOString() }; })
    .catch(() => {})
    .finally(() => { peerInboundVerifying = null; persist(); });
}
function reply(response, status, body) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
async function readRequest(request) {
  let body = ''; for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 128 * 1024) throw new Error('Request too large.'); }
  return JSON.parse(body);
}
async function control(kind, body) {
  const signature = createHash('sha256').update(JSON.stringify({ kind, ...body })).digest('hex');
  const old = controlOperations.get(body.requestId);
  if (old) return old.signature === signature ? old.promise : { status: 'request_id_conflict' };
  if (controlOperations.size >= 128) return { status: 'needs_attention', detail: 'Control operation ledger is full; reopen this wrapper at an idle boundary.' };
  const execute = async () => {
    const unchanged = () => state.sessionId === body.sessionId && state.activityRevision === body.expectedActivityRevision
      && (state.activeTurnId ?? null) === (body.expectedTurnId ?? null);
    const available = () => !quotaJournal?.pending && !pending && !contextChannel.active && inputObserver.atBoundary && !state.inputEnded
      && (kind === 'interrupt' ? state.active && Boolean(body.expectedTurnId) && !state.backgroundTasks.size
        : !state.selectionPending && !controlPending && (kind === 'quota-resume'
          ? state.quota?.autoResume && state.canQuery(inputObserver.atBoundary) && freshAvailableQuota(lastQuotaRead)
            && lastQuotaRead.activityRevision === state.activityRevision
          : state.canCompact(inputObserver.atBoundary)));
    if (!unchanged()) return { status: 'state_conflict' };
    if (!available()) return { status: 'busy' };
    await audit({ type: 'control_intent', kind, requestId: body.requestId, sessionId: body.sessionId,
      expectedTurnId: body.expectedTurnId ?? null, expectedActivityRevision: body.expectedActivityRevision, signature });
    if (!unchanged()) return { status: 'state_conflict' };
    if (!available()) return { status: 'busy' };
    let result;
    if (kind === 'interrupt') {
      const response = await contextChannel.interrupt();
      result = { status: 'acknowledged', requestId: body.requestId, expectedTurnId: body.expectedTurnId, ...response };
      // Acknowledgement is not a completed turn. State waits for the original result.
    } else {
      const frame = { type: 'user', session_id: body.sessionId, uuid: body.requestId, parent_tool_use_id: null,
        message: { role: 'user', content: body.text } };
      state.host(frame);
      quotaJournal?.observe(state);
      controlPending = { requestId: body.requestId, sessionId: body.sessionId, submittedAt: new Date().toISOString() };
      child.stdin.write(JSON.stringify(frame) + '\n');
      result = { status: 'submitted', ...controlPending, activeTurnId: state.activeTurnId };
    }
    await audit({ type: 'control_dispatch', kind, ...result }).catch(() => {}); persist(); return result;
  };
  const promise = execute().catch(error => ({ status: error.outcome === 'failed' ? 'failed' : 'unknown', requestId: body.requestId,
    detail: 'Native control outcome was not confirmed. No retry was made.' }));
  controlOperations.set(body.requestId, { signature, promise }); return promise;
}
async function compact(sessionId, requestId) {
  if (quotaJournal?.pending || pending || controlPending || contextChannel.active || !state.canCompact(inputObserver.atBoundary)) return { status: 'busy', detail: 'The selected session is not at an idle input boundary.' };
  if (sessionId !== state.sessionId) return { status: 'wrong_session' };
  const sequence = state.userSequence;
  let resolveOperation;
  const result = new Promise(resolve => { resolveOperation = resolve; });
  pending = { id: requestId, sessionId, resolve: resolveOperation, boundary: null };
  try {
    await audit({ type: 'requested', requestId, sessionId });
    // A normal IDE message may arrive while the audit append is pending.
    if (sequence !== state.userSequence || !state.canCompact(inputObserver.atBoundary)) { await finishCompaction('busy'); return result; }
    const frame = { type: 'user', session_id: sessionId, uuid: requestId, parent_tool_use_id: null, message: { role: 'user', content: '/compact' } };
    state.host(frame);
    quotaJournal?.observe(state);
    child.stdin.write(JSON.stringify(frame) + '\n');
    pending.timer = setTimeout(() => {
      if (!pending || pending.id !== requestId) return;
      const timedOut = { requestId, sessionId, status: 'unknown', detail: 'No completion result within 120 seconds. No retry was made.' };
      void audit({ type: 'timeout', ...timedOut }).catch(() => {});
      pending.resolve(timedOut); // Keep pending until a late result or process exit.
      persist();
    }, 120000);
    persist(); return result;
  } catch { await finishCompaction('failed', { detail: 'Could not persist or submit the compaction request.' }); return result; }
}
if (enabled) {
  try {
    await mkdir(join(dataDirectory, 'instances'), { recursive: true });
    server = createServer(async (request, response) => {
      try {
        if (!authorized(request)) return reply(response, 401, { error: 'Unauthorized' });
        const access = await readControlConfig(), controlsEnabled = access.controls;
        if (request.method === 'GET' && request.url === '/status') {
          refreshRestartSelection(); refreshCapacity(); void syncPeerInbound(access.acceptCrossMode);
          await quotaJournal?.restore(state);
          const snapshot = publicState();
          return reply(response, 200, { ...snapshot, controlsEnabled,
            capabilities: { ...snapshot.capabilities, automaticMaintenance: controlsEnabled, interrupt: controlsEnabled, sendControl: controlsEnabled, compact: controlsEnabled },
            canCompact: snapshot.canCompact && controlsEnabled });
        }
        if (!controlsEnabled) return reply(response, 403, { error: 'Control access for this directory is disabled.' });
        if (request.method === 'POST' && request.url === '/peer-intent') {
          const body = await readRequest(request);
          if (Object.keys(body).some(key => !['sessionId', 'instanceId', 'messageId', 'action'].includes(key))
            || body.sessionId !== state.sessionId || body.instanceId !== instanceId || !/^[0-9a-f-]{36}$/i.test(body.messageId || '')
            || !['prepare', 'cancel'].includes(body.action)) return reply(response, 400, { error: 'Invalid peer observation request.' });
          if (body.action === 'cancel') { state.forgetPeer(body.messageId); persist(); return reply(response, 200, { status: 'cancelled' }); }
          if (quotaJournal?.pending || state.selectionPending) return reply(response, 200, { status: 'deferred', notSubmitted: true, reason: 'receiver_unavailable', detail: quotaJournal?.reason || '正在同步当前模型和思考设置，稍后自动重试。' });
          if (state.quota) return reply(response, 200, { status: 'deferred', notSubmitted: true, runtime: publicState() });
          await Promise.race([syncPeerInbound(access.acceptCrossMode), new Promise(resolve => setTimeout(resolve, 3000))]);
          state.expectPeer(body.messageId); persist(); return reply(response, 200, { status: 'ready' });
        }
        if (request.method === 'GET' && request.url.startsWith('/context?')) {
          const query = new URL(request.url, 'http://127.0.0.1');
          if (query.searchParams.get('sessionId') !== state.sessionId) return reply(response, 400, { error: 'Wrong session.' });
          try { const usage = await contextChannel.query(); state.observeNativeUsage(usage); persist(); return reply(response, 200, { sessionId: state.sessionId, instanceId, usage }); }
          catch (error) { return reply(response, 409, { error: error.message }); }
        }
        if (request.method === 'GET' && request.url.startsWith('/quota?')) {
          if (new URL(request.url, 'http://127.0.0.1').searchParams.get('sessionId') !== state.sessionId) return reply(response, 409, { error: 'Wrong session.' });
          await selectionReading;
          const revision = state.activityRevision;
          try {
            const quota = await contextChannel.quota();
            lastQuotaRead = { ...quota, activityRevision: revision };
            return reply(response, 200, { sessionId: state.sessionId, instanceId, quota });
          } catch { return reply(response, 409, { error: '原生额度暂不可读取。' }); }
        }
        if (request.method === 'POST' && ['/interrupt', '/prompt', '/quota-resume'].includes(request.url)) {
          const body = await readRequest(request);
          if (Object.keys(body).some(key => !['sessionId', 'requestId', 'instanceId', 'expectedTurnId', 'expectedActivityRevision', 'text'].includes(key))
            || body.sessionId !== state.sessionId || body.instanceId !== instanceId || !/^[0-9a-f-]{36}$/i.test(body.requestId || '')
            || !Number.isInteger(body.expectedActivityRevision) || (request.url !== '/interrupt' && (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 50000)))
            return reply(response, 400, { error: 'Invalid target or control request.' });
          const result = await control(request.url.slice(1), body);
          return reply(response, ['busy', 'state_conflict', 'request_id_conflict'].includes(result.status) ? 409 : 200, result);
        }
        if (request.method !== 'POST' || request.url !== '/compact') return reply(response, 404, { error: 'Not found' });
        const body = await readRequest(request);
        if (Object.keys(body).some(key => !['sessionId', 'requestId', 'instanceId'].includes(key))
          || !/^[0-9a-f-]{36}$/i.test(body.sessionId || '') || !/^[0-9a-f-]{36}$/i.test(body.requestId || '') || body.instanceId !== instanceId) return reply(response, 400, { error: 'Invalid target or request.' });
        const result = await compact(body.sessionId.toLowerCase(), body.requestId);
        reply(response, result.status === 'busy' ? 409 : 200, result);
      } catch { if (!response.headersSent) reply(response, 500, { error: 'Wrapper request failed.' }); }
    });
    server.requestTimeout = 150000;
    await listenLoopback(server);
    endpoint = `http://127.0.0.1:${server.address().port}`; persist();
  } catch { enabled = false; server?.close(); process.stderr.write('[Cooperation] Control endpoint unavailable; normal Claude transport continues.\n'); }
}
