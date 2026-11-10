const stages = ['保存进度', '整理上下文', '恢复任务'];
function quotaWindowName(window) {
  const minutes = window.windowDurationMins;
  if (minutes === 10080) return '每周额度';
  if (minutes > 0) return minutes % 60 === 0 ? `${minutes / 60} 小时额度` : `${minutes} 分钟额度`;
  return window.id.endsWith(':primary') ? '主额度窗口' : window.id.endsWith(':secondary') ? '次额度窗口' : window.id;
}
export function accountQuotaExhausted(runtime) {
  const q = runtime?.accountQuota, age = Date.now() - Date.parse(q?.queriedAt);
  return q?.status === 'exhausted' && age >= 0 && age < 120000;
}
export function maintenanceView(cycle, runtime = {}) {
  const stage = ['needs_attention', 'user_intervened', 'waiting_client'].includes(cycle.state) ? cycle.previousState : cycle.state;
  const index = ['compacting'].includes(stage) ? 1 : ['restoring', 'awaiting_restore_end'].includes(stage) ? 2 : 0;
  const paused = ['needs_attention', 'user_intervened'].includes(cycle.state);
  const view = { stages, index, paused, title: ['正在保存进度', '正在整理上下文', '正在恢复任务'][index],
    description: ['模型正在整理接下来继续工作所需的信息。完成后会自动进入下一步。', '已保存任务进度，正在释放上下文空间。', '模型正在读取已保存的进度，完成后按原任务继续。'][index], primary: null };
  if (runtime.connected && runtime.requiresReopen) return { ...view, title: '已连接，需要重开面板加载修复',
    description: runtime.detail || '当前面板仍使用旧接入程序。请在当前任务结束后关闭并重开同一会话面板一次，系统会自动重新核对。' };
  if (runtime.connected && runtime.selectionPending) return { ...view, title: '已连接，正在同步当前设置',
    description: '模型、思考强度或权限设置尚未核对完成，系统会自动重试，已有进度和排队消息保留。' };
  if (cycle.state === 'interrupting') return { ...view, title: '正在暂停当前工作', description: '原任务暂停后，会先保存进度，再整理上下文。' };
  if (cycle.state === 'awaiting_handoff_end') return { ...view, title: '进度已保存', description: '等待当前回复结束，随后自动整理上下文。' };
  if (cycle.state === 'awaiting_restore_end') return { ...view, title: '任务进度已恢复', description: cycle.wasWorkingAtTrigger ? '当前回复结束后，会自动继续原任务。' : '当前回复结束后，维护即完成。' };
  if (cycle.state === 'waiting_client' && !cycle.canRestartFromCurrent) {
    if (!runtime.connected) return { ...view, title: '等待会话重新连接', description: '请打开原来的会话。任务进度和待处理消息已保留，连接后会自动检查。' };
    if (['waiting_permission', 'waiting_input'].includes(runtime.activity)) return { ...view, title: '已连接，等待你的确认', description: '请在原会话处理待确认操作，之后会自动核对接续。' };
    if (runtime.activity === 'running') return { ...view, title: '已连接，等待当前回复结束', description: '任务进度和排队消息保留，当前回复结束后自动核对。' };
    if (!runtime.model || runtime.quotaRestart?.pending || /同步.*模型/.test(cycle.reason || '')) return { ...view,
      title: runtime.selectionRead?.state === 'unavailable' ? '已连接，设置暂未读取成功' : '已连接，正在核对会话设置',
      description: '正在读取原会话的模型、思考强度和权限设置，系统会自动重试；无需反复连接或发送消息唤醒。' };
    return { ...view, title: '已连接，正在核对维护进度', description: cycle.reason || '正在检查原生历史、压缩结果和阶段回执，已有进度和排队消息保留。' };
  }
  if (!paused && (runtime.activity === 'waiting_permission' || runtime.activity === 'waiting_input')) return { ...view, title: '等待你的确认', description: '请在原会话中处理权限请求或问题，之后会自动接续。' };
  if (!paused && !cycle.canRestartFromCurrent) return view;
  if (cycle.canRestartFromCurrent) {
    const q = runtime.client === 'codex' ? runtime.accountQuota || cycle.maintenanceQuota : cycle.maintenanceQuota, age = Date.now() - Date.parse(q?.queriedAt);
    const missingWindows = (q?.missingWindows || []).map(id => ({ five_hour: '五小时', seven_day: '每周' })[id]).filter(Boolean);
    const quotaReady = q?.status === 'available' && age >= 0 && age < 120000;
    const quotaNeeded = cycle.compactionFailed || runtime.quota;
    const settingsPending = runtime.quotaRestart?.pending || runtime.client === 'claude' && !runtime.model;
    const available = runtime.connected === true && (runtime.activity === 'idle' || runtime.activity === 'quota_limited' && runtime.quota?.autoResume)
      && (!quotaNeeded || quotaReady) && !accountQuotaExhausted(runtime) && !settingsPending && runtime.capabilities?.automaticMaintenance !== false;
    const hint = runtime.connected !== true ? '请先打开原会话，连接后可继续。'
      : settingsPending ? '已连接，等待模型和权限设置读取完成。'
      : !['idle', 'quota_limited'].includes(runtime.activity) ? '当前回复结束后，此按钮即可使用。'
      : quotaNeeded && !quotaReady ? q?.status === 'exhausted' ? '当前额度仍不足，系统每分钟检测，恢复后可继续。'
        : missingWindows.length ? `Claude 未返回完整的${missingWindows.join('、')}额度数据，系统每分钟重试；可在原会话查看 /usage。` : '尚未确认可用额度，系统每分钟自动查询。'
      : runtime.quota && !runtime.quota.autoResume ? '原会话已手动停止或中断状态尚未确认，请先在原会话核对。'
      : accountQuotaExhausted(runtime) ? '额度恢复后可继续。'
      : runtime.capabilities?.automaticMaintenance === false ? '原生维护能力就绪后可继续。' : null;
    return { ...view, title: cycle.compactionFailed ? '上次整理未完成，可以重新接续' : '维护已暂停，可按当前进度继续',
      description: cycle.compactionFailed ? '已确认上次整理操作结束且没有压缩完成记录。继续后重新保存最新进度，再整理上下文；旧交付、回执和排队消息保留。'
        : '会话已有后续操作。继续后会重新保存最新进度，再整理上下文；旧交付、回执和排队消息保留。',
      actionHint: hint, primary: { action: 'restart-current', label: cycle.compactionFailed ? '重新保存进度并继续整理' : '按当前进度继续维护', disabled: !available } };
  }
  const reason = cycle.reason || '';
  let description = '维护已暂停，已保存的进度和待处理消息会保留。检查会话后可从当前步骤继续。';
  if (/模型|思考强度|权限选项/.test(reason)) description = '会话设置发生了变化。请先确认原会话的设置，再继续这次维护。';
  else if (/新输入|新业务|用户/.test(reason)) description = '检测到新的会话操作。请确认是否仍需继续这次维护。';
  else if (/额度/.test(reason)) description = '额度暂时不足。恢复后，可从当前步骤继续维护。';
  else if (cycle.lastReceiptIssue || /回执|超时/.test(reason)) description = '尚未确认这一步是否完成。已有文档可以保留，检查后继续，无需从头开始。';
  const canRetry = /^目标轮次已结束，但系统未收到阶段回执/.test(reason) && ['writing_handoff', 'restoring'].includes(stage);
  return { ...view, title: '维护需要确认', description, primary: { action: canRetry ? 'retry' : 'reconcile',
    label: canRetry ? index === 0 ? '继续保存进度' : '继续恢复任务' : '检查并继续' } };
}
export function maintenanceDiagnostic(session, cycle, runtime = {}) {
  // Deliberately select public support fields; never serialize the whole session.
  return { client: session.client, sessionId: session.id, cycleId: cycle.id, state: cycle.state, previousState: cycle.previousState,
    reason: cycle.reason || null, lastReceiptIssue: cycle.lastReceiptIssue || null, createdAt: cycle.createdAt, updatedAt: cycle.updatedAt,
    activity: runtime.activity, connected: runtime.connected, model: runtime.model, requiresReopen: runtime.requiresReopen === true,
    selectionRead: runtime.selectionRead, maintenanceQuota: cycle.maintenanceQuota, compactionFailed: cycle.compactionFailed === true };
}

