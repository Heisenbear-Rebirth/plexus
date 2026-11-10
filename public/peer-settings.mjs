const $ = id => document.getElementById(id);

// Summarize how connected Claude sessions follow the machine-wide switch. A
// session counts as active only after its native settings were read back.
export function peerInboundSummary(sessions, accept) {
  const counts = { active: 0, waiting: 0, reopen: 0, overridden: 0, failed: 0, restoring: 0 };
  for (const s of sessions) {
    const runtime = s.client === 'claude' ? s.monitoring?.runtime : null;
    if (!runtime?.connected) continue;
    const inbound = runtime.peerInbound;
    if (runtime.capabilities?.peerInboundControl !== true) { if (accept) counts.reopen++; continue; }
    if (!accept) { if (inbound && (inbound.mode !== 'default' || inbound.state === 'applying')) counts.restoring++; continue; }
    if (inbound?.state === 'failed') counts.failed++;
    else if (inbound?.mode === 'accept' && inbound.verifiedAt) counts[inbound.effective === 'accept' ? 'active' : 'overridden']++;
    else counts.waiting++;
  }
  if (!accept) return counts.restoring ? `已关闭；${counts.restoring} 个 Claude 会话正在恢复原生接收规则。` : '已关闭：Claude 按原生规则暂存不同权限类别之间的消息。';
  return [`已生效 ${counts.active} 个 Claude 会话`,
    counts.waiting && `${counts.waiting} 个正在应用或等待会话空闲后核对`,
    counts.overridden && `${counts.overridden} 个被托管策略或项目设置覆盖，仍会暂存`,
    counts.failed && `${counts.failed} 个应用失败，稍后自动重试`,
    counts.reopen && `${counts.reopen} 个需在任务结束后重开面板才能生效`].filter(Boolean).join('；') + '。';
}

export function setupPeerSettings({ request, post, toast, getConfig, getSessions }) {
  const dialog = $('peer-settings-dialog'), toggle = $('peer-cross-mode');
  const error = text => { $('peer-settings-error').textContent = text; $('peer-settings-error').hidden = !text; };
  const render = () => {
    const accept = getConfig()?.claudePeerCrossModeAccept === true;
    toggle.setAttribute('aria-checked', String(accept));
    $('peer-cross-mode-status').textContent = peerInboundSummary(getSessions(), accept);
  };
  $('open-peer-settings').addEventListener('click', async () => {
    error(''); render(); dialog.showModal();
    // Another window may have changed the switch since this page loaded.
    try { getConfig().claudePeerCrossModeAccept = (await request('/api/config')).claudePeerCrossModeAccept === true; render(); } catch { /* keep the loaded value */ }
  });
  toggle.addEventListener('click', async () => {
    const enabled = toggle.getAttribute('aria-checked') !== 'true';
    toggle.disabled = true; error('');
    try {
      getConfig().claudePeerCrossModeAccept = (await post('/api/claude-peer-inbound', { enabled })).claudePeerCrossModeAccept === true;
      render(); toast(enabled ? '已允许不同权限模式互发消息' : '已恢复 Claude 原生接收规则');
    } catch (e) { error(e.message); } finally { toggle.disabled = false; }
  });
  return { refresh() { if (dialog.open) render(); } };
}
