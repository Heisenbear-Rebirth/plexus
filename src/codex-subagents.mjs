const terminal = new Set(['completed', 'failed', 'errored', 'shutdown', 'closed', 'interrupted', 'cancelled']);
const agentItem = item => ['subAgentActivity', 'collabAgentToolCall'].includes(item?.type);
const timeOf = turn => {
  const value = turn?.startedAt ?? turn?.createdAt ?? turn?.started_at;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};
function statusOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.status === 'string') return value.status;
  return value && typeof value === 'object' ? [...terminal].find(key => Object.hasOwn(value, key)) : undefined;
}

// Historical collaboration calls are not a live job list. Retain the history
// fact, and separately track native lifecycle completion for each known agent.
export function codexSubagentActivity(canonical, legacy = []) {
  const ids = new Set(canonical.map(turn => turn.turnId));
  const extra = legacy.filter(turn => !ids.has(turn.turnId));
  let turns = canonical.length ? [...canonical, ...extra] : legacy;
  const mixed = canonical.length > 0 && extra.some(turn => turn.items?.some(agentItem));
  let uncertain = false;
  if (mixed) {
    if (turns.every(turn => timeOf(turn) !== null)) turns = turns.toSorted((a, b) => timeOf(a) - timeOf(b));
    else uncertain = true; // Do not guess ordering across incomplete histories.
  }
  const agents = new Map(), seen = new Set(); let history = false, pendingControls = 0;
  for (const turn of turns) for (const item of turn.items || []) {
    if (!agentItem(item) || item.id && seen.has(item.id)) continue;
    if (item.id) seen.add(item.id);
    history = true;
    if (item.type === 'subAgentActivity') {
      if (typeof item.agentThreadId !== 'string' || !item.agentThreadId) { uncertain = true; continue; }
      if (terminal.has(item.kind)) agents.set(item.agentThreadId, false);
      else { agents.set(item.agentThreadId, true); if (!['started', 'interacted'].includes(item.kind)) uncertain = true; }
      continue;
    }
    const ended = terminal.has(item.status);
    if (!ended) pendingControls++;
    const tool = String(item.tool || '').replace(/[_-]/g, '').toLowerCase();
    const recipients = new Set((item.receiverThreadIds || []).filter(id => typeof id === 'string' && id));
    const states = item.agentsStates && typeof item.agentsStates === 'object' ? Object.entries(item.agentsStates) : [];
    for (const [id] of states) recipients.add(id);
    const startsWork = ['spawnagent', 'spawn', 'sendinput', 'sendmessage', 'resumeagent', 'resume', 'followuptask'].includes(tool);
    if (!startsWork && !['wait', 'closeagent', 'close'].includes(tool)) uncertain = true;
    if (startsWork && item.status === 'completed' && !recipients.size) uncertain = true;
    for (const id of recipients) {
      if (startsWork || !agents.has(id)) agents.set(id, true);
      if (['closeagent', 'close'].includes(tool) && item.status === 'completed') agents.set(id, false);
    }
    for (const [id, status] of states) agents.set(id, !terminal.has(statusOf(status)));
  }
  const pending = [...agents].filter(([, active]) => active).map(([id]) => id);
  return { subagentHistoryPresent: history, subagentWorkPending: uncertain || pendingControls > 0 || pending.length > 0,
    subagentActivity: { knownAgents: agents.size, pendingAgents: pending.length, pendingControls, uncertain,
      pendingThreadIds: pending.slice(0, 64) } };
}

// Older adapters (including OpenCode) retain their existing conservative gate.
export const hasPendingSubagents = runtime => typeof runtime?.subagentWorkPending === 'boolean'
  ? runtime.subagentWorkPending : Boolean(runtime?.subagentHistoryPresent);
