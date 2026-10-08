import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceView, maintenanceDiagnostic, peerDeliveryView } from '../public/maintenance-view.mjs';

test('connected maintenance waits distinguish initialization, settings, busy, permissions, upgrade and history', () => {
  const c = { state: 'waiting_client', previousState: 'compacting' };
  const idle = { client: 'claude', connected: true, activity: 'idle', model: 'current' };
  assert.match(maintenanceView(c, { connected: false }).title, /等待会话重新连接/);
  for (const [patch, title] of [[{ model: null }, '正在核对会话设置'], [{ model: null, selectionRead: { state: 'unavailable' } }, '设置暂未读取成功'],
    [{ activity: 'running' }, '当前回复结束'], [{ activity: 'waiting_permission' }, '等待你的确认'],
    [{ requiresReopen: true }, '重开面板加载修复'], [{}, '正在核对维护进度']]) {
    const view = maintenanceView(c, { ...idle, ...patch }); assert.ok(view.title.includes(title), view.title);
    assert.doesNotMatch(view.title, /等待会话重新连接/);
  }
});
test('confirmed compact failure offers a real restart after fresh quota and settings, including a quota-limited head', () => {
  const c = { state: 'waiting_client', previousState: 'compacting', canRestartFromCurrent: true, compactionFailed: true };
  const runtime = { client: 'claude', connected: true, activity: 'idle', model: 'current' };
  assert.equal(maintenanceView(c, runtime).primary.disabled, true);
  assert.match(maintenanceView({ ...c, maintenanceQuota: { status: 'unknown', missingWindows: ['five_hour', 'seven_day'] } }, runtime).actionHint, /五小时、每周.*\/usage/);
  const ready = { ...c, maintenanceQuota: { status: 'available', queriedAt: new Date().toISOString() } };
  const view = maintenanceView(ready, runtime); assert.equal(view.primary.action, 'restart-current'); assert.equal(view.primary.disabled, false);
  assert.match(view.primary.label, /继续整理/);
  assert.equal(maintenanceView(ready, { ...runtime, model: null }).primary.disabled, true);
  assert.equal(maintenanceView(ready, { ...runtime, activity: 'quota_limited', quota: { autoResume: true } }).primary.disabled, false);
  assert.equal(maintenanceView(ready, { ...runtime, activity: 'quota_limited', quota: { autoResume: false } }).primary.disabled, true);
  assert.equal(maintenanceView({ ...ready, maintenanceQuota: { status: 'exhausted', queriedAt: new Date().toISOString() } }, runtime).primary.disabled, true);
});

test('Codex independent quota enables an eligible paused handoff and pending selections explain the wait', () => {
  const cycle = { state: 'needs_attention', previousState: 'writing_handoff', canRestartFromCurrent: true };
  const runtime = { client: 'codex', connected: true, model: 'fixture', activity: 'quota_limited', quota: { autoResume: true },
    accountQuota: { status: 'available', queriedAt: new Date().toISOString() } };
  assert.equal(maintenanceView(cycle, runtime).primary.disabled, false);
  runtime.selectionPending = true; assert.match(maintenanceView(cycle, runtime).title, /同步当前设置/); assert.equal(maintenanceView(cycle, runtime).primary, null);
});

test('maintenance view communicates task stages and only asks for a concrete necessary action', () => {
  assert.deepEqual(maintenanceView({ state: 'writing_handoff' }).stages, ['保存进度','整理上下文','恢复任务']);
  assert.equal(maintenanceView({ state: 'writing_handoff' }).primary, null);
  assert.equal(maintenanceView({ state: 'compacting' }).index, 1);
  assert.equal(maintenanceView({ state: 'restoring' }).index, 2);
  assert.equal(maintenanceView({ state: 'writing_handoff' }, { activity: 'waiting_permission' }).title, '等待你的确认');
  const view = maintenanceView({ state: 'needs_attention', previousState: 'writing_handoff', reason: '维护阶段超时；会话锁及排队消息已保留。' });
  assert.equal(view.primary.label, '检查并继续'); assert.doesNotMatch(view.description, /回执|会话锁|FIFO/);
  assert.equal(maintenanceView({ state: 'needs_attention', previousState: 'writing_handoff', reason: '目标轮次已结束，但系统未收到阶段回执。' }).primary.label, '继续保存进度');
});
test('copyable support diagnostics select public fields and omit credentials, prompts, paths and document contents', () => {
  const diagnostic = maintenanceDiagnostic({ client: 'claude', id: 'public-session', cwd: 'private-directory', token: 'secret' },
    { id: 'public-cycle', state: 'needs_attention', receiptToken: 'secret', receiptHashes: { handoff: 'secret' }, handoffPath: 'private-file', controlPrompt: 'private-prompt' },
    { model: 'chosen', token: 'secret', history: ['private-conversation'] });
  assert.equal(diagnostic.cycleId, 'public-cycle');
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret|private-/);
});

test('a paused maintenance cause remains visible when the native client is also waiting for approval', () => {
  const view = maintenanceView({ state: 'needs_attention', previousState: 'restoring', reason: '维护期间模型发生变化，请核对用户操作。' },
    { activity: 'waiting_permission', connected: true });
  assert.equal(view.title, '维护需要确认'); assert.equal(view.primary.action, 'reconcile');
  assert.match(view.description, /设置发生了变化/); assert.doesNotMatch(view.description, /之后会自动接续/);
});

test('eligible pre-compaction pauses expose an actionable continue button and explain when the current reply blocks it', () => {
  const cycle = { state: 'needs_attention', previousState: 'awaiting_handoff_end', canRestartFromCurrent: true, reason: '重启后检测到维护之外的新输入，需人工核对。' };
  const runtime = { connected: true, activity: 'idle' };
  const view = maintenanceView(cycle, runtime);
  assert.equal(view.primary.action, 'restart-current'); assert.equal(view.primary.label, '按当前进度继续维护'); assert.equal(view.primary.disabled, false);
  assert.match(view.description, /最新进度/); assert.match(view.description, /旧交付、回执和排队消息保留/);
  const busy = maintenanceView(cycle, { ...runtime, activity: 'running' }); assert.equal(busy.primary.disabled, true); assert.match(busy.actionHint, /当前回复结束/);
  assert.equal(maintenanceView(cycle, { ...runtime, connected: false }).primary.disabled, true);
  assert.notEqual(maintenanceView({ ...cycle, canRestartFromCurrent: false }, runtime).primary.action, 'restart-current');
});

test('Claude peer status distinguishes legacy unobserved, native held, expired and received messages', () => {
  const session = { client: 'claude', monitoring: { runtime: { connected: true, busy: false, pendingPeerMessages: 1 } } };
  assert.match(peerDeliveryView(session).title, /等待协作消息接收/);
  assert.match(peerDeliveryView(session).action, /重开同一 Claude 面板/);
  session.monitoring.runtime.peerDelivery = { state: 'held', cause: 'no-mode-asserted' };
  assert.match(peerDeliveryView(session).description, /未声明发送方权限模式/);
  session.monitoring.runtime.peerDelivery = { state: 'dropped', outcome: 'expired' };
  session.monitoring.runtime.pendingPeerMessages = 0;
  assert.match(peerDeliveryView(session).description, /已过期.*没有交给模型/);
  session.monitoring.runtime.peerDelivery = { state: 'received' }; assert.equal(peerDeliveryView(session), null);
});
