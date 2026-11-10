const $ = id => document.getElementById(id);
function node(tag, className, text) { const n = document.createElement(tag); n.className = className || ''; if (text !== undefined) n.textContent = text; return n; }
function when(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return '尚未调用';
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}
export function httpExample(hook) {
  return `POST ${hook.http.url}\nAuthorization: ${hook.http.headers.Authorization}\nContent-Type: application/json\n\n${JSON.stringify(hook.http.body)}`;
}
// A bypass Claude session holds messages that carry no permission class.
export function hookWarning(session, config) {
  const runtime = session?.monitoring?.runtime;
  if (session?.client !== 'claude' || runtime?.permissionMode !== 'bypassPermissions' || config?.claudePeerCrossModeAccept === true) return '';
  return '该会话使用“绕过权限”模式。外部程序的消息不带权限声明，会被 Claude 原生暂存后过期；请在“通信设置”中开启“允许不同权限模式互发消息”。';
}

export function setupSessionHook({ post, toast, copy, getConfig }) {
  const dialog = $('hook-dialog');
  let session = null, hook = null, busy = false, generation = 0;
  const error = text => { $('hook-error').textContent = text; $('hook-error').hidden = !text; };
  const block = (title, text, note) => {
    const section = node('section', 'hook-section'), heading = node('div', 'hook-section-heading');
    heading.append(node('strong', '', title), Object.assign(node('button', 'text-button', '复制'), { type: 'button', onclick: () => copy(text) }));
    section.append(heading, node('pre', 'hook-block', text)); if (note) section.append(node('p', 'small muted', note)); return section;
  };
  function render() {
    const body = $('hook-body'); body.replaceChildren();
    $('hook-session').textContent = session ? `${session.name || session.id} · ${session.client}` : '';
    const warning = hookWarning(session, getConfig()); $('hook-warning').textContent = warning; $('hook-warning').hidden = !warning;
    if (hook) {
      body.append(node('p', 'small', hook.enabled ? `已开启 · 已调用 ${hook.uses} 次 · 最近：${when(hook.lastUsedAt)}` : '已停用：使用该密钥的调用会被拒绝。'),
        block('接口密钥', hook.key, '可放进外部程序的配置或环境变量 COOP_HOOK_KEY。'),
        block('命令行调用（推荐）', hook.command, '服务重启后仍然可用；也可用 --file 发送文件内容。'),
        block('HTTP 调用', httpExample(hook), hook.http.note));
    } else if (!busy) body.append(node('p', 'small muted', '尚未开启。开启后生成本会话专用的密钥。'));
    $('hook-enable').hidden = Boolean(hook?.enabled); $('hook-enable').textContent = hook ? '重新启用' : '开启接口';
    $('hook-rotate').hidden = !hook; $('hook-disable').hidden = !hook?.enabled;
    for (const id of ['hook-enable', 'hook-rotate', 'hook-disable']) $(id).disabled = busy;
  }
  async function act(action, done) {
    const current = ++generation; busy = true; error(''); render();
    try {
      const result = await post('/api/session-hook', { address: `${session.client}:${session.id}`, action });
      if (current === generation) { hook = result.hook; if (done) toast(done); }
    } catch (e) { if (current === generation) error(e.message); }
    finally { if (current === generation) { busy = false; render(); } }
  }
  $('hook-enable').addEventListener('click', () => act(hook ? 'enable' : 'create', hook ? '会话接口已重新启用' : '会话接口已开启'));
  $('hook-rotate').addEventListener('click', () => act('rotate', '密钥已重置，旧密钥立即失效'));
  $('hook-disable').addEventListener('click', () => act('disable', '会话接口已停用'));
  return { open(target) { session = target; hook = null; dialog.showModal(); act('get'); } };
}
