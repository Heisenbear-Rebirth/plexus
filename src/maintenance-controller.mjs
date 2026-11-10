import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { join, relative, isAbsolute } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { publicSession } from './address.mjs';
import { receiptHash, recoverableReceiptPause } from './checkpoint-service.mjs';
import { sessionKey } from './management-store.mjs';
import { handoffPrompt, restorePrompt, continuePrompt } from './maintenance-prompts.mjs';
import { maintenanceStage, restartCandidate, restartPlan, readRestartEvidence, controlTurnEnded, canRestartFromCurrent, confirmedCompactionFailure } from './maintenance-recovery.mjs';
import { normalizeDirectory } from './directory-service.mjs';
import { readAccessPolicy } from './access-policy.mjs';
import { nativeMessageId } from './opencode-bridge.mjs';
import { readPromptSettings } from './prompt-settings.mjs';
import { QuotaRecovery } from './quota-recovery.mjs';
import { selectedModelChanged, missingSelectedSettings as missingSelection } from './model-identity.mjs';
import { accountQuotaBlocked, freshAvailableQuota } from './quota-state.mjs';
import { hasPendingSubagents } from './codex-subagents.mjs';

const terminal = new Set(['completed', 'cancelled', 'needs_attention', 'user_intervened']);
const active = s => ['running', 'waiting_permission', 'waiting_input'].includes(s.activity);
const deadline = ms => new Date(Date.now() + ms).toISOString();
const stageTimeout = { interrupting: 30000, writing_handoff: 10 * 60_000, awaiting_handoff_end: 60000, compacting: 5 * 60_000, restoring: 5 * 60_000, awaiting_restore_end: 60000 };

function completedClaudeCompaction(cycle, runtime) {
  const requestId = cycle.compactResult?.requestId;
  if (!requestId || runtime.lastCompletedTurnId !== requestId) return null;
  return [runtime.lastCompaction, cycle.compactResult].find(result => result?.status === 'completed'
    && result.requestId === requestId && (!result.sessionId || result.sessionId === cycle.session.id)
    && Date.parse(result.completedAt) >= Date.parse(cycle.compactIntentAt)) || null;
}
function completedOpenCodeCompaction(cycle, runtime) {
  const result = runtime.lastCompaction;
  return result?.status === 'completed' && result.requestId === (cycle.compactResult?.requestId || cycle.compactRequestId)
    && result.nativeMessageId === runtime.latestTurn?.id && runtime.latestTurn.status === 'completed'
    && Date.parse(result.completedAt) >= Date.parse(cycle.compactIntentAt) ? result : null;
}

