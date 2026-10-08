import { StringDecoder } from 'node:string_decoder';
import { randomUUID } from 'node:crypto';
import { claudeQuotaEvent } from './quota-state.mjs';
import { knownModel, selectedModelChanged } from './model-identity.mjs';

export function launchOption(args, name) {
  const index = args.findIndex(arg => arg === name || arg.startsWith(name + '='));
  return index < 0 ? null : args[index] === name ? args[index + 1] ?? null : args[index].slice(name.length + 1);
}

// Observe framing without changing the bytes forwarded between the IDE and CLI.
export class JsonLineObserver {
  constructor(onMessage, maximum = 32 * 1024 * 1024) { this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.discarding = false; this.atBoundary = true; this.maximum = maximum; this.onMessage = onMessage; }
  push(chunk) {
    const text = this.decoder.write(chunk);
    this.atBoundary = chunk.length > 0 ? chunk[chunk.length - 1] === 10 : this.atBoundary;
    const parts = text.split('\n');
    for (let index = 0; index < parts.length; index++) {
      if (!this.discarding) this.buffer += parts[index];
      if (this.buffer.length > this.maximum) { this.buffer = ''; this.discarding = true; }
      if (index < parts.length - 1) {
        if (!this.discarding) { try { this.onMessage(JSON.parse(this.buffer)); } catch { /* Observing never changes the original transport. */ } }
        this.buffer = ''; this.discarding = false;
      }
    }
  }
}