export function peerDeliveryView(session) {
  const runtime = session.monitoring?.runtime || {}, peer = runtime.peerDelivery;
  if (session.client !== 'claude' || !runtime.connected) return null;
  if (peer?.state === 'dropped') return { title: '上一条协作消息未送达',
    description: peer.outcome === 'expired' ? '消息在 Claude 原生端等待接收期间已过期，没有交给模型执行。'
      : 'Claude 原生端已拒收或丢弃这条消息，没有交给模型执行。',
    action: '请先核对原会话的跨会话消息接收设置，再决定是否重新发送；系统不会自动重发。' };
  if (peer?.state === 'held') {
    const cause = peer.cause;
    return { title: 'Claude 已暂存协作消息',
      description: cause === 'no-mode-asserted' ? '当前 Claude 会话使用“绕过权限”模式，消息未声明发送方权限模式，被原生接收策略暂存。'
        : cause === 'mode-mismatch' ? '发送方与 Claude 会话的权限模式不一致，消息被原生接收策略暂存。'
        : 'Claude 的跨会话消息接收策略暂存了这条消息，模型尚未收到。',
      action: '请在 Claude 原会话核对跨会话消息接收设置。当前不是模型正在工作，也不是 Plexus 的重启接续确认。' };
  }
  if (runtime.pendingPeerMessages > 0 && !runtime.busy) return { title: '已连接，等待协作消息接收',
    description: `有 ${runtime.pendingPeerMessages} 条协作消息已提交，但尚未观察到原生接收结果。`,
    action: runtime.capabilities?.peerDeliveryLifecycle ? '系统正在等待原生接收、暂存或拒收通知；暂不重复发送。'
      : '当前面板尚未加载接收状态修复；请在任务结束后重开同一 Claude 面板，以识别原生暂存和拒收通知。' };
  return null;
}

