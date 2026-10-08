// Synthetic notices are transport messages, not a user's model selection.
export function knownModel(value) {
  return typeof value === 'string' && value.trim() && !/^<[^>]+>$/.test(value.trim()) ? value : null;
}
export function modelChanged(before, after) {
  return Boolean(knownModel(before) && knownModel(after) && before !== after);
}
export function missingSelectedSettings(before, after) {
  return Boolean(after.selectionPending || ['model', 'agent']
    .some(key => before[key] != null && after[key] == null));
}

// Claude's response metadata reports the resolved model without the selection's
// context suffix. Two explicit native selections must still compare exactly.
export function selectedModelChanged(before, after, client) {
  if (!modelChanged(before?.model, after?.model)) return false;
  const explicit = r => ['native-settings', 'host-selection'].includes(r?.modelSelectionSource);
  return client !== 'claude' || explicit(before) && explicit(after)
    || before.model.replace(/\[1m\]$/, '') !== after.model.replace(/\[1m\]$/, '');
}
