import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

const filename = root => join(root, '.plexus', 'codex-bridge.json');
const validId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value);
function validContext(value) {
  if (!value || !validId(value.callerThreadId) || typeof value.pipePath !== 'string' || value.pipePath.length > 512) return null;
  const pipe = value.pipePath;
  if (/[\r\n\0]/.test(pipe) || !(pipe.startsWith('\\\\.\\pipe\\') || (process.platform !== 'win32' && isAbsolute(pipe)))) return null;
  if (value.nodePath !== undefined && (typeof value.nodePath !== 'string' || !isAbsolute(value.nodePath))) return null;
  return { pipePath: pipe, callerThreadId: value.callerThreadId, ...(value.nodePath ? { nodePath: value.nodePath } : {}) };
}
export function codexContextFromEnvironment(env = process.env, callerThreadId = env.CODEX_THREAD_ID) {
  return validContext({ pipePath: env.CODEX_APP_TOOLS_PIPE_PATH, callerThreadId, ...(env.CODEX_MCP_NODE_PATH ? { nodePath: env.CODEX_MCP_NODE_PATH } : {}) });
}
async function savedContexts(root) {
  try {
    const text = await readFile(filename(root), 'utf8');
    if (Buffer.byteLength(text) > 65536) return [];
    const record = JSON.parse(text);
    return record.version === 1 ? [record.context, ...(Array.isArray(record.contexts) ? record.contexts.slice(0, 16) : [])].map(validContext).filter(Boolean) : [];
  } catch { return []; }
}
async function savedContext(root) { return (await savedContexts(root))[0] || null; }
export async function rememberCodexEnvironment(root, env = process.env) {
  // An app-wide MCP process may not have a current turn. Reuse only the
  // previously authorized caller from this project's connection, never a
  // discovered or invented conversation identity.
  const previous = await savedContext(root);
  return rememberCodexBridge(root, codexContextFromEnvironment(env, env.CODEX_THREAD_ID || previous?.callerThreadId));
}
export async function rememberCodexBridge(root, context = codexContextFromEnvironment()) {
  const selected = validContext(context); if (!selected) return false;
  const previous = await savedContexts(root);
  if (JSON.stringify(previous[0]) === JSON.stringify(selected)) return true;
  const contexts = [...new Map([selected, ...previous].map(value => [JSON.stringify(value), value])).values()].slice(0, 16);
  const file = filename(root), temporary = file + '.' + randomUUID() + '.tmp';
  await mkdir(join(root, '.plexus'), { recursive: true });
  try {
    await writeFile(temporary, JSON.stringify({ version: 1, capturedAt: new Date().toISOString(), context: selected, contexts }) + '\n', { mode: 0o600 });
    await rename(temporary, file);
  } finally { await unlink(temporary).catch(() => {}); }
  return true;
}

export class CodexBridgeConnection {
  constructor({ root, context, probe, onUpdate = () => {}, intervalMs = 15000 }) {
    this.root = root; this.startupContext = validContext(context); this.onUpdate = onUpdate; this.intervalMs = intervalMs;
    this.probe = probe || (async context => (await import('./adapters/codex.mjs')).probeCodexBridge({ ...context, handshakeTimeoutMs: 3000 }));
    this.state = { connected: false, state: 'checking', detail: '正在连接 Codex…', checkedAt: null };
    this.closed = false; this.inFlight = null; this.context = null;
  }
  async init() {
    await rememberCodexBridge(this.root, this.startupContext);
    await this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, this.intervalMs); this.timer.unref();
    return this;
  }
  status() { return { ...this.state }; }
  setState(connected, hasCandidate = true) {
    const previous = this.state;
    this.state = { connected, state: connected ? 'connected' : hasCandidate ? 'disconnected' : 'waiting',
      detail: connected ? 'Codex 已连接' : hasCandidate ? 'Codex 连接已断开，正在自动重连。' : '等待 Codex 接入；配置 Plexus MCP 后打开 Codex 即可自动连接。',
      checkedAt: new Date().toISOString() };
    if (previous.state !== this.state.state) this.onUpdate(this.status());
  }
  refresh() {
    if (this.closed) return Promise.resolve(this.status());
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.check().finally(() => { this.inFlight = null; }); return this.inFlight;
  }
  async check() {
    const candidates = [...await savedContexts(this.root), this.context, this.startupContext].filter(Boolean);
    const seen = new Set();
    for (const candidate of candidates) {
      const key = JSON.stringify(candidate); if (seen.has(key)) continue; seen.add(key);
      try {
        await this.probe(candidate);
        this.context = candidate; this.setState(true); return this.status();
      } catch { /* Keep looking for another already-authorized connection. */ }
    }
    this.setState(false, candidates.length > 0); return this.status();
  }
  async getContext({ excludeThreadId } = {}) {
    await this.refresh();
    if (!this.state.connected) throw Object.assign(new Error(this.state.detail), { code: 'CODEX_CONNECTION_UNAVAILABLE', outcome: 'not_submitted', retryable: false });
    if (!excludeThreadId || this.context.callerThreadId.toLowerCase() !== excludeThreadId.toLowerCase()) return { ...this.context };
    // A Claude relay must not use its Codex recipient as the tool caller.
    // Retain real captured callers; never invent an identity for this purpose.
    const candidates = [...await savedContexts(this.root), this.startupContext].filter(Boolean);
    const seen = new Set();
    for (const candidate of candidates) {
      if (candidate.callerThreadId.toLowerCase() === excludeThreadId.toLowerCase()) continue;
      const key = JSON.stringify(candidate); if (seen.has(key)) continue; seen.add(key);
      try { await this.probe(candidate); return { ...candidate }; } catch {}
    }
    throw Object.assign(new Error('等待独立的 Codex 发送连接，消息已保留。'), { code: 'CODEX_RELAY_CALLER_UNAVAILABLE', outcome: 'not_submitted' });
  }
  invalidate() { this.setState(false); }
  async close() { this.closed = true; clearInterval(this.timer); await this.inFlight; }
}