export class ClaudeProtocolState {
  constructor(sessionId = null, launchArgs = []) {
    this.sessionId = sessionId; this.initialized = false; this.active = false; this.inputEnded = false;
    this.hostRequests = new Map(); this.childRequests = new Map(); this.userSequence = 0;
    this.lastResultAt = null; this.permissionMode = null; this.activityRevision = 0; this.activeTurnId = null;
    this.lastCompletedTurnId = null; this.queuedInputIds = []; this.model = null; this.effort = null;
    this.selectedModel = null; this.selectionRequests = new Map();
    this.capacities = new Map(); this.usage = null; this.contextEpoch = 0; this.backgroundTasks = new Set();
    this.quota = null; this.turnQuotaEvent = null; this.turnQuotaError = false; this.userStopped = false;
    this.expectedPeers = new Set();
    this.peerHolds = new Map(); this.lastPeerDelivery = null;
    this.lastObservedInputId = null; this.lastQuotaAssistantId = null;
    this.selectionKnown = new Set();
    this.selectionPending = false;
    // VS Code sends the initial permission selection as a CLI argument. The
    // system/init frame may not arrive until the first business prompt.
    for (let i = 0; i < launchArgs.length; i++) {
      const value = launchArgs[i] === '--permission-mode' ? launchArgs[i + 1]
        : launchArgs[i].startsWith('--permission-mode=') ? launchArgs[i].slice(18) : null;
      if (['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'].includes(value)) { this.permissionMode = value; this.selectionKnown.add('permissionMode'); }
    }
  }
  expectPeer(id) {
    if (!/^[0-9a-f-]{36}$/i.test(id || '')) throw Error('Invalid peer message ID.');
    if (this.expectedPeers.size >= 512 && !this.expectedPeers.has(id.toLowerCase())) throw Error('Peer observation queue is full.');
    const key = id.toLowerCase();
    if (!this.expectedPeers.has(key)) {
      this.expectedPeers.add(key); this.activityRevision++;
      this.lastPeerDelivery = { messageId: key, state: 'pending', observedAt: new Date().toISOString() };
    }
  }
  forgetPeer(id) {
    const key = id?.toLowerCase(); this.peerHolds.delete(key);
    if (this.expectedPeers.delete(key)) {
      this.activityRevision++;
      if (this.lastPeerDelivery?.messageId === key) this.lastPeerDelivery = { messageId: key, state: 'cancelled', observedAt: new Date().toISOString() };
    }
  }
  observePeerHold(message) {
    const id = message.message_uuid?.toLowerCase?.();
    if (message.lane !== 'socket' || !this.expectedPeers.has(id) || !['held', 'released', 'dropped'].includes(message.state)) return;
    const entry = { messageId: id, state: message.state, observedAt: new Date().toISOString() };
    const held = this.peerHolds.get(id);
    if (message.state === 'dropped' && held?.cause) { entry.cause = held.cause; entry.heldAt = held.observedAt; }
    if (message.state === 'held' && ['explicit-setting', 'managed-setting', 'repo-setting', 'invalid-setting', 'bypass-default', 'mode-unknown', 'mode-mismatch', 'no-mode-asserted'].includes(message.cause)) entry.cause = message.cause;
    if (message.state === 'dropped' && ['expired', 'refused', 'dropped', 'discarded'].includes(message.outcome)) entry.outcome = message.outcome;
    if (message.state === 'held') this.peerHolds.set(id, entry);
    else this.peerHolds.delete(id);
    if (message.state === 'dropped') this.forgetPeer(id);
    this.lastPeerDelivery = entry; this.activityRevision++;
  }
  begin(id) {
    if (!this.active) {
      this.quota = null; this.turnQuotaEvent = null; this.turnQuotaError = false;
      this.lastQuotaAssistantId = null;
      this.active = true; this.activeTurnId = id || this.queuedInputIds.shift() || `observed-${randomUUID()}`; this.activityRevision++;
    }
  }
  settleInput(id, started = false) {
    const index = this.queuedInputIds.indexOf(id);
    if (index < 0) return;
    this.queuedInputIds.splice(index, 1); this.activityRevision++;
    // A queued prompt may be folded into the current turn. It is not another
    // turn, and its terminal lifecycle alone is not a native result boundary.
    if (started && !this.active) this.begin(id);
  }
  host(message) {
    if (message.type === 'user') {
      this.quota = null;
      if (!this.active) this.userStopped = false;
      this.userSequence++;
      const id = message.uuid || `input-${this.userSequence}`;
      this.lastObservedInputId = id;
      if (this.active) {
        if (id !== this.activeTurnId && !this.queuedInputIds.includes(id)) { this.queuedInputIds.push(id); this.activityRevision++; }
      } else this.begin(id);
      if (this.usage) this.usage.historyChangedAfterMeasurement = true;
    }
    if (message.type === 'control_request' && message.request_id) {
      this.hostRequests.set(message.request_id, message.request?.subtype);
      if (message.request?.subtype === 'interrupt') { this.userStopped = true; if (this.quota) this.quota.autoResume = false; this.activityRevision++; }
      if (['set_model', 'set_permission_mode', 'apply_flag_settings'].includes(message.request?.subtype)) {
        if (this.quota && message.request.subtype === 'set_model') this.quota.autoResume = false; this.activityRevision++;
      }
      if (message.request?.subtype === 'set_model') this.selectionRequests.set(message.request_id, { model: knownModel(message.request.model) });
      if (message.request?.subtype === 'set_permission_mode' && typeof message.request.mode === 'string') this.selectionRequests.set(message.request_id, { permissionMode: message.request.mode });
    }
    if (message.type === 'control_response' && this.childRequests.delete(message.response?.request_id)) this.activityRevision++;
  }
  child(message) {
    if (message.parent_tool_use_id) return;
    if (this.sessionId && message.session_id && message.session_id.toLowerCase() !== this.sessionId) return;
    if (typeof message.session_id === 'string' && /^[0-9a-f-]{36}$/i.test(message.session_id)) this.sessionId = message.session_id.toLowerCase();
    if (message.type === 'system' && message.subtype === 'peer_message_hold') this.observePeerHold(message);
    if (message.type === 'command_lifecycle' && ['started', 'completed', 'cancelled', 'discarded', 'refused'].includes(message.state))
      this.settleInput(message.command_uuid, message.state === 'started');
    if (message.type === 'user' && message.isReplay === true && message.message?.role === 'user') this.settleInput(message.uuid, true);
    // A live peer arrives on the CLI's output stream, bypassing IDE stdin.
    // Only IDs registered by a current delivery can begin an observed turn;
    // historical replay by itself must never authorize an automatic wakeup.
    if (message.type === 'user' && message.origin?.kind === 'peer' && message.message?.role === 'user' && typeof message.uuid === 'string'
      && this.expectedPeers.has(message.uuid?.toLowerCase())) {
      this.forgetPeer(message.uuid);
      this.lastPeerDelivery = { messageId: message.uuid.toLowerCase(), state: 'received', observedAt: new Date().toISOString() };
      this.lastObservedInputId = message.uuid;
      if (!this.active) { this.quota = null; this.turnQuotaEvent = null; this.turnQuotaError = false; this.begin(message.uuid); }
      if (this.usage) this.usage.historyChangedAfterMeasurement = true;
    }
    if (message.type === 'control_response') {
      const id = message.response?.request_id;
      const subtype = this.hostRequests.get(id);
      if (subtype === 'initialize' && message.response?.subtype === 'success') { this.initialized = true; this.selectionPending = true; }
      if (['set_model', 'apply_flag_settings'].includes(subtype) && message.response?.subtype === 'success') {
        this.selectionPending = true; this.selectionKnown.delete('effort');
      }
      const selection = this.selectionRequests.get(id);
      if (selection && message.response?.subtype === 'success') {
        if (Object.hasOwn(selection, 'model')) {
          this.selectedModel = selection.model; this.model = selection.model; this.modelSelectionSource = 'host-selection';
          if (selection.model) this.selectionKnown.add('model'); else this.selectionKnown.delete('model');
        }
        if (selection.permissionMode) { this.permissionMode = selection.permissionMode; this.selectionKnown.add('permissionMode'); }
      }
      this.selectionRequests.delete(id);
      this.hostRequests.delete(id);
    }
    if (message.type === 'system' && message.subtype === 'init') {
      this.initialized = true;
      if (typeof message.permissionMode === 'string') { this.permissionMode = message.permissionMode; this.selectionKnown.add('permissionMode'); }
      const sameExplicitSelection = ['native-settings', 'host-selection'].includes(this.modelSelectionSource)
        && !selectedModelChanged(this, { model: message.model, modelSelectionSource: 'system-init' }, 'claude');
      if (knownModel(message.model) && !sameExplicitSelection) { this.selectedModel = message.model; this.model = message.model; this.modelSelectionSource = 'system-init'; this.selectionKnown.add('model'); }
    }
    if (message.type === 'control_request' && message.request_id) {
      this.childRequests.set(message.request_id, message.request?.subtype || 'unknown'); this.activityRevision++;
    }
    if (message.type === 'control_cancel_request' && this.childRequests.delete(message.request_id)) this.activityRevision++;
    if (['assistant', 'stream_event', 'tool_progress', 'tool_use_summary'].includes(message.type)
      || (message.type === 'system' && message.subtype === 'status' && message.status === 'compacting')) this.begin();
    if (message.type === 'rate_limit_event' && this.active) this.turnQuotaEvent = claudeQuotaEvent(message.rate_limit_info);
    if (message.type === 'assistant' && ['rate_limit', 'rate_limit_error'].includes(message.error)) {
      this.turnQuotaError = true; this.lastQuotaAssistantId = message.uuid || message.message?.id || null;
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') { this.contextEpoch++; this.usage = null; }
    if (message.type === 'system' && message.subtype === 'task_started') this.backgroundTasks.add(message.task_id);
    if (message.type === 'system' && message.subtype === 'task_notification') this.backgroundTasks.delete(message.task_id);
    const api = message.type === 'assistant' ? message.message : message.type === 'stream_event' && message.event?.type === 'message_start' ? message.event.message : null;
    if (api?.usage) this.observeApiUsage(api.model, api.usage);
    if (message.type === 'stream_event' && message.event?.type === 'message_delta' && this.usage?.source === 'claude-passive-api-usage'
      && Number.isFinite(message.event.usage?.output_tokens)) {
      this.usage.outputTokens = message.event.usage.output_tokens;
      this.usage.usedTokens = this.usage.inputTokens + this.usage.outputTokens;
      this.usage.measuredAt = new Date().toISOString(); this.applyCapacity();
    }
    if (message.type === 'result') {
      const limited = this.turnQuotaError || this.turnQuotaEvent?.status === 'rejected' && message.is_error === true;
      const knownWindow = this.turnQuotaEvent?.status === 'rejected' && ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'].includes(this.turnQuotaEvent.kind);
      this.quota = limited && this.activeTurnId ? { kind: knownWindow ? this.turnQuotaEvent.kind : 'unknown_rate_limit', source: 'claude-native-error',
        turnId: this.activeTurnId, resetsAt: this.turnQuotaEvent?.resetsAt || null, autoResume: Boolean(knownWindow && !this.userStopped) } : null;
      this.turnQuotaEvent = null; this.turnQuotaError = false;
      for (const [model, usage] of Object.entries(message.modelUsage || {})) {
        if (Number.isFinite(usage.contextWindow) && usage.contextWindow > 0) this.capacities.set(model, usage.contextWindow);
      }
      if (this.usage) this.applyCapacity();
      this.lastCompletedTurnId = this.activeTurnId; this.activeTurnId = null;
      this.active = false; this.activityRevision++; this.lastResultAt = new Date().toISOString();
      // Unacknowledged inputs keep controls blocked, but do not prove that a
      // second turn has started. Only native lifecycle/output can start it.
    }
  }
  observeApiUsage(model, usage) {
    if (!knownModel(model)) return;
    const values = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'].map(key => usage[key]);
    if (!values.every(n => Number.isFinite(n) && n >= 0)) return;
    if (!this.selectedModel) { this.model = model; this.modelSelectionSource = 'api-usage'; }
    const inputTokens = values.reduce((a, b) => a + b, 0), outputTokens = Number.isFinite(usage.output_tokens) ? usage.output_tokens : 0;
    this.usage = { source: 'claude-passive-api-usage', model, inputTokens, outputTokens, usedTokens: inputTokens + outputTokens,
      measuredAt: new Date().toISOString(), contextEpoch: this.contextEpoch, historyChangedAfterMeasurement: false };
    this.applyCapacity();
  }
  applyCapacity() {
    const capacity = this.capacities.get(this.usage.model) ?? null;
    this.usage.contextWindowTokens = capacity;
    this.usage.usedPercent = capacity ? Math.round(this.usage.usedTokens * 10000 / capacity) / 100 : null;
  }
  observeNativeUsage(usage) {
    if (usage.model && usage.contextWindowTokens > 0) this.capacities.set(usage.model, usage.contextWindowTokens);
    this.usage = { ...usage, measuredAt: usage.queriedAt, contextEpoch: this.contextEpoch, historyChangedAfterMeasurement: false };
  }
  observeNativeSelection(selection) {
    if (!knownModel(selection?.model)) return false;
    if (this.quota && selectedModelChanged(this, { ...selection, modelSelectionSource: 'native-settings' }, 'claude')) this.quota.autoResume = false;
    let changed = this.selectionPending || this.model !== selection.model;
    this.selectedModel = selection.model; this.model = selection.model;
    this.modelSelectionSource = 'native-settings';
    this.selectionPending = false;
    this.selectionKnown.add('model');
    if (Object.hasOwn(selection, 'effort')) { changed ||= this.effort !== selection.effort; this.effort = selection.effort; this.selectionKnown.add('effort'); }
    if (changed) this.activityRevision++;
    return true;
  }
  activity() {
    if (this.inputEnded) return 'offline';
    if (!this.initialized) return 'initializing';
    const requests = [...this.childRequests.values()];
    if (requests.includes('can_use_tool')) return 'waiting_permission';
    if (requests.includes('request_user_dialog')) return 'waiting_input';
    if (requests.length || this.hostRequests.size) return 'unknown';
    return this.active ? 'running' : this.quota ? 'quota_limited' : this.expectedPeers.size || this.queuedInputIds.length ? 'unknown' : 'idle';
  }
  canReadQuota(atBoundary = true) { return this.initialized && this.sessionId && !this.inputEnded && this.hostRequests.size === 0 && this.childRequests.size === 0 && atBoundary; }
  canQuery(atBoundary = true) { return this.initialized && this.sessionId && !this.active && !this.inputEnded && this.hostRequests.size === 0 && this.childRequests.size === 0 && !this.queuedInputIds.length && !this.backgroundTasks.size && atBoundary; }
  canCompact(atBoundary = true) { return !this.selectionPending && !this.quota && !this.expectedPeers.size && this.canQuery(atBoundary); }
  publicState() { return { sessionId: this.sessionId, initialized: this.initialized, busy: this.active,
    activity: this.activity(), activityRevision: this.activityRevision, activeTurnId: this.activeTurnId, turnIdSource: 'wrapper-observed-input',
    lastCompletedTurnId: this.lastCompletedTurnId, queuedNativeInputs: this.queuedInputIds.length, backgroundTasks: this.backgroundTasks.size,
    lastObservedInputId: this.lastObservedInputId,
    pendingHostControls: this.hostRequests.size, pendingClientControls: this.childRequests.size,
    inputEnded: this.inputEnded, lastResultAt: this.lastResultAt, permissionMode: this.permissionMode, model: this.model, effort: this.effort,
    modelSelectionSource: this.modelSelectionSource, selectionKnown: [...this.selectionKnown], selectionPending: this.selectionPending,
    pendingPeerMessages: this.expectedPeers.size, peerDelivery: this.peerHolds.values().next().value || this.lastPeerDelivery,
    userStopped: this.userStopped, quota: this.quota, usage: this.usage }; }
}
