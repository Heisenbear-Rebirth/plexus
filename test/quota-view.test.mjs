import test from 'node:test';
import assert from 'node:assert/strict';
import { quotaView, accountQuotaExhausted } from '../public/maintenance-view.mjs';
import { publicCodexQuota } from '../src/quota-state.mjs';

test('fresh independent quota overrides a stale exhausted explanation while a real readiness gate remains',()=>{
  const session={client:'codex',policy:{enabled:true,mode:'automatic'},monitoring:{restartConsent:'approved',runtime:{connected:true,activity:'quota_limited',quota:{turnId:'failure'},
    accountQuota:{status:'available',queriedAt:new Date().toISOString()}},quotaRecovery:{state:'waiting',eventId:'failure',blockedReason:'仍有未结束的子任务。',
    reason:'额度尚未恢复，继续等待。',quota:{status:'exhausted',queriedAt:'2020-01-01'}}}};
  const view=quotaView(session);assert.equal(view.title,'额度已恢复，等待会话就绪');assert.doesNotMatch(view.description,/尚未恢复/);assert.match(view.description,/子任务/);
});

test('Codex quota windows use their actual duration, including a weekly primary window and missing duration', () => {
  const accountQuota = publicCodexQuota({ rateLimits: { primary: { usedPercent: 65, windowDurationMins: 10080 }, secondary: { usedPercent: 20, windowDurationMins: 300 } } });
  assert.equal(accountQuota.windows[0].windowDurationMins, 10080);
  const session = { client: 'codex', monitoring: { runtime: { connected: true, activity: 'idle', accountQuota } } };
  const view = quotaView(session); assert.match(view.description, /每周额度已用 65%/); assert.match(view.description, /5 小时额度已用 20%/);
  delete accountQuota.windows[0].windowDurationMins; assert.match(quotaView(session).description, /主额度窗口已用 65%/);
  assert.doesNotMatch(quotaView(session).description, /短期额度/);
});

test('reopened and offline clients explain the retained quota state before a new live quota marker exists', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: {
    runtime: { connected: false }, quotaRecovery: { state: 'waiting', reason: 'old' } } };
  assert.match(quotaView(session).title, /尚未连接/);
  session.monitoring.runtime = { connected: true, quotaRestart: { pending: true, reason: '等待核对原生历史' } };
  assert.equal(quotaView(session).description, '等待核对原生历史'); assert.match(quotaView(session).title, /已连接/);
  assert.match(quotaView(session).action, /无需重复连接/);
});

test('connected restart recovery names the missing settings and separates stale quota from consent', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: { restartConsent: 'approved',
    runtime: { connected: true, quotaRestart: { pending: true, stage: 'settings', missingFields: ['model', 'permissionMode'] }, capabilities: { restartSelection: true } },
    quotaRecovery: { state: 'waiting', reason: '额度尚未恢复', quota: { status: 'exhausted', queriedAt: '2020-01-01' } } } };
  const view = quotaView(session); assert.match(view.title, /已连接/); assert.match(view.description, /模型、权限模式尚未读取/);
  assert.equal(view.quotaStatus, '当前额度待查询'); assert.equal(view.consentLabel, '重启接续已确认'); assert.match(view.action, /无需重复连接/);
  session.monitoring.runtime.capabilities.restartSelection = false;
  assert.match(quotaView(session).title, /已连接.*修复/); assert.match(quotaView(session).action, /重新打开同一个 Claude 会话/);
  session.monitoring.quotaRecovery.quota = { status: 'available', queriedAt: new Date().toISOString() };
  assert.equal(quotaView(session).quotaStatus, '当前额度可用');
  session.monitoring.runtime = { connected: false };
  assert.equal(quotaView(session).title, '原会话尚未连接');
});