export function quotaView(session) {
  const runtime = session.monitoring?.runtime || {}, quota = runtime.quota;
  const saved = session.monitoring?.quotaRecovery;
  const record = !quota || saved?.eventId === quota.turnId ? saved : null;
  const account = session.client === 'codex' ? runtime.accountQuota : null;
  if (!quota && !runtime.quotaRestart?.pending && !['waiting', 'sending', 'attention'].includes(record?.state)) {
    if (!account || !runtime.connected) return null;
    const age = Date.now() - Date.parse(account.queriedAt), fresh = Number.isFinite(age) && age >= 0 && age < 120000;
    const status = fresh ? account.status : 'unknown', exhausted = status === 'exhausted';
    const windows = (account.windows || []).filter(w => Number.isFinite(w.usedPercent))
      .map(w => `${quotaWindowName(w)}已用 ${w.usedPercent}%`).join('；');
    return { title: exhausted ? 'Codex 账户额度不足' : status === 'available' ? 'Codex 账户额度可用' : 'Codex 账户额度待查询',
      description: exhausted ? '后台已独立检测到账户额度不足，即使原生会话显示空闲也会保留此状态。'
        : status === 'available' ? (windows || '账户额度查询成功。') : '暂时未取得有效的账户额度结果，后台会继续查询。',
      action: exhausted ? '系统每分钟检测额度，暂缓新维护与排队投递。只有确认因额度中断的原任务才会自动接续。' : undefined,
      quotaStatus: exhausted ? (windows || '当前额度不足') : status === 'available' ? '当前额度可用' : '当前额度尚未确认',
      quotaQueriedAt: account.queriedAt, quotaFresh: fresh, nextCheckAt: account.nextCheckAt,
      resetAt: exhausted ? account.nextResetAt : null, connected: true };
  }
  const enabled = session.policy?.enabled === true && session.policy.mode === 'automatic';
  let title = '等待额度恢复', description, action;
  const connected = runtime.connected === true;
  const restartUpgrade = runtime.quotaRestart?.pending && runtime.capabilities && runtime.capabilities.restartSelection !== true;
  if (runtime.connected === false && record) { title = '原会话尚未连接'; description = '上次中断的任务已保留。'; action = '请打开原来的会话，连接后系统会继续检查。'; }
  else if (runtime.requiresReopen || restartUpgrade) {
    title = connected ? '已连接，重开面板后可加载修复' : '接入需要更新';
    description = restartUpgrade ? '当前面板仍使用修复前的接入程序，未能读取模型和权限设置，自动接续已暂停。' : runtime.detail;
    action = '请关闭并重新打开同一个 Claude 会话；正在运行的任务请先等它结束。';
  }
  else if (runtime.quotaRestart?.pending) {
    const restart = runtime.quotaRestart;
    title = connected ? '已连接，自动接续暂缓' : '正在恢复自动接续';
    const missing = (restart.missingFields || []).map(key => ({ model: '模型', permissionMode: '权限模式', effort: '思考强度' })[key]).filter(Boolean).join('、');
    description = ['settings', 'settings_unavailable'].includes(restart.stage)
      ? `已找到上次中断的任务，${missing || '当前设置'}尚未读取完成。`
      : restart.reason || '正在核对上次中断的任务记录。';
    action = restart.stage === 'failure_unverified' ? '请在原会话核对任务是否已经结束。'
      : restart.stage === 'history_unavailable' ? '请确认原会话的聊天记录可以正常打开，再点击“更新状态”。'
      : '系统会自动重试；无需重复连接，也无需发送消息唤醒。';
  }
  else if (session.client === 'opencode' && quota) { title = 'OpenCode 限流需要处理'; description = '已暂停上下文压缩及排队投递。当前没有可核验的统一额度查询，请在原会话处理额度或限流并继续；恢复正常后再释放队列。'; }
  else if (!enabled) description = '因额度不足中断，已暂停上下文压缩。启用自动管理后可自动检测额度并在状态允许时继续。';
  else if (session.cycle) { title = '维护等待额度恢复'; description = '自动管理已开启。此次上下文维护因额度不足暂停，恢复后请核对当前维护步骤并继续。'; }
  else if (record?.reason) {
    description = record.reason;
    if (record.state === 'attention') title = '自动继续需要确认';
    if (record.state === 'cancelled') title = '自动继续已暂停';
    if (record.state === 'sending') title = '正在继续任务';
    if (record.state === 'waiting' && record.blockedReason) title = '正在检测额度，等待会话就绪';
  } else if (quota?.autoResume === false) description = '自动管理已开启。此次中断尚不满足自动继续条件，请核对原会话；上下文压缩已暂停。';
  else description = runtime.activity === 'quota_limited'
    ? '自动管理已开启，正在检测额度，确认恢复后自动继续。'
    : '自动管理已开启，正在核对原生状态并检测额度；确认可继续前暂停上下文压缩。';
  const reading = account || session.cycle?.maintenanceQuota || record?.quota;
  const queriedAt = reading?.queriedAt;
  const age = Date.now() - Date.parse(queriedAt), fresh = Number.isFinite(age) && age >= 0 && age < 120000;
  const quotaStatus = !fresh ? '当前额度待查询' : reading.status === 'available' ? '当前额度可用'
    : reading.status === 'exhausted' ? '当前额度不足' : '当前额度尚未确认';
  if (!fresh && record?.state === 'waiting' && connected && enabled && !runtime.quotaRestart?.pending && !runtime.requiresReopen && !session.cycle)
    description = '上次任务因额度不足暂停，当前额度需要重新查询。' + (record.blockedReason || '系统会自动检查，任务保留。');
  const consent = session.monitoring?.restartConsent;
  if (!session.cycle && connected && enabled && fresh && reading?.status === 'available' && record?.state === 'waiting'
    && record.blockedReason && !runtime.requiresReopen && !runtime.quotaRestart?.pending) {
    title = '额度已恢复，等待会话就绪'; description = '当前额度可用。' + record.blockedReason;
  }
  if (session.cycle && connected && enabled && fresh && reading?.status === 'available' && !runtime.requiresReopen && !runtime.quotaRestart?.pending) {
    title = ['pending', 'deferred'].includes(consent) ? '额度已恢复，等待接续确认' : '额度已恢复，可继续维护';
    description = '已确认当前额度可用。已保存的进度和排队消息保留，请按下方维护步骤继续。';
    action = null;
  }
  if (connected && session.client === 'claude' && record?.state === 'waiting' && enabled && fresh && reading?.status === 'unknown'
    && !runtime.quotaRestart?.pending && !runtime.requiresReopen && !session.cycle && !record.blockedReason) {
    const missing = reading.missingWindows || ['five_hour','seven_day'].filter(id => !reading.windows?.some(w => w.id === id && w.usedPercent !== null));
    const names = missing.map(key => ({ five_hour: '五小时', seven_day: '每周' })[key]).filter(Boolean);
    title = '额度查询不完整';
    description = names.length ? `Claude 未返回完整的${names.join('、')}额度数据，当前无法确认是否可继续。`
      : 'Claude 当前额度查询未成功，尚不能确认是否可继续。';
    action = '后台会继续查询。可在 Claude 原会话查看 /usage；查询不完整不代表额度仍然耗尽。';
  }
  if (connected && fresh && reading?.status === 'available' && record?.state === 'waiting' && enabled && !runtime.quotaRestart?.pending && !runtime.requiresReopen && !session.cycle && !record.blockedReason) {
    title = ['pending', 'deferred'].includes(consent) ? '额度已恢复，等待你的接续确认' : '额度已恢复，正在核对会话';
    description = ['pending', 'deferred'].includes(consent) ? '当前额度可用，确认本次重启接续后会核对原任务并继续。' : '当前额度可用，正在核对原失败轮次和会话状态。';
  }
  return { title, description, action, connected, quotaStatus, quotaQueriedAt: queriedAt, quotaFresh: fresh,
    consentLabel: consent === 'approved' ? '重启接续已确认' : ['pending', 'deferred'].includes(consent) ? '等待你的重启接续确认' : null,
    resetAt: reading?.nextResetAt || quota?.resetsAt,
    nextCheckAt: connected && enabled && !runtime.requiresReopen && record?.state === 'waiting' ? record.nextCheckAt : account?.nextCheckAt || null };
}
