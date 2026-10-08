import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedModelChanged } from '../src/model-identity.mjs';
import { ClaudeRuntime } from '../src/runtime/claude-runtime.mjs';

test('Claude resolved response names match context-suffixed selections, while explicit context-window changes remain changes', () => {
  const selected = { model: 'claude-opus-5-5[1m]', modelSelectionSource: 'native-settings' };
  for (const source of [undefined, 'api-usage', 'system-init'])
    assert.equal(selectedModelChanged({ model: 'claude-opus-5-5', modelSelectionSource: source }, selected, 'claude'), false);
  assert.equal(selectedModelChanged({ model: 'claude-opus-5-5', modelSelectionSource: 'host-selection' }, selected, 'claude'), true);
  assert.equal(selectedModelChanged({ model: 'claude-opus-5-5' }, { ...selected, model: 'claude-sonnet-5[1m]' }, 'claude'), true);
  assert.equal(selectedModelChanged({ model: 'claude-opus-5-5' }, selected, 'codex'), true);
});

test('a connected legacy wrapper with missing restart settings asks for one upgrade instead of waiting forever', async () => {
  const id = '11111111-1111-4111-8111-111111111111', runtime = new ClaudeRuntime(id);
  const state = { instanceId: 'fixture', sessionId: id, connected: true, initialized: true, model: null,
    capabilities: { quotaRecovery: true, peerQuotaRecovery: true, inputLifecycle: true, restartSelection: true } };
  runtime.record = { instanceId: state.instanceId }; runtime.request = async () => structuredClone(state);
  assert.equal((await runtime.status()).requiresReopen, true);
  state.model = 'model'; assert.equal((await runtime.status()).requiresReopen, true);
  state.quotaRestart = { pending: true, missingFields: ['effort'] }; assert.equal((await runtime.status()).requiresReopen, true);
  state.model = null; state.capabilities.restartSelectionV2 = true; state.capabilities.selectionRefresh = true;
  assert.equal((await runtime.status()).requiresReopen, false);
});
