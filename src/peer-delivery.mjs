// Claude native receive-side outcomes for peer messages. The wrapper reports
// them per message ID; transport submission alone never proves delivery.
const HOLD_CAUSES = {
  'mode-mismatch': '发送方与接收会话的权限类别不一致（例如一方为“绕过权限”，另一方为 auto 等需审批模式）',
  'no-mode-asserted': '接收会话使用“绕过权限”模式，而消息没有声明发送方权限类别',
  'explicit-setting': '接收会话的跨会话接收设置（crossSessionInbound）要求暂存',
  'managed-setting': '接收端的托管设置要求暂存跨会话消息',
  'repo-setting': '接收会话所在项目的设置要求暂存跨会话消息',
  'invalid-setting': '接收端的跨会话接收设置无效，原生端按暂存处理',
  'bypass-default': '接收会话使用“绕过权限”模式，原生默认暂存跨会话消息',
  'mode-unknown': '原生端暂时无法确认接收会话的权限模式',
};
const DROP_OUTCOMES = {
  expired: '在原生审批期限内无人批准，消息已过期',
  refused: '接收会话的策略在等待期间改为拒收',
  dropped: '原生入口限制（频率、重复或队列上限）丢弃了这条消息',
  discarded: '接收会话在消息暂存期间结束，消息被丢弃',
};
const PARITY = new Set(['mode-mismatch', 'no-mode-asserted']);

export function peerDeliveryEntries(runtime) {
  const entries = Array.isArray(runtime?.peerDeliveries) ? runtime.peerDeliveries : runtime?.peerDelivery ? [runtime.peerDelivery] : [];
  return entries.filter(entry => typeof entry?.messageId === 'string' && entry.messageId);
}

// Returns the ledger status implied by a native observation, or null when the
// observation does not change what the sender and the history should show.
export function peerDeliveryOutcome(entry) {
  if (entry?.state === 'held') {
    const cause = HOLD_CAUSES[entry.cause] || '接收会话的跨会话接收策略暂存了这条消息';
    return { status: 'receiver_held', detail: `消息已提交，但被 Claude 原生接收策略暂存，尚未交给模型：${cause}。`
      + (PARITY.has(entry.cause) ? '原生端没有批准入口；到期前接收会话切换到与发送方相同的权限类别才会放行，否则消息过期。请告知用户统一双方权限模式，或在管理页“通信设置”中允许不同权限模式互发。'
        : '请告知用户在接收会话核对跨会话消息接收设置。')
      + '系统不会自动重发。' };
  }
  if (entry?.state === 'dropped') {
    const reason = DROP_OUTCOMES[entry.outcome] || '原生端丢弃了这条消息';
    const cause = HOLD_CAUSES[entry.cause];
    return { status: 'undelivered', detail: `消息未送达：${reason}，没有交给模型。` + (cause ? `暂存原因：${cause}。` : '')
      + '系统不会自动重发；统一权限模式或核对接收设置后，如仍需要请重新发送。' };
  }
  if (entry?.state === 'released') return { status: 'submitted', detail: '原生接收策略已放行这条消息，等待模型接收。' };
  if (entry?.state === 'received') return { status: 'submitted', detail: null };
  return null;
}
