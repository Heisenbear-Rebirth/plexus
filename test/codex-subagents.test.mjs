import test from 'node:test';
import assert from 'node:assert/strict';
import { codexSubagentActivity, hasPendingSubagents } from '../src/codex-subagents.mjs';
const event = (id, agentThreadId, kind) => ({ id, type: 'subAgentActivity', agentThreadId, kind });
const turn = (turnId, items, startedAt = 1) => ({ turnId, items, startedAt });

test('completed agent lifecycles and historical empty waits do not block later work', () => {
  const items = [];
  for (let i = 0; i < 19; i++) items.push(event('start'+i, 'agent'+i, 'started'), event('done'+i, 'agent'+i, 'completed'));
  for (let i = 0; i < 47; i++) items.push({ id: 'wait'+i, type: 'collabAgentToolCall', tool: 'wait', status: 'completed', receiverThreadIds: [], agentsStates: {} });
  const r = codexSubagentActivity([turn('old', items), turn('quota-failed', [], 2)]);
  assert.equal(r.subagentHistoryPresent, true); assert.equal(r.subagentWorkPending, false);
  assert.equal(r.subagentActivity.knownAgents, 19); assert.equal(r.subagentActivity.pendingAgents, 0);
});
test('unfinished and newly interacted agents remain pending until native completion', () => {
  const items = [event('start','agent','started'),event('done','agent','completed'),event('followup','agent','interacted')];
  assert.equal(codexSubagentActivity([turn('t',items)]).subagentWorkPending,true);
  items.push(event('done-again','agent','completed'));
  assert.equal(codexSubagentActivity([turn('t',items)]).subagentWorkPending,false);
});
test('a completed spawn or wait call is not itself proof that the child finished', () => {
  const items = [{id:'spawn',type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',receiverThreadIds:['agent']}];
  items.push({id:'wait',type:'collabAgentToolCall',tool:'wait',status:'completed',receiverThreadIds:['agent'],agentsStates:{}});
  assert.equal(codexSubagentActivity([turn('t',items)]).subagentWorkPending,true);
  items.push({id:'wait-done',type:'collabAgentToolCall',tool:'wait',status:'completed',receiverThreadIds:['agent'],agentsStates:{agent:{completed:'private result text'}}});
  const r=codexSubagentActivity([turn('t',items)]);assert.equal(r.subagentWorkPending,false);assert.doesNotMatch(JSON.stringify(r),/private/);
});
test('live control calls and incomplete spawn metadata remain blocked', () => {
  for(const item of [{type:'collabAgentToolCall',tool:'wait',status:'inProgress',receiverThreadIds:[]},
    {type:'collabAgentToolCall',tool:'spawnAgent',status:'completed',receiverThreadIds:[]},
    {type:'collabAgentToolCall',tool:'unknown-future-tool',status:'completed',receiverThreadIds:[]},event('invalid',null,'started')])
    assert.equal(codexSubagentActivity([turn('t',[item])]).subagentWorkPending,true);
});
test('duplicate histories do not resurrect an old start, while ambiguous extra history stays unverified', () => {
  const canonical=[turn('t',[event('start','agent','started'),event('done','agent','completed')])];
  assert.equal(codexSubagentActivity(canonical,[turn('t',[event('start','agent','started')])]).subagentWorkPending,false);
  const extra=turn('earlier',[event('earlier-start','agent','started')],0);
  assert.equal(codexSubagentActivity(canonical,[extra]).subagentWorkPending,false);
  delete extra.startedAt;assert.equal(codexSubagentActivity(canonical,[extra]).subagentActivity.uncertain,true);
});
test('legacy adapters keep their conservative subagent gate',()=>{
  assert.equal(hasPendingSubagents({subagentHistoryPresent:true}),true);
  assert.equal(hasPendingSubagents({subagentHistoryPresent:true,subagentWorkPending:false}),false);
});
