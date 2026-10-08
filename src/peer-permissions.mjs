import { normalizeDirectory } from './directory-service.mjs';

export function codexPeerPermissionClass(permissions) {
  if (!['never', 'on-request'].includes(permissions?.approvalPolicy)) return null;
  if (permissions.sandboxPolicy?.type === 'dangerFullAccess' && permissions.approvalPolicy === 'never') return 'bypass';
  if (['workspaceWrite', 'readOnly'].includes(permissions.sandboxPolicy?.type)) return 'prompting';
  return null;
}

export function openCodePeerPermissionClass(agentRules, sessionRules = []) {
  if (!Array.isArray(agentRules) || !Array.isArray(sessionRules)) return null;
  const rules = [...agentRules, ...sessionRules];
  if (rules.some(r => !r || typeof r.permission !== 'string' || typeof r.pattern !== 'string' || !['allow', 'ask', 'deny'].includes(r.action))) return null;
  // Native rules use the last matching entry. Only an explicit complete rule
  // set can establish bypass; an empty override list is not that evidence.
  const baseline = rules.findLastIndex(r => r.permission === '*' && r.pattern === '*');
  if (baseline < 0) return null;
  return rules.slice(baseline).every(r => r.action === 'allow') ? 'bypass' : 'prompting';
}

export function senderPeerPermissionClass(session, runtime) {
  if (!runtime?.connected || !runtime.sessionId || !session.id || runtime.sessionId.toLowerCase() !== session.id.toLowerCase()
    || !runtime.cwd || !session.cwd || normalizeDirectory(runtime.cwd) !== normalizeDirectory(session.cwd)) return null;
  if (session.client === 'codex') return ['bypass', 'prompting'].includes(runtime.peerPermissionClass) ? runtime.peerPermissionClass : null;
  if (session.client === 'claude') {
    if (runtime.permissionMode === 'bypassPermissions') return 'bypass';
    if (['default', 'acceptEdits', 'auto', 'dontAsk'].includes(runtime.permissionMode)) return 'prompting';
  }
  if (session.client === 'opencode' && runtime.capabilities?.peerPermissionSelection === true)
    return ['bypass', 'prompting'].includes(runtime.peerPermissionClass) ? runtime.peerPermissionClass : null;
  return null;
}

export function claudePeerEnvelope(text, permissionClass) {
  // Socket ingress reads from-mode from its native envelope, not from a
  // top-level fromMode field (that field is reserved for host stdin).
  const mode = ['bypass', 'prompting'].includes(permissionClass) ? ` from-mode="${permissionClass}"` : '';
  // Keep payloads inside our envelope, including quoted peer envelopes. The
  // native parser uses the same backslash escape for reserved closing tags.
  const body = text.replace(/<(?=[\s\p{Cf}]*\/[\s\p{Cf}]*cross-session-message\b)/giu, '<\\');
  return `<cross-session-message${mode}>\n${body}\n</cross-session-message>`;
}
