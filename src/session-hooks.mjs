// What a session's owner or agent needs to hand its interface to a program.
// The port is fixed by default but falls back when taken; the CLI finds either.
export function hookKey(hook) { return `hk_${hook.id}.${hook.secret}`; }

export function publicSessionHook(hook, { root, url } = {}) {
  if (!hook) return null;
  const key = hookKey(hook), cli = `${String(root || '.').replaceAll('\\', '/')}/bin/plexus.mjs`;
  return {
    id: hook.id, enabled: hook.enabled === true, key, session: { client: hook.session.client, id: hook.session.id, name: hook.session.name || null },
    createdAt: hook.createdAt, createdBy: hook.createdBy, rotatedAt: hook.rotatedAt || null, lastUsedAt: hook.lastUsedAt || null, uses: hook.uses || 0,
    command: `node "${cli}" notify --hook ${key} --source "程序名称" --text "要发送的内容"`,
    http: { method: 'POST', url: url ? `${url}/api/hooks/notify` : null, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: { text: '要发送的内容', source: '程序名称' },
      note: '服务默认固定在 127.0.0.1:47821；若该端口被占用，服务会改用随机端口并在管理页提示，此时以安装目录 .plexus/connection.json 中的 url 为准。主机名必须是 127.0.0.1。' },
  };
}
