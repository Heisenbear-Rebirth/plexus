#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { startMcp } from '../src/mcp.mjs';
import { servePort } from '../src/loopback-server.mjs';
import { detectSender } from '../src/identity.mjs';
import { sendViaManager, checkpointViaManager, lifecycleViaManager, notifyViaManager, sessionHookViaManager } from '../src/client.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command = 'help', ...args] = process.argv.slice(2);
function option(name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
try {
  if (command === 'serve') {
    const codexContext = { pipePath: process.env.CODEX_APP_TOOLS_PIPE_PATH, callerThreadId: process.env.CODEX_THREAD_ID, nodePath: process.env.CODEX_MCP_NODE_PATH };
    // Loaded only here: MCP and one-shot commands stay small and start fast.
    const { startServer } = await import('../src/http-server.mjs');
    const instance = await startServer({ root, port: servePort(option('--port')), portFallback: option('--port') === undefined && !process.env.PLEXUS_PORT, defaultDirectory: resolve(option('--directory') || process.cwd()), codexContext, onShutdown: () => process.exit(0) });
    console.log(`Plexus 管理台：${instance.url}`);
    for (const warning of instance.store.warnings) console.log(warning);
    console.log(`数据保存于：${resolve(root, '.plexus')}`);
    if (!instance.codexBridge?.status().connected) console.log('正在等待 Codex 接入；配置 Plexus MCP 后，打开 Codex 可自动连接。');
    const stop = () => instance.close().finally(() => process.exit(0));
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } else if (command === 'mcp') startMcp({ root, client: option('--client') });
  else if (command === 'context' && args[0] === 'checkpoint') {
    const from = await detectSender({ client: option('--client') });
    const result = await checkpointViaManager(root, { from, cycleId: option('--cycle'), stage: option('--stage'),
      receiptToken: option('--receipt-token'), documentPath: option('--document') });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'send') {
    const message = option('--file') ? await readFile(resolve(option('--file')), 'utf8') : option('--text');
    const from = await detectSender({ client: option('--client') });
    const result = await sendViaManager(root, { from, to: option('--to'), message });
    console.log(JSON.stringify(result, null, 2));
    if (['failed', 'undelivered'].includes(result.status)) process.exitCode = 1;
  } else if (command === 'notify') {
    // For programs outside any session: the interface key is the only identity.
    const text = option('--file') ? await readFile(resolve(option('--file')), 'utf8') : option('--text');
    const result = await notifyViaManager(root, { key: option('--hook') || process.env.PLEXUS_HOOK_KEY, text, source: option('--source') });
    console.log(JSON.stringify(result, null, 2));
    if (['failed', 'undelivered'].includes(result.status)) process.exitCode = 1;
  } else if (command === 'hook') {
    const from = await detectSender({ client: option('--client') });
    console.log(JSON.stringify(await sessionHookViaManager(root, { from }), null, 2));
  } else if (command === 'session' && ['create','connect'].includes(args[0])) {
    const from = await detectSender({ client: option('--client') });
    const result = await lifecycleViaManager(root, { from, action: args[0], args: { requestId: option('--request-id'), directory: option('--directory'),
      ...(args[0] === 'create' ? { client: option('--target-client'), ...(option('--title') ? { title: option('--title') } : {}), ...(option('--prompt') ? { prompt: option('--prompt') } : {}) } : { to: option('--to') }) } });
    console.log(JSON.stringify(result, null, 2));
    if (!['created','connected'].includes(result.status)) process.exitCode = 1;
  } else {
    console.log('Plexus\n\n  node bin/plexus.mjs serve [--directory PATH] [--port 47821]\n  node bin/plexus.mjs send --to ADDRESS --text MESSAGE [--client codex|claude]\n  node bin/plexus.mjs send --to ADDRESS --file REPORT.txt [--client codex|claude]\n  node bin/plexus.mjs hook [--client codex|claude]\n  node bin/plexus.mjs notify --hook KEY (--text MESSAGE | --file PATH) [--source NAME]\n  node bin/plexus.mjs session create --target-client opencode --directory PATH --request-id KEY [--title TITLE] [--client codex|claude]\n  node bin/plexus.mjs session connect --to ADDRESS --directory PATH --request-id KEY [--client codex|claude]\n  node bin/plexus.mjs context checkpoint --cycle ID --stage handoff|restored --receipt-token TOKEN --document PATH\n  node bin/plexus.mjs mcp [--client codex|claude]\n\nMCP 提供 send_message、context_checkpoint、session_interface、create_session、connect_session。notify 供会话之外的程序使用，凭会话接口密钥向该会话发消息。生命周期操作的未知结果必须用原 requestId 核对。');
    if (command !== 'help' && command !== '--help') process.exitCode = 1;
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