test('quota guidance follows saved automatic policy and reports a pending state without asking to enable it again', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: { runtime: { activity: 'running', quota: { turnId: 'failed', autoResume: true } } } };
  assert.match(quotaView(session).description, /自动管理已开启/);
  assert.doesNotMatch(quotaView(session).description, /启用自动管理后/);
  session.policy.enabled = false; assert.match(quotaView(session).description, /启用自动管理后/);
});
test('quota guidance distinguishes blocked recovery, client upgrades and an active maintenance cycle', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: { runtime: { connected: true, activity: 'unknown', quota: { turnId: 'failed' } },
    quotaRecovery: { eventId: 'failed', state: 'waiting', blockedReason: '等待输入', reason: '额度已恢复。等待输入', nextCheckAt: '2030-01-01' } } };
  assert.match(quotaView(session).title, /等待会话就绪/); assert.equal(quotaView(session).nextCheckAt, '2030-01-01');
  session.monitoring.runtime.requiresReopen = true; session.monitoring.runtime.detail = '需要重开原面板';
  assert.equal(quotaView(session).description, '需要重开原面板'); assert.equal(quotaView(session).nextCheckAt, null);
  session.monitoring.runtime.requiresReopen = false; session.cycle = { state: 'needs_attention' };
  assert.match(quotaView(session).description, /核对当前维护步骤/);
});

test('incomplete Claude usage is a query problem, not another assertion of exhaustion; offline hides obsolete polling time', () => {
  const session = { client: 'claude', policy: { enabled: true, mode: 'automatic' }, monitoring: {
    runtime: { connected: true, activity: 'quota_limited', quota: { turnId: 'failed', autoResume: true, resetsAt: '2000-01-01' } },
    quotaRecovery: { eventId: 'failed', state: 'waiting', reason: '暂未确认可用额度，保留等待状态。', nextCheckAt: '2000-01-01',
      quota: { source: 'claude-native-get-usage', status: 'unknown', queriedAt: new Date().toISOString(), windows: [{ id: 'seven_day', usedPercent: 50 }] } },
  } };
  const view = quotaView(session); assert.equal(view.title, '额度查询不完整'); assert.match(view.description, /五小时/);
  assert.match(view.action, /不代表额度仍然耗尽/); assert.doesNotMatch(view.description, /已经恢复/);
  session.monitoring.runtime = { connected: false, activity: 'offline' };
  assert.equal(quotaView(session).title, '原会话尚未连接'); assert.equal(quotaView(session).nextCheckAt, null);
});
test('a previous failed turn cannot lend its cancellation message or quota reading to a new event', () => {
  const session = { policy: { enabled: true, mode: 'automatic' }, monitoring: { runtime: { activity: 'quota_limited', quota: { turnId: 'new', autoResume: true } },
    quotaRecovery: { eventId: 'old', state: 'cancelled', reason: '旧请求已取消', quota: { nextResetAt: 'old-date' } } } };
  assert.match(quotaView(session).description, /自动管理已开启/); assert.equal(quotaView(session).resetAt, undefined);
});

test('independent Codex account quota remains visible for idle sessions without claiming a failed task or trusting stale reads', () => {
  const runtime = { connected: true, activity: 'idle', accountQuota: { status: 'exhausted', queriedAt: new Date().toISOString(), nextCheckAt: '2030-01-01', windows: [{ id: 'codex:primary', usedPercent: 100 }] } };
  const session = { client: 'codex', monitoring: { runtime } };
  assert.match(quotaView(session).title, /账户额度不足/); assert.match(quotaView(session).action, /只有确认因额度中断/);
  assert.equal(accountQuotaExhausted(runtime), true);
  runtime.accountQuota.queriedAt = '2000-01-01'; assert.equal(accountQuotaExhausted(runtime), false); assert.match(quotaView(session).title, /待查询/);
  runtime.accountQuota.queriedAt = new Date().toISOString(); runtime.accountQuota.status = 'available';
  assert.match(quotaView(session).title, /额度可用/);
  runtime.quota = { turnId: 'interrupted', autoResume: true }; session.cycle = { state: 'needs_attention' };
  session.policy = { enabled: true, mode: 'automatic' };
  assert.equal(quotaView(session).title, '额度已恢复，可继续维护'); assert.doesNotMatch(quotaView(session).description, /等待额度恢复/);
});