export class MaintenanceController {
  constructor({ root, store, service, monitor, onUpdate = () => {}, intervalMs = 2000, recoveryEvidence = readRestartEvidence }) {
    this.root = root; this.store = store; this.service = service; this.monitor = monitor; this.onUpdate = onUpdate;
    this.recoveryEvidence = recoveryEvidence; this.recoveryPollAt = new Map();
    this.intervalMs = intervalMs; this.running = new Map(); this.closed = false;
    this.quotaRecovery = new QuotaRecovery({ root, store, service, monitor, onUpdate });
  }
  start() {
    if (!this.timer) {
      this.timer = setInterval(() => { if (!this.closed && !this.ticking) this.tickPromise = this.tick().catch(error => this.store.event('manager_error', { error: error.message })); }, this.intervalMs); this.timer.unref();
      // Recovery uses the same per-cycle lock and repeated polling as normal
      // advancement. A client may appear long after the service starts.
    }
  }
  async tick() {
    if (this.closed || this.ticking) return;
    this.ticking = true;
    try {
      const access = await readAccessPolicy();
      // Active cycles keep their lock even when a user disables the monitor.
      const cycles = this.store.activeCycles().filter(c => access.permits(c.session.cwd));
      for (const cycle of cycles.filter(c => !terminal.has(c.state) || restartCandidate(c) || confirmedCompactionFailure(c) || c.quotaWaiting)) void this.advance(cycle.id);
      const observed = this.monitor.observeAll ? await this.monitor.observeAll() : null;
      await Promise.allSettled(this.store.policies().map(async policy => {
        if (this.closed) return;
        const session = policy.session;
        if (session.cwd && !access.permits(session.cwd)) return;
        if (this.store.activeCycle(session)) return;
        if (!policy.enabled) {
          await this.quotaRecovery.handle(session, policy, this.store.getSnapshot(session) || { runtime: {} }); return;
        }
        const sample = observed?.get(sessionKey(session)) || await this.monitor.sample(session);
        const latestPolicy = this.store.getPolicy(session);
        if (!latestPolicy || latestPolicy.revision !== policy.revision) return;
        if (await this.quotaRecovery.handle(session, latestPolicy, sample)) return;
        if (!latestPolicy.enabled || latestPolicy.mode !== 'automatic') return;
        if (policy.mode === 'automatic' && sample.decision.action === 'trigger') {
          try { await this.trigger(session, policy, sample); }
          catch (e) { this.store.saveSnapshot(session, { ...sample, decision: { action: 'attention', reason: e.message } }); this.onUpdate(session); }
        }
      }));
      void this.service.mailbox?.flush().catch(error => this.store.event('mailbox_error', { error: error.message }));
    } finally { this.ticking = false; }
  }
  async trigger(session, policy, sample, { replaceCycle } = {}) {
    this.store.restartConfirmation?.assertAllowed(session);
    if (!['codex', 'claude', 'opencode'].includes(session.client)) throw new Error('此客户端的自动维护尚未开放。');
    const runtime = sample.runtime;
    if (runtime.selectionPending) throw new Error('正在同步当前模型设置，请等待核对完成。');
    if (accountQuotaBlocked(runtime)) throw new Error('Codex 账户额度不足，暂不启动上下文维护。');
    if ((runtime.quota || runtime.activity === 'quota_limited') && !sample.decision.quotaResume) throw new Error('额度不足中断期间不进行上下文压缩。');
    if (runtime.capabilities?.automaticMaintenance === false) throw new Error('此客户端的原生控制尚待本机验收，目前仅开放观察模式。');
    const required = ['readActivity', 'sendControl', 'compact', 'observeCompletion', ...(sample.decision.wasWorkingAtTrigger ? ['interrupt'] : [])];
    if (!required.every(c => runtime.capabilities?.[c])) throw new Error('目标客户端的维护能力尚未就绪。');
    if (runtime.goalStatus === 'active' || runtime.backgroundTasks > 0 || runtime.queuedNativeInputs > 0 || hasPendingSubagents(runtime)
      || session.client === 'opencode' && (runtime.pendingRequests || runtime.reverted)) throw new Error('会话仍有原生目标、子agent、后台工作、权限请求或已排队输入，暂不能自动维护。');
    const metadata = await this.service.adapters[session.client].find(session.id);
    if (!metadata?.cwd) throw new Error('无法确认目标会话的工作目录。');
    (await readAccessPolicy()).assert(metadata.cwd);
    const target = publicSession(metadata);
    if (replaceCycle && (target.id !== replaceCycle.session.id || target.client !== replaceCycle.session.client
      || normalizeDirectory(target.cwd) !== normalizeDirectory(replaceCycle.session.cwd)))
      throw new Error('目标会话或工作目录已改变，未重新开始维护。');
    const id = randomUUID(), stageTokens = { handoff: randomBytes(24).toString('base64url'), restored: randomBytes(24).toString('base64url') };
    const state = sample.decision.wasWorkingAtTrigger ? 'interrupting' : 'writing_handoff';
    const cycle = this.store.transaction(() => {
      this.store.restartConfirmation?.assertAllowed(session);
      if (replaceCycle) {
        this.assertActionCurrent(replaceCycle);
        if (!canRestartFromCurrent(this.store.cycle(replaceCycle.id))) throw new Error('已存在压缩操作记录，不能重新开始维护。');
        // Transfer the lock in the same transaction. No queued delivery can
        // run between retiring the stale cycle and creating its replacement.
        this.store.releaseCycle(replaceCycle.id, { cancel: true, releaseMessages: true });
        this.store.setSetting('cycle-tokens:' + replaceCycle.id, null);
      }
      const created = this.store.createCycle({ id, session: target, state, trigger: sample.decision.trigger,
        ...(replaceCycle ? { supersedesCycleId: replaceCycle.id } : {}),
        policy, wasWorkingAtTrigger: sample.decision.wasWorkingAtTrigger, quotaResumeHandoff: sample.decision.quotaResume === true, triggerRuntime: runtime, triggerUsage: sample.usage,
        originalTurnId: runtime.activeTurnId, contextEpoch: sample.usage.contextEpoch,
        handoffPath: join(target.cwd, '.plexus', 'handoffs', target.client, target.id, id + '.md'),
        receiptHashes: { handoff: receiptHash(stageTokens.handoff), restored: receiptHash(stageTokens.restored) },
        deadlineAt: deadline(stageTimeout[state]), controlDispatched: false });
      // Tokens are private to this local service, never returned by a management API.
      this.store.setSetting('cycle-tokens:' + id, stageTokens);
      if (replaceCycle) this.store.updateCycle(replaceCycle.id, 'cancelled', { supersededByCycleId: id,
        reason: '用户选择按当前进度继续维护，旧交付与回执已保留。' });
      return created;
    });
    this.onUpdate(target); await this.advance(cycle.id); return this.store.cycle(cycle.id);
  }
  advance(id) {
    if (this.running.has(id)) return this.running.get(id);
    const task = this.step(id).catch(error => {
      const cycle = this.store.cycle(id);
      if (cycle && !terminal.has(cycle.state)) this.attention(cycle, error.message, error.outcome || 'unknown');
    }).finally(() => this.running.delete(id));
    this.running.set(id, task); return task;
  }
  attention(cycle, reason, outcome = 'unknown') {
    this.store.updateCycle(cycle.id, 'needs_attention', { previousState: maintenanceStage(cycle), reason, lastAttemptOutcome: outcome }); this.onUpdate(cycle.session);
  }
  transition(cycle, state, patch = {}) {
    const updated = this.store.updateCycle(cycle.id, state, { deadlineAt: deadline(stageTimeout[state] || 60000), ...patch });
    this.onUpdate(cycle.session); return updated;
  }
  waitForClient(cycle, reason = '客户端暂不可用，等待重新连接后自动核对接续。') {
    if (cycle.state === 'waiting_client') {
      if (cycle.reason !== reason) { this.store.updateCycle(cycle.id, cycle.state, { reason }); this.onUpdate(cycle.session); }
      return;
    }
    this.store.updateCycle(cycle.id, 'waiting_client', { previousState: maintenanceStage(cycle), reason,
      disconnectedAt: new Date().toISOString(), remainingStageMs: Math.max(1000, Date.parse(cycle.deadlineAt) - Date.now()) || 1000 });
    this.onUpdate(cycle.session);
  }
  async recoverClient(cycle, sample) {
    const runtime = sample.runtime;
    if (runtime.activity !== 'idle') { this.waitForClient(cycle, '客户端已重连，等待当前轮次结束后核对接续。'); return; }
    if (missingSelection(cycle.triggerRuntime, runtime)) { this.waitForClient(cycle, '等待客户端同步原模型设置，再核对接续。'); return; }
    const blocked = reason => {
      const current = this.store.cycle(cycle.id);
      if (current?.revision !== cycle.revision) return;
      this.store.updateCycle(cycle.id, 'needs_attention', { previousState: maintenanceStage(cycle), reason, recoveryBlocked: true });
      this.onUpdate(cycle.session);
    };
    if ((cycle.session.client === 'opencode' ? runtime.sessionId !== cycle.session.id : runtime.sessionId?.toLowerCase() !== cycle.session.id.toLowerCase())
      || !runtime.cwd || normalizeDirectory(runtime.cwd) !== normalizeDirectory(cycle.session.cwd))
      return blocked('重连会话的 ID 或工作目录与原流程不一致。');
    if (runtime.queuedNativeInputs > 0 || runtime.backgroundTasks > 0 || hasPendingSubagents(runtime)
      || runtime.goalStatus === 'active' || runtime.pendingRequests > 0 || runtime.pendingClientControls > 0
      || runtime.pendingHostControls > 0 || runtime.unconfirmedSubmissions > 0 || runtime.capabilities?.automaticMaintenance === false)
      return blocked('重连后仍有原生队列、目标、权限请求或后台工作，需人工核对。');
    for (const field of ['model', 'agent']) {
      const current = field === 'model' ? runtime.model || sample.usage?.model : runtime[field];
      if (field === 'model' ? selectedModelChanged(cycle.triggerRuntime, runtime, cycle.session.client) : cycle.triggerRuntime[field] != null && (current != null || runtime.selectionKnown?.includes(field)) && current !== cycle.triggerRuntime[field])
        return blocked('重连后的模型或代理设置已改变，需人工核对。');
    }
    const evidence = await this.recoveryEvidence(cycle, sample, { root: this.root });
    if (evidence.cwd && normalizeDirectory(evidence.cwd) !== normalizeDirectory(cycle.session.cwd)) return blocked('原生历史工作目录与维护会话不一致。');
    const plan = restartPlan(cycle, evidence, { handoff: this.store.checkpoint(cycle.id, 'handoff'), restored: this.store.checkpoint(cycle.id, 'restored') });
    if (plan.action === 'wait') { this.waitForClient(cycle, plan.reason); return; }
    if (plan.action === 'attention') return blocked(plan.reason);
    if (cycle.documentHash) {
      try {
        const allowed = await realpath(cycle.session.cwd), filename = await realpath(cycle.handoffPath), rel = relative(allowed, filename);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)
          || createHash('sha256').update(await readFile(filename)).digest('hex') !== cycle.documentHash)
          return blocked('交付文档位置或内容已经变化，未自动接续。');
      } catch { return blocked('交付文档暂不可核对，未自动接续。'); }
    }
    // Recheck after disk reads so a new native turn or checkpoint cannot be overwritten.
    const now = await this.monitor.runtime(cycle.session).status(), current = this.store.cycle(cycle.id);
    if (this.closed || current?.revision !== cycle.revision || now.activity !== 'idle'
      || now.instanceId !== runtime.instanceId || now.activityRevision !== runtime.activityRevision
      || now.latestTurn?.id !== runtime.latestTurn?.id) return;
    const changed = runtime.instanceId !== cycle.triggerRuntime.instanceId;
    this.store.event('client_reconnected', { id: cycle.id, fromInstance: cycle.triggerRuntime.instanceId,
      toInstance: runtime.instanceId, stage: plan.stage, resending: plan.resending === true, source: evidence.source });
    this.transition(current, plan.stage, { ...plan.patch,
      ...(cycle.session.client === 'opencode' && evidence.compactCompleted ? { compactResult: runtime.lastCompaction } : {}),
      triggerRuntime: { ...cycle.triggerRuntime, instanceId: runtime.instanceId },
      recoveryBoundary: plan.endedControl ? { instanceId: runtime.instanceId, activityRevision: runtime.activityRevision, controlTurnId: cycle.controlTurnId } : null,
      recoveryCount: (cycle.recoveryCount || 0) + Number(changed), recoveryBlocked: false, disconnectedAt: null, reason: null,
      serviceRestartPending: false, reconnectedAt: new Date().toISOString() });
  }
  async recoverService(cycle, sample) {
    const runtime = sample.runtime, stage = maintenanceStage(cycle);
    if (missingSelection(cycle.triggerRuntime, runtime)) { this.waitForClient(cycle, '等待客户端同步原模型设置，再核对接续。'); return; }
    if (selectedModelChanged(cycle.triggerRuntime, runtime, cycle.session.client)
      || cycle.triggerRuntime.agent != null && runtime.agent != null && cycle.triggerRuntime.agent !== runtime.agent) {
      this.store.updateCycle(cycle.id, 'needs_attention', { previousState: stage, recoveryBlocked: true,
        reason: '重连后的模型或代理设置已改变，需人工核对。' }); return;
    }
    if (runtime.queuedNativeInputs || runtime.backgroundTasks || hasPendingSubagents(runtime) || runtime.goalStatus === 'active'
      || runtime.unconfirmedSubmissions || runtime.capabilities?.automaticMaintenance === false) return;
    if (active(runtime)) {
      const expected = stage === 'interrupting' ? cycle.originalTurnId : cycle.controlTurnId;
      if (runtime.activeTurnId !== expected || !expected) return;
      this.transition(cycle, stage, { serviceRestartPending: false, reason: null }); return;
    }
    if (runtime.activity !== 'idle') return;
    const head = runtime.latestTurn?.id || runtime.lastCompletedTurnId;
    // Reuse only confirmed native state. A service restart never authorizes a
    // duplicate prompt to the still-live instance when its receipt is missing.
    if (['writing_handoff', 'restoring'].includes(stage) && cycle.controlDispatched) {
      cycle = this.store.updateCycle(cycle.id, cycle.state, { serviceRestartPending: false });
      this.attention(cycle, '目标轮次已结束，但系统未收到阶段回执。请核对后重发当前阶段。', 'failed'); return;
    }
    const evidence = { verified: Boolean(head), lastInputId: head, source: 'same-instance-native-head',
      compactCompleted: cycle.session.client === 'claude' ? Boolean(completedClaudeCompaction(cycle, runtime))
        : cycle.session.client === 'opencode' ? Boolean(completedOpenCodeCompaction(cycle, runtime))
        : (await this.recoveryEvidence(cycle, sample, { root: this.root })).compactCompleted };
    const plan = restartPlan(cycle, evidence, { handoff: this.store.checkpoint(cycle.id, 'handoff'), restored: this.store.checkpoint(cycle.id, 'restored') });
    if (plan.action === 'wait') return;
    if (plan.action === 'attention') {
      this.store.updateCycle(cycle.id, 'needs_attention', { previousState: stage, recoveryBlocked: true, reason: plan.reason }); return;
    }
    if (cycle.documentHash) {
      try {
        const allowed = await realpath(cycle.session.cwd), file = await realpath(cycle.handoffPath), rel = relative(allowed, file);
        if (!rel || rel.startsWith('..') || isAbsolute(rel) || createHash('sha256').update(await readFile(file)).digest('hex') !== cycle.documentHash) throw Error('changed');
      } catch { this.store.updateCycle(cycle.id, 'needs_attention', { previousState: stage, recoveryBlocked: true, reason: '交付文档位置或内容已经变化，未自动接续。' }); return; }
    }
    const now = await this.monitor.runtime(cycle.session).status(), current = this.store.cycle(cycle.id);
    if (this.closed || current?.revision !== cycle.revision || now.instanceId !== runtime.instanceId
      || now.activityRevision !== runtime.activityRevision || now.activity !== 'idle') return;
    this.transition(cycle, plan.stage, { ...plan.patch, serviceRestartPending: false, reason: null });
  }
  async step(id) {
    let cycle = this.store.cycle(id);
    const watchQuota = c => confirmedCompactionFailure(c) || c.quotaWaiting;
    if (this.closed || !cycle || terminal.has(cycle.state) && !restartCandidate(cycle) && !watchQuota(cycle)) return;
    if (!(await readAccessPolicy()).permits(cycle.session.cwd)) return;
    if (!['codex', 'claude', 'opencode'].includes(cycle.session.client)) return this.attention(cycle, '此客户端的自动维护尚未开放。', 'not_submitted');
    if (cycle.state === 'waiting_client' || restartCandidate(cycle)) {
      if (Date.now() < (this.recoveryPollAt.get(id) || 0)) return;
      this.recoveryPollAt.set(id, Date.now() + 5000);
    }
    const sample = await this.monitor.sample(cycle.session);
    cycle = this.store.cycle(id);
    if (!cycle || terminal.has(cycle.state) && !restartCandidate(cycle) && !watchQuota(cycle)) return;
    const state = sample.runtime;
    if (watchQuota(cycle) && state.connected && ['claude', 'codex'].includes(cycle.session.client)) {
      if (!(Date.now() < Date.parse(cycle.maintenanceQuota?.nextCheckAt))) {
        let reading;
        try { reading = await this.quotaRecovery.read(cycle.session, this.monitor.runtime(cycle.session)); }
        catch { reading = { status: 'unknown', queriedAt: new Date().toISOString() }; }
        if (this.closed || this.store.cycle(id)?.revision !== cycle.revision) return;
        cycle = this.store.updateCycle(id, cycle.state, { maintenanceQuota: { ...reading, nextCheckAt: deadline(60000) } });
        this.onUpdate(cycle.session);
      }
      if (terminal.has(cycle.state)) return;
    }
    if (this.store.restartConfirmation?.blocks(cycle.session)) return;
    if (accountQuotaBlocked(state) && !active(state) && !state.quota) {
      if (!terminal.has(cycle.state)) this.store.updateCycle(id, cycle.state, {
        accountQuotaWaiting: true, deadlineAt: deadline(stageTimeout[cycle.state] || 60000) });
      return;
    }
    if (cycle.accountQuotaWaiting) cycle = this.store.updateCycle(id, cycle.state, { accountQuotaWaiting: false });
    if (state.requiresReopen) {
      this.store.updateCycle(id, 'needs_attention', { previousState: maintenanceStage(cycle), recoveryBlocked: true, reason: state.detail });
      this.onUpdate(cycle.session); return;
    }
    if (state.connected && missingSelection(cycle.triggerRuntime, state)) { this.waitForClient(cycle, '正在同步当前模型设置，再核对接续。'); return; }
    const quotaHandoff = cycle.quotaResumeHandoff && cycle.state === 'writing_handoff' && !cycle.controlDispatched;
    if ((state.quota || state.activity === 'quota_limited') && !quotaHandoff) {
      this.store.updateCycle(id, 'needs_attention', { previousState: maintenanceStage(cycle), recoveryBlocked: true,
        quotaWaiting: true,
        reason: '维护阶段因额度不足中断，已保留会话锁及排队消息；额度恢复后请核对当前阶段再继续。' });
      this.onUpdate(cycle.session); return;
    }
    if (!state.connected || ['offline','unloaded','initializing'].includes(state.activity)) { this.waitForClient(cycle); return; }
    if (state.activity === 'unknown') {
      if (cycle.state !== 'waiting_client' && Date.now() > Date.parse(cycle.deadlineAt)) this.attention(cycle, '维护阶段超时；会话锁及排队消息已保留。');
      return;
    }
    const adapter = this.monitor.runtime(cycle.session);
    if (cycle.triggerRuntime.instanceId !== state.instanceId) { await this.recoverClient(cycle, sample); return; }
    if (cycle.serviceRestartPending) { await this.recoverService(cycle, sample); return; }
    if (restartCandidate(cycle)) return; // Same live instance is not permission to resend a failed prompt.
    if (cycle.state === 'waiting_client') {
      // A transient disconnect from the same process needs no rebind or replay.
      this.transition(cycle, cycle.previousState, { reason: null, disconnectedAt: null,
        deadlineAt: deadline(cycle.remainingStageMs || stageTimeout[cycle.previousState] || 60000) }); return;
    }
    if (Date.now() > Date.parse(cycle.deadlineAt)) {
      const stillWorking = ['writing_handoff', 'restoring', 'awaiting_handoff_end', 'awaiting_restore_end'].includes(cycle.state)
        && cycle.controlDispatched && cycle.controlTurnId && active(state) && state.activeTurnId === cycle.controlTurnId;
      if (!stillWorking) return this.attention(cycle, '维护阶段超时；会话锁及排队消息已保留。');
      // A live original control turn can take longer than an arbitrary wall-clock
      // budget. Keep its receipt gate open, including native permission waits.
      cycle = this.store.updateCycle(id, cycle.state, { deadlineAt: deadline(60000), lastControlObservedAt: new Date().toISOString() });
    }
    if (cycle.session.client === 'opencode' && (!state.capabilities?.automaticMaintenance || state.reverted)) return this.attention(cycle, '原生维护状态无法确认或会话已回滚。');
    if (state.queuedNativeInputs > 0 || state.backgroundTasks > 0 || hasPendingSubagents(state)) return this.attention(cycle, '检测到原生队列、子agent或后台工作，停止自动推进。');
    if (selectedModelChanged(cycle.triggerRuntime, state, cycle.session.client)
      || cycle.session.client === 'opencode' && cycle.triggerRuntime.agent !== state.agent)
      return this.attention(cycle, '维护期间模型发生变化，请核对用户操作。');
    if (['writing_handoff', 'restoring', 'awaiting_handoff_end', 'awaiting_restore_end'].includes(cycle.state)
      && cycle.controlTurnId && active(state) && state.activeTurnId !== cycle.controlTurnId) {
      this.store.updateCycle(id, 'user_intervened', { previousState: cycle.state, reason: '检测到维护以外的新原生输入，已停止自动推进。' });
      this.onUpdate(cycle.session); return;
    }
    if (cycle.state === 'interrupting') {
      if (state.activity === 'idle') {
        if (cycle.session.client === 'opencode' && state.lastCompletedTurnId !== cycle.originalTurnId) return this.attention(cycle, '原业务轮次结束证据不匹配，停止维护。');
        return this.transition(cycle, 'writing_handoff', { controlDispatched: false });
      }
      if (cycle.interruptDispatched) return;
      if (state.activeTurnId !== cycle.originalTurnId) return this.attention(cycle, '目标已进入另一个业务轮次；旧中断请求未发送。', 'not_submitted');
      cycle = this.store.updateCycle(id, cycle.state, { interruptDispatched: true, interruptIntentAt: new Date().toISOString(), interruptRequestId: randomUUID() });
      const result = await adapter.interrupt(state, { requestId: cycle.interruptRequestId });
      this.store.updateCycle(id, cycle.state, { interruptResult: result });
      if (result.status !== 'acknowledged') this.attention(cycle, '原生中断未得到确定确认，未重试。', result.status === 'state_conflict' ? 'not_submitted' : 'unknown');
      return;
    }
    if (cycle.session.client === 'opencode') {
      const expectedHead = cycle.state === 'compacting' && !cycle.compactDispatched ? cycle.controlTurnId
        : cycle.state === 'restoring' && !cycle.controlDispatched ? cycle.retryHeadId || cycle.compactResult?.nativeMessageId
        : cycle.state === 'writing_handoff' && !cycle.controlDispatched ? cycle.retryHeadId || cycle.originalTurnId || cycle.triggerRuntime.latestTurn?.id : null;
      if (expectedHead && state.latestTurn?.id !== expectedHead) return this.attention(cycle, '检测到维护以外的新原生输入，停止自动推进。', 'not_submitted');
    }
    if (['writing_handoff', 'restoring'].includes(cycle.state)) {
      if (cycle.controlDispatched) {
        if (active(state) && cycle.controlTurnId && state.activeTurnId !== cycle.controlTurnId)
          this.attention(cycle, '检测到维护控制轮次以外的新输入，请核对原会话。');
        else if (state.activity === 'idle' && cycle.controlTurnId && (cycle.session.client === 'claude'
          ? state.lastCompletedTurnId === cycle.controlTurnId : state.latestTurn?.id === cycle.controlTurnId))
          this.attention(cycle, '目标轮次已结束，但系统未收到阶段回执。请检查目标会话中的权限或执行结果。', 'failed');
        return;
      }
      if (state.activity !== 'idle' && !(quotaHandoff && state.activity === 'quota_limited' && state.quota?.autoResume)) return this.attention(cycle, '交付或恢复提示发送前出现了新的业务轮次。', 'not_submitted');
      const stage = cycle.state === 'writing_handoff' ? 'handoff' : 'restored';
      let quota;
      if (quotaHandoff && state.quota) {
        quota = await this.quotaRecovery.read(cycle.session, adapter);
        if (this.closed || this.store.cycle(id)?.revision !== cycle.revision) return;
        if (!freshAvailableQuota(quota)) {
          this.store.updateCycle(id, 'needs_attention', { previousState: cycle.state, quotaWaiting: true,
            maintenanceQuota: { ...quota, nextCheckAt: deadline(60000) }, reason: '额度尚未确认恢复，已保留新交付流程和排队消息。' }); return;
        }
      }
      const tokens = this.store.getSetting('cycle-tokens:' + id);
      if (!tokens?.[stage]) return this.attention(cycle, '维护阶段凭证不可用。', 'not_submitted');
      const messageId = cycle.session.client === 'opencode' ? nativeMessageId() : null;
      const prompts = await readPromptSettings(this.root);
      const requestId = randomUUID(), token = randomBytes(24).toString('base64url');
      cycle = this.store.transaction(() => {
        this.store.setSetting('cycle-tokens:' + id, { ...tokens, [stage]: token });
        return this.store.updateCycle(id, cycle.state, { controlDispatched: true, controlTurnId: messageId || (cycle.session.client === 'claude' ? requestId : null),
          controlRequestId: requestId, receiptHashes: { ...cycle.receiptHashes, [stage]: receiptHash(token) },
          retryHeadId: null, recoveryBoundary: null, lastReceiptIssue: null, controlIntentAt: new Date().toISOString(), controlPromptRevision: prompts.revision });
      });
      const prompt = stage === 'handoff' ? handoffPrompt(this.root, cycle, token, prompts.values) : restorePrompt(this.root, cycle, token, prompts.values);
      const options = { requestId: cycle.controlRequestId, ...(messageId ? { messageId } : {}), ...(quota ? { quota } : {}) };
      const result = quotaHandoff && state.quota ? await adapter.resumeQuota(prompt, state, options) : await adapter.sendControl(prompt, state, options);
      const current = this.store.cycle(id);
      this.store.updateCycle(id, current.state, { controlTurnId: result.activeTurnId || result.requestId || current.controlTurnId, controlResult: result });
      const awaitingNativeReceipt = cycle.session.client === 'opencode' && result.status === 'unknown' && messageId;
      if (result.status !== 'submitted' && !awaitingNativeReceipt && !this.store.checkpoint(id, stage)) this.attention(current, '维护提示的投递结果未确认。', result.status === 'state_conflict' ? 'not_submitted' : 'unknown');
      return;
    }
    const endedControl = controlTurnEnded(cycle, state);
    if (cycle.state === 'awaiting_handoff_end') {
      if (!endedControl) return;
      return this.transition(cycle, 'compacting', { compactDispatched: false, preCompactEpoch: sample.usage?.contextEpoch });
    }
    if (cycle.state === 'compacting') {
      if (cycle.compactDispatched) {
        const claudeCompletion = cycle.session.client === 'claude' ? completedClaudeCompaction(cycle, state)
          : cycle.session.client === 'opencode' ? completedOpenCodeCompaction(cycle, state) : null;
        const finished = ['claude','opencode'].includes(cycle.session.client)
          ? Boolean(claudeCompletion)
          : sample.usage?.contextEpoch !== cycle.preCompactEpoch && Date.parse(sample.usage?.lastCompactionAt) >= Date.parse(cycle.compactIntentAt)
            && sample.usage.recordedTurnState === 'task_complete' && state.latestTurn?.itemTypes.includes('contextCompaction');
        if (finished && state.activity === 'idle') return this.transition(cycle, 'restoring', { controlDispatched: false, controlTurnId: null,
          ...(claudeCompletion ? { compactResult: claudeCompletion } : {}), compactCompletedAt: new Date().toISOString() });
        const lateResult = state.lastCompaction;
        if (['claude','opencode'].includes(cycle.session.client) && lateResult?.requestId === cycle.compactResult?.requestId
          && ['failed', 'not_compacted'].includes(lateResult?.status)) {
          this.store.updateCycle(id, cycle.state, { compactResult: lateResult });
          return this.attention(cycle, '原生压缩未成功完成。', 'failed');
        }
        return;
      }
      if (state.activity !== 'idle') return this.attention(cycle, '压缩前出现了新的原生输入。', 'not_submitted');
      cycle = this.store.updateCycle(id, cycle.state, { compactDispatched: true, compactIntentAt: new Date().toISOString(), compactRequestId: randomUUID() });
      const result = await adapter.compact(state, { requestId: cycle.compactRequestId });
      this.store.updateCycle(id, cycle.state, { compactResult: result });
      // The wrapper keeps observing an operation after its HTTP wait expires.
      // Keep polling that exact request; a timeout is not a compaction failure.
      const awaitingLateResult = ['claude','opencode'].includes(cycle.session.client) && result.status === 'unknown' && Boolean(result.requestId);
      if (!['completed', 'acknowledged'].includes(result.status) && !awaitingLateResult)
        this.attention(cycle, '原生压缩失败或结果不确定；没有重复压缩。', result.status === 'failed' ? 'failed' : 'unknown');
      return;
    }
    if (cycle.state === 'awaiting_restore_end') {
      if (!endedControl) return;
      const restorePercent = sample.usage?.contextWindowTokens > 0 ? sample.usage.usedTokens * 100 / sample.usage.contextWindowTokens : null;
      this.store.updateCycle(id, cycle.state, { restoreUsage: sample.usage, restoreOverThreshold: restorePercent !== null && restorePercent >= cycle.policy.softPercent });
      const resumeText = cycle.wasWorkingAtTrigger ? continuePrompt(cycle, (await readPromptSettings(this.root)).values) : null;
      this.store.releaseCycle(id, { resumeText });
      this.store.setSetting('cycle-tokens:' + id, null);
      await this.service.mailbox?.drain(sessionKey(cycle.session)); this.onUpdate(cycle.session);
    }
  }
  async cancel(id, releaseMessages) {
    const cycle = this.store.cycle(id); if (!cycle || ['completed', 'cancelled'].includes(cycle.state)) throw new Error('该流程已结束。');
    (await readAccessPolicy()).assert(cycle.session.cwd);
    if (this.running.has(id)) throw new Error('原生操作正在返回，请稍后取消。');
    this.store.releaseCycle(id, { cancel: true, releaseMessages }); this.store.setSetting('cycle-tokens:' + id, null);
    if (releaseMessages) await this.service.mailbox?.drain(sessionKey(cycle.session));
    this.onUpdate(cycle.session);
  }
  assertActionCurrent(cycle) {
    if (this.closed || this.running.has(cycle.id) || this.store.cycle(cycle.id)?.revision !== cycle.revision)
      throw new Error('流程在核对期间发生变化，请刷新后重试。');
    this.store.restartConfirmation?.assertAllowed(cycle.session);
  }
  async restartFromCurrent(id) {
    const cycle = this.store.cycle(id);
    if (!canRestartFromCurrent(cycle)) throw new Error('此阶段不能按当前进度重新开始；已发起的压缩必须先核对原结果。');
    this.store.restartConfirmation?.assertAllowed(cycle.session);
    (await readAccessPolicy()).assert(cycle.session.cwd);
    const sample = await this.monitor.sample(cycle.session), runtime = sample.runtime;
    this.assertActionCurrent(cycle);
    const quotaResume = runtime.activity === 'quota_limited' && runtime.quota?.autoResume === true;
    if (!runtime.connected || !['idle', ...(quotaResume ? ['quota_limited'] : [])].includes(runtime.activity) || runtime.activeTurnId) throw new Error('请等待原会话当前回复结束，再按当前进度继续维护。');
    if (runtime.requiresReopen || runtime.selectionPending || runtime.quotaRestart?.pending || !runtime.model)
      throw new Error(runtime.detail || '原会话已连接，模型设置仍未读取完成，请等待设置核对。');
    if (runtime.sessionId !== cycle.session.id || !runtime.cwd || normalizeDirectory(runtime.cwd) !== normalizeDirectory(cycle.session.cwd))
      throw new Error('当前原生会话或工作目录与维护目标不一致。');
    if (runtime.pendingRequests || runtime.unconfirmedSubmissions || runtime.pendingClientControls || runtime.pendingHostControls)
      throw new Error('原会话仍有待确认输入或权限请求，请处理完成后继续。');
    if (runtime.compactionRequestId || runtime.controlPending || runtime.lastCompaction?.requestId === cycle.compactRequestId && runtime.lastCompaction?.status === 'completed')
      throw new Error('原生压缩仍在进行或已经完成，请核对原结果。');
    if (confirmedCompactionFailure(cycle) || quotaResume) {
      const quota = await this.quotaRecovery.read(cycle.session, this.monitor.runtime(cycle.session));
      this.assertActionCurrent(cycle);
      if (!freshAvailableQuota(quota)) throw new Error(quota?.status === 'exhausted' ? '当前额度仍不足，系统会继续检测。' : '当前额度尚未确认可用，系统会继续检测。');
      const now = await this.monitor.runtime(cycle.session).status();
      this.assertActionCurrent(cycle);
      if (now.instanceId !== runtime.instanceId || now.activityRevision !== runtime.activityRevision || now.activity !== runtime.activity)
        throw new Error('核对额度期间原会话状态已改变，请刷新后继续。');
    }
    const policy = this.store.getPolicy(cycle.session) || cycle.policy;
    return this.trigger(cycle.session, policy, { ...sample, decision: { trigger: 'manual', wasWorkingAtTrigger: false, quotaResume } }, { replaceCycle: cycle });
  }
  async retry(id) {
    const cycle = this.store.cycle(id);
    if (cycle) this.store.restartConfirmation?.assertAllowed(cycle.session);
    const documentStage = ['writing_handoff', 'restoring'].includes(cycle?.previousState);
    if (cycle) (await readAccessPolicy()).assert(cycle.session.cwd);
    if (!['needs_attention', 'user_intervened'].includes(cycle?.state)
      || (!documentStage && !['not_submitted', 'failed'].includes(cycle.lastAttemptOutcome))) throw new Error('该操作结果仍不确定，不能自动重试。');
    const state = await this.monitor.runtime(cycle.session).status();
    this.assertActionCurrent(cycle);
    if (state.activity !== 'idle') throw new Error('请先确认原生会话处于空闲状态。');
    if (cycle.previousState === 'compacting' && cycle.compactResult?.boundary) throw new Error('已观察到原生压缩边界，不能直接重复压缩，请核对原会话。');
    if (documentStage && this.store.checkpoint(id, cycle.previousState === 'writing_handoff' ? 'handoff' : 'restored')) throw new Error('该阶段已有回执，请核对原生轮次结束状态。');
    this.transition(cycle, cycle.previousState, { controlDispatched: documentStage ? false : cycle.controlDispatched,
      controlTurnId: documentStage ? null : cycle.controlTurnId,
      compactDispatched: cycle.previousState === 'compacting' ? false : cycle.compactDispatched,
      interruptDispatched: cycle.previousState === 'interrupting' ? false : cycle.interruptDispatched,
      triggerRuntime: { ...cycle.triggerRuntime, instanceId: state.instanceId }, retryHeadId: state.latestTurn?.id,
      recoveryBlocked: false, recoveryBoundary: null, reason: null });
    await this.advance(id);
  }
  async reconcile(id) {
    const cycle = this.store.cycle(id);
    if (cycle) this.store.restartConfirmation?.assertAllowed(cycle.session);
    if (!cycle || !['needs_attention', 'user_intervened'].includes(cycle.state) || this.running.has(id)) throw new Error('该流程当前无需核对恢复。');
    (await readAccessPolicy()).assert(cycle.session.cwd);
    const sample = await this.monitor.sample(cycle.session), runtime = sample.runtime;
    this.assertActionCurrent(cycle);
    if (missingSelection(cycle.triggerRuntime, runtime)) throw new Error('当前模型设置尚未同步，请等待核对完成。');
    if (runtime.connected && runtime.activity === 'idle' && runtime.instanceId !== cycle.triggerRuntime.instanceId) {
      await this.recoverClient(cycle, sample); return;
    }
    if (!runtime.connected || runtime.instanceId !== cycle.triggerRuntime.instanceId) throw new Error('请先重新连接原来的会话，再检查并继续。');
    for (const field of ['model', 'agent']) {
      if (field === 'model' ? selectedModelChanged(cycle.triggerRuntime, runtime, cycle.session.client) : cycle.triggerRuntime[field] != null && (runtime[field] != null || runtime.selectionKnown?.includes(field)) && cycle.triggerRuntime[field] !== runtime[field]) throw new Error('原生模型或代理设置与触发时不一致。');
    }
    if (recoverableReceiptPause(cycle) && cycle.controlDispatched && cycle.controlTurnId === runtime.activeTurnId && active(runtime)
      && !runtime.quota && !runtime.requiresReopen && !runtime.queuedNativeInputs && !runtime.backgroundTasks && !hasPendingSubagents(runtime)
      && !runtime.unconfirmedSubmissions && ['writing_handoff', 'restoring'].includes(cycle.previousState)) {
      this.transition(cycle, cycle.previousState, { reason: null, recoveryBlocked: false, lastReceiptIssue: null });
      return; // Reopen the original turn's receipt gate; never send another prompt.
    }
    if (runtime.activity !== 'idle') throw new Error('原会话仍在处理其他工作，请等待当前回复结束后再检查。');
    const stage = cycle.previousState;
    const lastTurnId = cycle.session.client === 'claude' ? runtime.lastCompletedTurnId : runtime.latestTurn?.id;
    let next, patch = {};
    if (stage === 'compacting') {
      const complete = cycle.session.client === 'claude'
        ? Boolean(completedClaudeCompaction(cycle, runtime))
        : cycle.session.client === 'opencode' ? Boolean(completedOpenCodeCompaction(cycle, runtime))
        : (sample.usage?.contextEpoch !== cycle.preCompactEpoch
        && Date.parse(sample.usage?.lastCompactionAt) >= Date.parse(cycle.compactIntentAt)
        && sample.usage?.recordedTurnState === 'task_complete' && runtime.latestTurn?.itemTypes?.includes('contextCompaction'));
      if (!complete) throw new Error('没有足够的原生压缩完成证据，保持原锁且不重复压缩。');
      if (!this.store.checkpoint(id, 'handoff')) throw new Error('第一阶段回执缺失。');
      next = 'restoring'; patch = { controlDispatched: false, controlTurnId: null, compactCompletedAt: new Date().toISOString() };
    } else if (stage === 'interrupting') {
      if (lastTurnId !== cycle.originalTurnId) throw new Error('无法把当前空闲状态与原业务轮次对应。');
      next = 'writing_handoff'; patch = { controlDispatched: false, controlTurnId: null };
    } else if (['awaiting_handoff_end', 'awaiting_restore_end'].includes(stage)) {
      if (!controlTurnEnded(cycle, runtime) || !this.store.checkpoint(id, stage === 'awaiting_handoff_end' ? 'handoff' : 'restored')) throw new Error('回执或对应控制轮次尚未确认结束。');
      next = stage;
    } else throw new Error('该阶段需要回执；请在核对原会话后重新发送交付／恢复请求。');
    if (cycle.documentHash) {
      const allowed = await realpath(cycle.session.cwd), filename = await realpath(cycle.handoffPath), path = relative(allowed, filename);
      if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error('交付文档已不在原工作目录内。');
      if (createHash('sha256').update(await readFile(filename)).digest('hex') !== cycle.documentHash) throw new Error('交付文档内容已改变。');
    }
    const current = this.store.cycle(id);
    this.assertActionCurrent(cycle);
    this.store.event('cycle_reconciled', { id, previousState: stage, nextState: next, observedAt: sample.observedAt });
    this.transition(current, next, { ...patch, reason: null, reconciliationAt: new Date().toISOString() });
    await this.advance(id);
  }
  async close() {
    this.closed = true; this.quotaRecovery.close(); clearInterval(this.timer);
    await this.tickPromise; await this.recoveryPromise; await Promise.allSettled([...this.running.values()]); this.monitor.close();
  }
}
