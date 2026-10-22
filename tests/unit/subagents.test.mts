import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, getCurrentTools } from '@earendil-works/pi-ai';
import type { RuntimeRecord } from '@mira/context';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { SubagentError, emptySubagentActivity, type SubagentActivityInput, type SubagentWriter, type SubagentRecord, type SubagentSpec, type SubagentResult, type SubagentFollowupReceipt, type TaskInputWriter, type TaskTurnState, type ToolIntent, type LifeEvent, type WakeReceipt } from '@mira/life';
import { PiDurableRuntime, freezeSubagentContext, encodeEntry, decodeRecords, type PiRuntimeActivity } from '@mira/runtime-pi';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { MemoryWriter, assistant, streamOf, model, deferred, seed, input, effectTool, result } from '../recovery/fixtures.mts';

/** Only test storage; production never uses an in-memory fallback. */
class Parent extends MemoryWriter implements SubagentWriter {
  children: SubagentRecord[] = [];
  events: LifeEvent[] = [];
  links = new Map<string, { inputRecordId: string | null; finalRecordId: string | null }>();
  followups = new Map<string, SubagentFollowupReceipt & { turnId: string }>();
  async createSubagent(callId: string, spec: SubagentSpec, max: number) {
    const old = this.children.find(c => c.spawnCallId === callId); if (old) return structuredClone(old);
    if (this.children.filter(c => c.turns.some(t => ['queued','running'].includes(t.status))).length >= max) throw new SubagentError('capacity', 'full');
    const id = randomUUID(); const createdAt = new Date().toISOString();
    const child: SubagentRecord = { id, streamId: `subagent:${id}`, spawnCallId: callId, createdAt, spec: structuredClone(spec), turnCount: 1, turns: [
      { id: randomUUID(), childId: id, callId, sequence: 1, instruction: spec.task, status: 'queued', createdAt, startedAt: null, activity: emptySubagentActivity(), finishedAt: null, result: null },
    ] }; this.children.push(child); this.links.set(child.turns[0]!.id, { inputRecordId: null, finalRecordId: null }); return structuredClone(child);
  }
  async listSubagents(before?: string) {
    const end = before ? this.children.findIndex(c => c.id === before) : this.children.length;
    const page = this.children.slice(Math.max(0,end-50),end);
    return { children: page.map(c => ({ id: c.id, createdAt: c.createdAt, model: c.spec.model, status: c.turns.at(-1)!.status })), nextCursor: end>50 ? page[0]!.id : null };
  }
  async findSubagentCall(callId: string) {
    const followup = this.followups.get(callId);
    for (const child of this.children) {
      const turn = child.turns.find(t => t.callId === callId || t.id === followup?.turnId);
      if (turn) return structuredClone({ child, turn, ...(followup ? { followup } : {}) });
    }
    return null;
  }
  async readSubagentCalls(callIds: string[]) { return this.children.flatMap(c => c.turns.filter(t => callIds.includes(t.callId)).map(t => ({ callId:t.callId,runId:null,childId:c.id,streamId:c.streamId,turnId:t.id,createdAt:t.createdAt,status:t.status }))); }
  async getSubagentForRun(id: string, _runId: string) { return this.getSubagent(id); }
  async readSubagentsForRun(_runId: string, before?: string) { return this.listSubagents(before); }
  async recordSubagentActivity(id: string, input: SubagentActivityInput) {
    const turn = this.children.flatMap(child => child.turns).find(turn => turn.id === id)!;
    if (turn.status !== 'running') return;
    const activity = turn.activity;
    const { callId, ...publicInput } = structuredClone(input);
    const event = { ...publicInput, toolHistoryId: callId ? randomUUID() : null, sequence: activity.dropped + activity.events.length + 1 };
    if (event.phase === 'started') activity.current = event;
    if (event.phase === 'finished') activity.current = null;
    activity.events.push(event); if (activity.events.length > 40) { activity.events.shift(); activity.dropped++; }
    activity.updatedAt = event.occurredAt;
  }
  async getSubagent(id: string) { return structuredClone(this.children.find(c => c.id === id) ?? null); }
  async sendSubagent(callId: string, id: string, instruction: string, _max: number) {
    const c = this.children.find(c => c.id === id)!;
    const previous = await this.findSubagentCall(callId);
    if (previous) {
      assert.equal(previous.child.id, id); assert.equal(previous.followup?.instruction ?? previous.turn.instruction, instruction);
      return structuredClone(c);
    }
    const running = c.turns.find(t => ['queued','running'].includes(t.status) && !this.links.get(t.id)!.finalRecordId);
    if (running) this.followups.set(callId, { turnId: running.id, callId, instruction, status: 'pending', createdAt: new Date().toISOString(), inputRecordId: null });
    else {
      const turnId = randomUUID();
      c.turns.push({ id: turnId, childId: id, callId, sequence: c.turns.length + 1, instruction, status: 'queued', createdAt: new Date().toISOString(), startedAt: null, activity: emptySubagentActivity(), finishedAt: null, result: null });
      this.links.set(turnId, { inputRecordId: null, finalRecordId: null });
    }
    c.turnCount = c.turns.length;
    return structuredClone(c);
  }
  async claimSubagentTurn(id: string) { const t = this.children.find(c => c.id === id)!.turns.find(t => t.status === 'queued'); if (!t) return null; t.status = 'running'; t.startedAt = new Date().toISOString(); return structuredClone(t); }
  async finishSubagentTurn(id: string, status: 'completed' | 'interrupted' | 'cancelled' | 'failed', value: SubagentResult) {
    const t = this.children.flatMap(c => c.turns).find(t => t.id === id)!;
    if (!['queued', 'running'].includes(t.status)) { assert.equal(t.status, status); assert.deepEqual(t.result, value); return; }
    for (const followup of this.followups.values()) if (followup.turnId === id && followup.status === 'pending') {
      assert.notEqual(status, 'completed', 'completion cannot overtake pending parent input'); followup.status = status as 'interrupted' | 'cancelled' | 'failed';
    }
    t.activity.current = null; t.status = status; t.result = structuredClone(value); t.finishedAt = new Date().toISOString();
    this.events.push({ id: `subagent-result:${id}`, type: 'subagent.result', source: 'system', occurredAt: t.finishedAt, payload: { childId: t.childId, status } });
  }
  async cancelSubagent(id: string) { for (const t of this.children.find(c => c.id === id)!.turns) if (['queued','running'].includes(t.status)) await this.finishSubagentTurn(t.id, 'cancelled', { text: 'Cancelled; effects may be unknown', truncated: false, fullResultPath: null, finalRecordId: null }); }
  async interruptSubagents() { for (const c of this.children) for (const t of c.turns) if (['queued','running'].includes(t.status)) await this.finishSubagentTurn(t.id, 'interrupted', { text: 'Interrupted without replay', truncated: false, fullResultPath: null, finalRecordId: null }); }
  override async receive(event: LifeEvent, _wake?: WakeReceipt): Promise<'inserted'> { this.events.push(event); return 'inserted'; }
}
/** Shared registry/transcript links model admission; no PostgreSQL locking is implied. */
class ChildWriter extends MemoryWriter implements TaskInputWriter {
  readonly parent: Parent;
  readonly streamId: string;
  constructor(parent: Parent, streamId: string) { super(); this.parent = parent; this.streamId = streamId; }
  private turn(id: string) {
    const child = this.parent.children.find(child => child.streamId === this.streamId)!;
    const turn = child.turns.find(turn => turn.id === id)!; assert.ok(turn);
    return turn;
  }
  private active(id: string) {
    const turn = this.turn(id); this.assertActive(); assert.equal(turn.status, 'running');
    assert.equal(this.parent.links.get(id)!.finalRecordId, null);
  }
  async loadTaskTurn(id: string): Promise<TaskTurnState> {
    const turn = this.turn(id);
    return structuredClone({ id, callId: turn.callId, createdAt: turn.createdAt, status: turn.status, ...this.parent.links.get(id)! });
  }
  async loadTaskInputs(id: string) {
    this.turn(id);
    return [...this.parent.followups.values()].filter(input => input.turnId === id && ['pending', 'consumed'].includes(input.status))
      .map(({ callId, instruction, createdAt, inputRecordId }) => ({ callId, instruction, createdAt, inputRecordId }));
  }
  async appendTaskInput(id: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    this.active(id); assert.equal(this.parent.links.get(id)!.inputRecordId, null);
    const next = await this.append(version, record, signal); this.parent.links.get(id)!.inputRecordId = record.id; return next;
  }
  async appendTaskLiveInput(id: string, callId: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    this.active(id);
    const first = [...this.parent.followups.values()].find(input => input.turnId === id && input.status === 'pending')!;
    assert.equal(first.callId, callId);
    const next = await this.append(version, record, signal); first.inputRecordId = record.id; first.status = 'consumed'; return next;
  }
  async tryBeginTaskTool(id: string, version: number, intent: ToolIntent) {
    this.active(id); if ((await this.loadTaskInputs(id)).some(input => !input.inputRecordId)) return false;
    await this.beginTool(version, intent); return true;
  }
  async tryAppendTaskFinal(id: string, version: number, record: RuntimeRecord, signal?: AbortSignal) {
    this.active(id); if ((await this.loadTaskInputs(id)).some(input => !input.inputRecordId)) return null;
    const next = await this.append(version, record, signal); this.parent.links.get(id)!.finalRecordId = record.id; return next;
  }
}
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 3000; while (!await check()) { if (Date.now() > end) throw Error('Condition did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function fixture(parent = new Parent(), tools = () => [] as ReturnType<typeof createSubagentTools>, maxConcurrent?: number) {
  const writers = new Map<string, ChildWriter>(); const errors: unknown[] = []; const spooled: string[] = []; let notifications = 0;
  const manager = new SubagentManager({ writer: parent, ...(maxConcurrent === undefined ? {} : { maxConcurrent }), acquire: async id => {
    let writer = writers.get(id);
    if (!writer || writer.signal.aborted) { const next = new ChildWriter(parent, id); if (writer) next.state = structuredClone(writer.state); writer = next; writers.set(id, writer); }
    return writer;
  }, tools, writeOverflowInput: async (_id, content) => { spooled.push(content); return { path: '/tmp/synthetic-full-result.txt', bytes: Buffer.byteLength(content) }; }, memoryRoot: '/tmp/synthetic-main-Memory', onCompletion: () => { notifications++; }, onFailure: error => errors.push(error) });
  return { manager, parent, writers, errors, spooled, notifications: () => notifications };
}
const transport = (streamFn: StreamFn) => ({ model, streamFn });
const isChild = (messages: Parameters<StreamFn>[1]['messages']) => getSystemMessageText(getCurrentSystemMessage(messages)!).includes('task-scoped worker');

test('actual Pi parent continues while isolated child runs; asynchronous result and followup persist without parent context writes', async () => {
  const f = fixture(); const release = deferred(); let childCalls = 0; let mainCalls = 0;
  const stream: StreamFn = (_m, context) => {
    if (isChild(context.messages)) {
      assert.ok(!getSystemMessageText(getCurrentSystemMessage(context.messages)!).includes('<delegation>'));
      childCalls++;
      assert.ok(!getCurrentTools(context.messages).some(t => t.name.startsWith('subagent_') || t.name === 'send_attachment'));
      if (childCalls === 1) return (async () => { await release.promise; return streamOf(assistant('worker result')); })();
      assert.ok(JSON.stringify(context.messages).includes('worker result'));
      return streamOf(assistant('followup result'));
    }
    mainCalls++;
    if (mainCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'spawn-1', name: 'subagent_spawn', arguments: { task: 'independent research' } }] });
    assert.ok(context.messages.some(m => m.role === 'toolResult' && m.toolCallId === 'spawn-1'));
    return streamOf(assistant('parent remains available'));
  };
  try {
    const t = transport(stream); const runtime = new PiDurableRuntime({ writer: f.parent, ...t, tools: createSubagentTools(f.manager, t) });
    await runtime.run(input('Delegate research and continue'));
    assert.equal(mainCalls, 2);
    // Spawn schedules an independent child; parent completion need not wait for
    // the child to reach its provider. Wait for that observable boundary only.
    await until(() => childCalls === 1);
    assert.equal(childCalls, 1);
    const parentState = await f.parent.load(); const child = f.parent.children[0]!;
    assert.equal(child.spec.fork.mode, 'none'); assert.equal(child.spec.fork.bytes, 0);
    release.resolve(); await until(() => child.turns[0]!.status === 'completed');
    assert.deepEqual(await f.parent.load(), parentState, 'child must never publish parent context/Memory');
    assert.equal(f.notifications(), 1); assert.equal(f.parent.events.length, 1);
    const again = await f.manager.spawn('spawn-1', 'independent research', 'none', t); assert.equal(again.id, child.id); assert.equal(childCalls, 1);
    await f.manager.send('follow-1', child.id, 'Go one step deeper', t);
    await until(() => child.turns.at(-1)?.status === 'completed');
    assert.equal(childCalls, 2); assert.equal(child.turns.length, 2);
    assert.equal(child.turns[0]!.result?.text, 'worker result'); assert.equal(child.turns[1]!.result?.text, 'followup result');
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.manager.close(); }
});

test('fork all freezes role-labelled current projection, omits hidden reasoning, and rejects oversized context without silently truncating constraints', async () => {
  const parent = new Parent(); await seed(parent, [input('User constraint: never publish'), { ...assistant('earlier answer'), content: [{ type: 'thinking', thinking: 'PRIVATE_REASONING_SENTINEL' }, { type: 'text', text: 'earlier answer' }] }]);
  const frozen = freezeSubagentContext(await parent.load());
  assert.match(frozen.text, /never publish/); assert.match(frozen.text, /"role":"user"/); assert.doesNotMatch(frozen.text, /PRIVATE_REASONING_SENTINEL/);
  assert.throws(() => freezeSubagentContext(parent.state, 10), /nothing was silently truncated/);
  const f = fixture(parent); let request = '';
  try {
    const t = transport((_m, c) => { request = JSON.stringify(c.messages); return streamOf(assistant('done')); });
    const child = await f.manager.spawn('fork-1', 'Read the inherited materials', 'all', t);
    await until(() => f.parent.children[0]?.turns[0]?.status === 'completed');
    assert.match(request, /never publish/); assert.match(request, /quoted reference data/); assert.doesNotMatch(request, /PRIVATE_REASONING_SENTINEL/);
    assert.equal(child.inheritance.parentVersion, parent.state.version); assert.equal(child.inheritance.truncated, false);
    assert.ok(![...f.writers.values()][0]!.state.records.some(r => parent.state.records.some(p => p.id === r.id)));
  } finally { await f.manager.close(); }
});

test('fresh context does not inherit unrelated parent messages; no main Memory path in tool registry', async () => {
  const parent = new Parent(); await seed(parent, [input('UNRELATED_PRIVATE_PARENT_TEXT')]); const f = fixture(parent);
  let seen = '';
  try {
    await f.manager.spawn('fresh', 'Standalone task', 'none', transport((_m, c) => { seen = JSON.stringify(c.messages); return streamOf(assistant('done')); }));
    await until(() => f.parent.children[0]?.turns[0]?.status === 'completed');
    assert.doesNotMatch(seen, /UNRELATED_PRIVATE_PARENT_TEXT/); assert.match(seen, /Do not write/); assert.match(seen, /synthetic-main-Memory/);
  } finally { await f.manager.close(); }
});

test('wait is bounded and new user input releases it without cancelling child; cancellation keeps unknown tool evidence', async () => {
  const entered = deferred(); const f = fixture(new Parent(), () => [effectTool(async (_id, _args, signal) => {
    entered.resolve(); await new Promise<void>((resolve, reject) => { signal?.addEventListener('abort', () => reject(signal.reason), { once: true }); }); return result;
  })]);
  const t = transport(() => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'side-effect', name: 'effect', arguments: {} }] }));
  try {
    const c = await f.manager.spawn('cancel-1', 'Work', 'none', t); await entered.promise;
    const waiting = f.manager.wait(c.id, 10_000); f.manager.onLiveInput();
    assert.equal((await waiting).reason, 'live_input'); assert.equal(f.parent.children[0]!.turns[0]!.status, 'running');
    assert.equal((await f.manager.wait(c.id, 0)).reason, 'timeout');
    await f.manager.cancel(c.id); await until(() => [...f.writers.values()][0]?.signal.aborted ?? false);
    assert.equal(f.parent.children[0]!.turns[0]!.status, 'cancelled');
    const writer = [...f.writers.values()][0]!; assert.equal(writer.state.executions.length, 1); assert.equal(writer.state.executions[0]!.outcome, null);
    assert.equal(f.parent.events.length, 1);
  } finally { await f.manager.close(); }
});

test('restart marks pending work interrupted without running it; explicit followup recovers unknown effects instead of replaying', async () => {
  const f = fixture(); const t = transport(() => streamOf(assistant('unused')));
  const spec: SubagentSpec = { task: 'before crash', fork: { mode: 'none', text: '', bytes: 0, parentVersion: 0, parentHead: null }, model: { provider: model.provider, id: model.id, api: model.api, configurationHash: 'a'.repeat(64) } };
  const c = await f.parent.createSubagent('crashed', spec, 4); await f.parent.claimSubagentTurn(c.id);
  await f.manager.initialize();
  assert.equal(f.parent.children[0]!.turns[0]!.status, 'interrupted'); assert.equal(f.writers.size, 0);
  assert.equal(f.parent.events.length, 1); await f.manager.initialize(); assert.equal(f.parent.events.length, 1);
  await assert.rejects(f.manager.send('different', c.id, 'continue', t), /model selection changed/);
  await f.manager.close();
});

for (const text of ['结果🌍'.repeat(10_000), 'x'.repeat(3_999) + '😀' + 'x'.repeat(20_000), '😀'.repeat(5_000)]) test('result budget keeps complete Unicode characters in the preview and full text in an ordinary file', async () => {
  const f = fixture();
  try {
    await f.manager.spawn('long-result', 'Return detailed findings', 'none', transport(() => streamOf(assistant(text))));
    await until(() => f.parent.children[0]?.turns[0]?.status === 'completed');
    const value = f.parent.children[0]!.turns[0]!.result!;
    assert.equal(value.truncated, true); assert.equal(f.spooled[0], text); assert.equal(value.fullResultPath, '/tmp/synthetic-full-result.txt'); assert.ok(Buffer.byteLength(value.text) <= 16_384);
    assert.ok(value.text.isWellFormed(), 'completion Event must remain valid Unicode for PostgreSQL JSON operations');
    assert.ok(text.startsWith(value.text.split('\n[Full result')[0]!), 'preview ends at an original complete character');
  } finally { await f.manager.close(); }
});

test('eight concurrent children run independently; ninth returns capacity and spawn retry does not duplicate', async () => {
  const f = fixture(); const release = deferred(); let calls = 0;
  const t = transport(async () => { calls++; await release.promise; return streamOf(assistant('done')); });
  try {
    for (let i = 0; i < 8; i++) await f.manager.spawn(`parallel-${i}`, `Task ${i}`, 'none', t);
    await until(() => calls === 8);
    await assert.rejects(f.manager.spawn('ninth', 'More', 'none', t), (e: unknown) => e instanceof SubagentError && e.code === 'capacity');
    const retried = await f.manager.spawn('parallel-0', 'Task 0', 'none', t); assert.equal(retried.id, f.parent.children[0]!.id); assert.equal(calls, 8);
    release.resolve(); await until(() => f.parent.children.every(c => c.turns[0]!.status === 'completed'));
    assert.equal(f.parent.events.length, 8);
  } finally { release.resolve(); await f.manager.close(); }
});


test('frozen projection preserves section-based system constraints and existing compaction summary', async () => {
  const writer = new Parent();
  const system = { role: 'system' as const, content: 'Historical parent system', sections: { instructions: 'NEVER_PUBLISH_CONSTRAINT' }, timestamp: 1000 };
  await seed(writer, [system, input('old user material'), assistant('old response'), input('recent user material')]);
  const state = await writer.load();
  const last = state.records.at(-1)!;
  await writer.append(state.version, encodeEntry({ type: 'compaction', id: randomUUID(), parentId: last.id, timestamp: new Date(2000).toISOString(),
    summary: 'SUMMARY_PRESERVED: the user forbids publishing', firstKeptEntryId: last.id, tokensBefore: 1000, systemMessage: { ...system, timestamp: 2000 } }));
  const frozen = freezeSubagentContext(await writer.load());
  assert.match(frozen.text, /NEVER_PUBLISH_CONSTRAINT/); assert.match(frozen.text, /SUMMARY_PRESERVED/); assert.match(frozen.text, /recent user material/);
});

test('running followup is consumed once in the current turn; cancelling completed work never overwrites results', async () => {
  const f = fixture(); const release = deferred(); let calls = 0; let followupContext = '';
  const t = transport(async (_m, context) => {
    calls++; if (calls === 1) await release.promise;
    else followupContext = JSON.stringify(context.messages);
    return streamOf(assistant(`result-${calls}`));
  });
  try {
    const c = await f.manager.spawn('live-spawn', 'First task', 'none', t);
    await until(() => calls === 1);
    const admitted = await f.manager.send('live-message', c.id, 'Second task', t);
    const duplicate = await f.manager.send('live-message', c.id, 'Second task', t);
    assert.equal(admitted.delivery.route, 'current_turn'); assert.equal(admitted.delivery.status, 'pending');
    assert.equal(admitted.delivery.inputRecordId, null); assert.deepEqual(duplicate.delivery, admitted.delivery);
    assert.equal(f.parent.children[0]!.turns.length, 1); assert.equal(calls, 1);
    await assert.rejects(f.manager.send('live-message', c.id, 'Changed task', t), /different content/);
    release.resolve(); await until(() => f.parent.children[0]!.turns[0]?.status === 'completed');
    assert.equal(calls, 2); assert.match(followupContext, /Second task/); assert.match(followupContext, /miraParentInstruction/);
    const receipt = await f.manager.send('live-message', c.id, 'Second task', t);
    assert.equal(receipt.delivery.route, 'current_turn'); assert.equal(receipt.delivery.status, 'consumed');
    assert.ok(receipt.delivery.inputRecordId);
    const records = [...f.writers.values()][0]!.state.records;
    assert.equal(records.filter(record => record.id === receipt.delivery.inputRecordId).length, 1);
    assert.equal(f.parent.events.length, 1, 'one terminal result for the current turn');
    const saved = structuredClone(f.parent.children[0]!.turns);
    await f.manager.cancel(c.id); assert.deepEqual(f.parent.children[0]!.turns, saved);
  } finally { release.resolve(); await f.manager.close(); }
});


test('running followup waits for the current tool outcome and leaves old siblings unstarted', async () => {
  const entered = deferred(); const release = deferred(); const effects: string[] = []; let requests = 0; let cancelledTool = false; let revisedContext = '';
  const f = fixture(new Parent(), () => [effectTool(async (callId, _args, signal) => {
    const onAbort = () => { cancelledTool = true; };
    effects.push(callId); signal?.addEventListener('abort', onAbort, { once: true });
    entered.resolve(); await release.promise; signal?.removeEventListener('abort', onAbort); return result;
  })]);
  const t = transport((_m, context) => {
    if (++requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'current-effect', name: 'effect', arguments: {} },
      { type: 'toolCall', id: 'unstarted-effect', name: 'effect', arguments: {} },
    ] });
    revisedContext = JSON.stringify(context.messages);
    return streamOf(assistant('Completed the revised assignment'));
  });
  try {
    const child = await f.manager.spawn('tool-boundary-spawn', 'Work on two sources', 'none', t); await entered.promise;
    const admitted = await f.manager.send('tool-boundary-live', child.id, 'Inspect only the completed effect', t);
    assert.equal(admitted.delivery.route, 'current_turn'); assert.equal(admitted.delivery.status, 'pending');
    assert.equal(requests, 1); assert.equal(cancelledTool, false); assert.deepEqual(effects, ['current-effect']);
    release.resolve(); await until(() => f.parent.children[0]!.turns[0]!.status === 'completed');
    assert.equal(requests, 2); assert.equal(cancelledTool, false); assert.deepEqual(effects, ['current-effect']);
    assert.equal(f.parent.children[0]!.turns.length, 1); assert.equal(f.parent.events.length, 1);
    const childWriter = [...f.writers.values()][0]!;
    assert.equal(childWriter.state.executions.length, 1); assert.ok(childWriter.state.executions[0]!.outcome);
    assert.equal(f.parent.followups.get('tool-boundary-live')!.status, 'consumed'); assert.deepEqual(f.errors, []);
    assert.match(revisedContext, /Inspect only the completed effect/); assert.match(revisedContext, /Execution did not start through this runtime/);
  } finally { release.resolve(); await f.manager.close(); }
});

test('a child final committed before a followup queues a new turn with the accepting transport', async () => {
  const entered = deferred(); const release = deferred(); let blocked = false; let oldCalls = 0; let newCalls = 0;
  class FinalWonParent extends Parent {
    override async finishSubagentTurn(...args: Parameters<Parent['finishSubagentTurn']>) {
      if (!blocked && args[1] === 'completed') { blocked = true; entered.resolve(); await release.promise; }
      return super.finishSubagentTurn(...args);
    }
  }
  const f = fixture(new FinalWonParent());
  const oldTransport = transport(() => { oldCalls++; return streamOf(assistant('Initial committed final')); });
  const nextTransport = transport((_m, context) => {
    newCalls++; assert.match(JSON.stringify(context.messages), /Initial committed final/); assert.match(JSON.stringify(context.messages), /New assignment after final/);
    return streamOf(assistant('Next turn final'));
  });
  try {
    const child = await f.manager.spawn('final-won-spawn', 'Finish initial task', 'none', oldTransport); await entered.promise;
    const first = f.parent.children[0]!.turns[0]!;
    assert.equal(first.status, 'running'); assert.ok(f.parent.links.get(first.id)!.finalRecordId);
    const admitted = await f.manager.send('final-won-followup', child.id, 'New assignment after final', nextTransport);
    assert.equal(admitted.delivery.route, 'queued_turn'); assert.equal(admitted.delivery.status, 'queued');
    assert.notEqual(admitted.delivery.turnId, first.id); assert.equal(f.parent.followups.size, 0);
    release.resolve(); await until(() => f.parent.children[0]!.turns[1]!.status === 'completed');
    assert.equal(oldCalls, 1); assert.equal(newCalls, 1); assert.equal(f.parent.events.length, 2);
    assert.equal(first.result?.text, 'Initial committed final'); assert.equal(f.parent.children[0]!.turns[1]!.result?.text, 'Next turn final');
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.manager.close(); }
});

test('explicit followup sees the model-facing unknown recovery wording, not internal status fields', async () => {
  const entered = deferred(); let effects = 0; let calls = 0;
  const f = fixture(new Parent(), () => [effectTool(async (_id, _args, signal) => {
    effects++; entered.resolve(); await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); return result;
  })]);
  const t = transport((_m, context) => {
    calls++;
    if (calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'original-effect', name: 'effect', arguments: {} }] });
    assert.match(JSON.stringify(context.messages), /no durable outcome exists/);
    return streamOf(assistant('Checked unknown effect without repeating it'));
  });
  try {
    const c = await f.manager.spawn('unknown-spawn', 'Work', 'none', t); await entered.promise;
    await f.manager.cancel(c.id); await until(() => [...f.writers.values()][0]?.signal.aborted ?? false);
    await f.manager.send('unknown-followup', c.id, 'Inspect unknown effects before acting', t);
    await until(() => f.parent.children[0]!.turns[1]?.status === 'completed');
    assert.equal(effects, 1); assert.equal(calls, 2);
    assert.match(JSON.stringify([...f.writers.values()][0]!.state.records), /outcome-unknown/);
  } finally { await f.manager.close(); }
});


test('followup cannot bypass the concurrency cap while cancelled effects are still settling', async () => {
  const release = deferred(); let block = false; let effects = 0;
  const f = fixture(new Parent(), () => [effectTool(async () => { effects++; await release.promise; return result; })]);
  let call = 0;
  const t = transport(() => {
    if (!block) return streamOf(assistant('idle worker'));
    return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: `blocked-effect-${++call}`, name: 'effect', arguments: {} }] });
  });
  try {
    const idle = await f.manager.spawn('idle-spawn', 'Ready', 'none', t);
    await until(() => [...f.writers.values()][0]?.signal.aborted ?? false);
    block = true;
    const active = [];
    for (let i = 0; i < 8; i++) active.push(await f.manager.spawn(`blocked-${i}`, 'Wait in effect', 'none', t));
    await until(() => effects === 8);
    await f.manager.cancel(active[0]!.id);
    await assert.rejects(f.manager.send('extra-followup', idle.id, 'Continue', t), (error: unknown) => error instanceof SubagentError && error.code === 'capacity');
    assert.equal(f.parent.children[0]!.turns.length, 1);
  } finally { release.resolve(); await f.manager.close(); }
});


test('followup arriving before cancelled tool cleanup cannot overwrite the cancelled turn or lose the followup', async () => {
  const release = deferred(); const entered = deferred(); let calls = 0;
  const f = fixture(new Parent(), () => [effectTool(async () => { entered.resolve(); await release.promise; return result; })]);
  const t = transport(() => { calls++; return streamOf(calls === 1 ? { ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'slow-cancel-effect', name: 'effect', arguments: {} }] } : assistant('followup completed')); });
  try {
    const child = await f.manager.spawn('slow-cancel-spawn', 'First task', 'none', t); await entered.promise;
    await f.manager.cancel(child.id);
    const cancelled = structuredClone(f.parent.children[0]!.turns[0]);
    await f.manager.send('after-slow-cancel', child.id, 'Continue after checking the unknown effect', t);
    release.resolve();
    await until(() => f.parent.children[0]!.turns[1]?.status === 'completed');
    assert.deepEqual(f.parent.children[0]!.turns[0], cancelled); assert.deepEqual(f.errors, []); assert.equal(calls, 2);
  } finally { release.resolve(); await f.manager.close(); }
});


test('followup after interruption before first child input retains original task and frozen constraints', async () => {
  for (const mode of ['none', 'all'] as const) for (const systemOnly of [false, true]) {
    const parent = new Parent(); await seed(parent, [input('FROZEN_CONSTRAINT_SENTINEL')]);
    const f = fixture(parent); let seen = ''; let calls = 0;
    const t = transport((_m, context) => { calls++; seen = JSON.stringify(context.messages); return streamOf(assistant('recovered')); });
    const frozen = freezeSubagentContext(await parent.load());
    const child = await parent.createSubagent(`crashed-${mode}-${systemOnly}`, {
      task: 'ORIGINAL_TASK_SENTINEL',
      fork: { mode, ...frozen, ...(mode === 'none' ? { text: '', bytes: 0 } : {}) },
      model: { provider: model.provider, id: model.id, api: model.api, configurationHash: createHash('sha256').update(JSON.stringify(model)).digest('hex') },
    }, 4);
    if (systemOnly) {
      const writer = new ChildWriter(parent, child.streamId);
      await seed(writer, [{ role: 'system', content: 'task-scoped worker', timestamp: Date.now() }]);
      f.writers.set(child.streamId, writer);
    }
    try {
      await f.manager.initialize();
      assert.equal(calls, 0);
      await f.manager.send(`resume-${mode}-${systemOnly}`, child.id, 'FOLLOWUP_SENTINEL: inspect the interrupted assignment', t);
      await until(() => parent.children[0]!.turns[1]!.status === 'completed');
      assert.equal(parent.children[0]!.turns[0]!.status, 'interrupted');
      assert.equal(calls, 1);
      assert.match(seen, /ORIGINAL_TASK_SENTINEL/);
      assert.match(seen, /FOLLOWUP_SENTINEL/);
      if (mode === 'all') assert.match(seen, /FROZEN_CONSTRAINT_SENTINEL/);
      else assert.doesNotMatch(seen, /FROZEN_CONSTRAINT_SENTINEL/);
      assert.match(seen, /quoted reference data/);
    } finally { await f.manager.close(); }
  }
});


test('running followups retain the active transport; subsequent new turns use their accepting parent transport', async () => {
  const f = fixture(); const release = deferred(); let oldCalls = 0; let newCalls = 0; let newestCalls = 0;
  const oldTransport = transport(async (_m, context) => {
    oldCalls++; if (oldCalls === 1) await release.promise;
    else { assert.match(JSON.stringify(context.messages), /First live instruction/); assert.match(JSON.stringify(context.messages), /Second live instruction/); }
    return streamOf(assistant('old transport current-turn result'));
  });
  const newTransport = transport(() => { newCalls++; return streamOf(assistant('new transport result')); });
  const newestTransport = transport(() => { newestCalls++; return streamOf(assistant('newest transport result')); });
  try {
    const child = await f.manager.spawn('transport-spawn', 'Hold the initial task', 'none', oldTransport);
    await until(() => oldCalls === 1);
    assert.equal((await f.manager.send('transport-live', child.id, 'First live instruction', newTransport)).delivery.route, 'current_turn');
    assert.equal((await f.manager.send('transport-live-next', child.id, 'Second live instruction', newestTransport)).delivery.route, 'current_turn');
    release.resolve();
    await until(() => f.parent.children[0]!.turns[0]!.status === 'completed');
    assert.equal(oldCalls, 2); assert.equal(newCalls, 0); assert.equal(newestCalls, 0);
    assert.equal(f.parent.children[0]!.turns.length, 1);
    assert.equal((await f.manager.send('transport-followup', child.id, 'Continue in a new turn', newTransport)).delivery.route, 'queued_turn');
    await until(() => f.parent.children[0]!.turns[1]!.status === 'completed');
    assert.equal((await f.manager.send('transport-followup-next', child.id, 'Continue in another new turn', newestTransport)).delivery.route, 'queued_turn');
    await until(() => f.parent.children[0]!.turns[2]!.status === 'completed');
    assert.equal(oldCalls, 2); assert.equal(newCalls, 1); assert.equal(newestCalls, 1);
    assert.equal(f.parent.children[0]!.turns[1]!.result?.text, 'new transport result');
    assert.equal(f.parent.children[0]!.turns[2]!.result?.text, 'newest transport result');
  } finally { release.resolve(); await f.manager.close(); }
});

test('independent child reads can fail and recover without discarding readable parent history', async () => {
  const { LocalWebService } = await import('@mira/server');
  const now = new Date().toISOString(); const runId = randomUUID(); const toolId = randomUUID();
  const parent = new Parent();
  const record = await parent.createSubagent('detail-spawn', { title: 'Inspect build', task: 'PRIVATE_TASK',
    fork: { mode: 'none', text: '', bytes: 0, parentVersion: 0, parentHead: null },
    model: { provider: model.provider, id: model.id, api: model.api, configurationHash: 'a'.repeat(64) } }, 8);
  let unavailable = true;
  const history = {
    readRun: async () => ({ run: { id: runId, occurredAt: now, status: 'completed', requestCount: 1, finalRecordId: null }, memory: null,
      records: [{ id: toolId, kind: 'tool', occurredAt: now }], nextCursor: null }),
    readRunRequests: async () => ({ items: [], nextCursor: null }),
    read: async () => ({ id: toolId, kind: 'tool', occurredAt: now, intent: { callId: 'detail-spawn', toolName: 'subagent_spawn' }, outcome: null }),
  };
  const reader = {
    readSubagentsForRun: async () => { if (unavailable) throw Error('Synthetic unavailable'); return parent.listSubagents(); },
    getSubagentForRun: async () => { if (unavailable) throw Error('Synthetic unavailable'); return parent.getSubagent(record.id); },
  };
  const service = Reflect.construct(LocalWebService, [{ dreaming: { enabled: false } }, { signal: new AbortController().signal, onLiveInput: () => () => {} }, history, {}, {}, {}, {}, {}, reader]) as typeof LocalWebService.prototype;
  const detail = await service.run(runId); assert(detail);
  assert.equal(detail.executions.length, 1); assert.equal(detail.error, null);
  assert.equal(detail.executions[0]!.kind, 'tool');
  await assert.rejects(service.children(runId)); await assert.rejects(service.child(runId, record.id));
  unavailable = false;
  assert.equal((await service.children(runId)).items[0]!.id, record.id);
  const child = await service.child(runId, record.id); assert(child);
  assert.equal(child.title, 'Inspect build'); assert.doesNotMatch(JSON.stringify(child), /PRIVATE_TASK|configurationHash|instruction|fullResultPath/);
  assert.deepEqual(await service.run(runId), detail);
});


test('close waits for the final child registry read before releasing its tracked cleanup slot', async () => {
  const entered = deferred(); const release = deferred();
  class ClosingParent extends Parent {
    override async getSubagent(id: string) {
      const child = await super.getSubagent(id);
      if (child?.turns.at(-1)?.status === 'completed') { entered.resolve(); await release.promise; }
      return child;
    }
  }
  const f = fixture(new ClosingParent()); let closed = false;
  try {
    await f.manager.spawn('cleanup-read-spawn', 'Finish quickly', 'none', transport(() => streamOf(assistant('done'))));
    await entered.promise;
    assert.equal(f.manager.hasActiveWork, true, 'terminal persistence does not release the active cleanup slot');
    const closing = f.manager.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(f.manager.hasActiveWork, true);
    assert.equal(closed, false, 'close must retain ownership until the final registry read settles');
    release.resolve(); await closing;
    assert.equal(closed, true); assert.equal(f.manager.hasActiveWork, false); assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.manager.close(); }
});


test('followup committed during the final registry read is not stranded behind cleanup', async () => {
  const entered = deferred(); const release = deferred(); let blocked = false; let calls = 0;
  class ClosingParent extends Parent {
    override async getSubagent(id: string) {
      const child = await super.getSubagent(id);
      if (!blocked && child?.turns.at(-1)?.status === 'completed') { blocked = true; entered.resolve(); await release.promise; }
      return child;
    }
  }
  const f = fixture(new ClosingParent()); const t = transport(() => { calls++; return streamOf(assistant(`result ${calls}`)); });
  try {
    const child = await f.manager.spawn('cleanup-send-spawn', 'Finish quickly', 'none', t);
    await entered.promise;
    await f.manager.send('cleanup-send-followup', child.id, 'Continue while final read is pending', t);
    release.resolve();
    await until(() => f.parent.children[0]!.turns[1]!.status === 'completed');
    assert.equal(calls, 2); assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.manager.close(); }
});

test('wait observes committed input before execution and while its admission read is in flight', async () => {
  const f = fixture(); const release = deferred(); const queryEntered = deferred(); const queryRelease = deferred();
  const t = transport(async () => { await release.promise; return streamOf(assistant('child completes later')); });
  try {
    const child = await f.manager.spawn('wait-admission', 'Independent work', 'none', t);
    await until(() => f.parent.children[0]?.turns[0]?.status === 'running');
    // The commit notification can precede tool execute, after its durable intent.
    f.manager.onLiveInput();
    assert.equal((await f.manager.wait(child.id, 10_000, undefined, async () => true)).reason, 'live_input');
    assert.equal(f.parent.children[0]!.turns[0]!.status, 'running');
    const waiting = f.manager.wait(child.id, 10_000, undefined, async () => { queryEntered.resolve(); await queryRelease.promise; return false; });
    await queryEntered.promise; f.manager.onLiveInput(); queryRelease.resolve();
    assert.equal((await waiting).reason, 'live_input');
    assert.equal((await f.manager.wait(child.id, 0, undefined, async () => false)).reason, 'timeout', 'already consumed input cannot poison later waits');
  } finally { release.resolve(); queryRelease.resolve(); await f.manager.close(); }
});


test('child activity follows actual model and tool boundaries and explicit public progress', async () => {
  const modelRelease = deferred(); const toolEntered = deferred(); const toolRelease = deferred(); let calls = 0;
  const f = fixture(new Parent(), () => [effectTool(async () => { toolEntered.resolve(); await toolRelease.promise; return result; })]);
  const t = transport(async () => {
    calls++;
    if (calls === 1) { await modelRelease.promise; return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: 'HIDDEN_REASONING_SENTINEL' },
      { type: 'toolCall', id: 'public-progress', name: 'report_progress', arguments: { text: 'Checked the failing test; now verifying the fix.' } },
      { type: 'toolCall', id: 'observed-effect', name: 'effect', arguments: {} },
    ] }); }
    return streamOf(assistant('Verified result'));
  });
  try {
    const c = await f.manager.spawn('activity-spawn', 'PRIVATE_TASK_SENTINEL', 'none', t, 'Verify build');
    await until(() => calls === 1);
    let turn = (await f.parent.getSubagent(c.id))!.turns[0]!;
    assert.equal(c.title, 'Verify build'); assert.ok(turn.startedAt); assert.equal(turn.activity.current?.kind, 'model');
    assert.equal(turn.activity.events.length, 1);
    modelRelease.resolve(); await toolEntered.promise;
    turn = (await f.parent.getSubagent(c.id))!.turns[0]!;
    assert.equal(turn.activity.current?.kind, 'tool'); assert.equal(turn.activity.current?.name, 'effect');
    assert.ok(turn.activity.events.some(event => event.source === 'worker' && event.kind === 'progress' && event.text?.includes('verifying the fix')));
    assert.ok(turn.activity.events.some(event => event.kind === 'model' && event.phase === 'finished'));
    assert.doesNotMatch(JSON.stringify(turn.activity), /HIDDEN_REASONING_SENTINEL|PRIVATE_TASK_SENTINEL|arguments|thinking/);
    toolRelease.resolve(); await until(() => f.parent.children[0]!.turns[0]!.status === 'completed');
    turn = (await f.parent.getSubagent(c.id))!.turns[0]!;
    assert.equal(turn.activity.current, null); assert.ok(turn.finishedAt);
    assert.ok(turn.activity.events.some(event => event.name === 'effect' && event.status === 'succeeded'));
    await assert.rejects(f.manager.spawn('activity-spawn', 'PRIVATE_TASK_SENTINEL', 'none', t, 'Changed name'), /different arguments/);
  } finally { modelRelease.resolve(); toolRelease.resolve(); await f.manager.close(); }
});

test('thrown child effect ends as unknown before the recovery model starts', async () => {
  const release = deferred(); let calls = 0;
  const f = fixture(new Parent(), () => [effectTool(async () => { throw Error('SECRET_EXCEPTION_SENTINEL'); })]);
  const t = transport(async () => {
    if (++calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'unknown-observation', name: 'effect', arguments: {} }] });
    await release.promise; return streamOf(assistant('Inspected the unknown effect'));
  });
  try {
    const child = await f.manager.spawn('unknown-activity', 'Inspect safely', 'none', t);
    await until(() => calls === 2);
    const activity = (await f.parent.getSubagent(child.id))!.turns[0]!.activity;
    assert.equal(activity.current?.kind, 'model');
    assert.ok(activity.events.some(event => event.kind === 'tool' && event.phase === 'finished' && event.status === 'unknown'));
    assert.doesNotMatch(JSON.stringify(activity), /SECRET_EXCEPTION_SENTINEL/);
    release.resolve(); await until(() => f.parent.children[0]!.turns[0]!.status === 'completed');
  } finally { release.resolve(); await f.manager.close(); }
});

test('concurrent admissions cannot spend a cancelling execution slot twice', async () => {
  const release = deferred(); let effects = 0;
  const f = fixture(new Parent(), () => [effectTool(async () => { effects++; await release.promise; return result; })], 2);
  const t = transport(() => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: randomUUID(), name: 'effect', arguments: {} }] }));
  try {
    const first = await f.manager.spawn('capacity-cancelling', 'Work', 'none', t); await until(() => effects === 1);
    await f.manager.cancel(first.id);
    assert.equal(f.manager.hasActiveWork, true, 'cancellation receipt does not release an executing tool slot');
    const results = await Promise.allSettled([f.manager.spawn('concurrent-one', 'Work', 'none', t), f.manager.spawn('concurrent-two', 'Work', 'none', t)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected')!;
    assert.ok(rejected.status === 'rejected' && rejected.reason instanceof SubagentError && rejected.reason.code === 'capacity');
  } finally { release.resolve(); await f.manager.close(); }
});

test('startup concurrency defaults to eight and accepts only one through thirty-two', async () => {
  const { subagentConcurrency } = await import('../../apps/server/src/web-config.ts');
  assert.equal(subagentConcurrency(undefined), 8);
  for (const value of [1, 8, 32]) { assert.equal(subagentConcurrency(String(value)), value); const f = fixture(new Parent(), () => [], value); assert.equal(f.manager.maxConcurrent, value); await f.manager.close(); }
  for (const value of ['', '0', '33', '-1', '1.5', '08', ' 8', 'secret-value']) assert.throws(() => subagentConcurrency(value), /integer from 1 to 32/);
  for (const value of [0, 33, 1.5]) assert.throws(() => fixture(new Parent(), () => [], value), /Invalid child concurrency/);
});

test('failed durable activity observation stops the child before provider dispatch', async () => {
  class ActivityFailureParent extends Parent {
    override async recordSubagentActivity(_id: string, _event: SubagentActivityInput): Promise<void> { throw Error('Synthetic activity writer failure'); }
  }
  const f = fixture(new ActivityFailureParent()); let calls = 0;
  try {
    await f.manager.spawn('failed-observation', 'Inspect only', 'none', transport(() => { calls++; return streamOf(assistant('must not execute')); }));
    await until(() => f.parent.children[0]!.turns[0]!.status === 'failed');
    assert.equal(calls, 0); assert.equal(f.parent.children[0]!.turns[0]!.activity.current, null);
  } finally { await f.manager.close(); }
});


test('activity cancellation after durable finishTool preserves exact known success or error', async () => {
  for (const isError of [false, true]) {
    const abort = new AbortController(); const events: PiRuntimeActivity[] = []; let effects = 0; let requests = 0;
    class AfterOutcomeWriter extends MemoryWriter {
      override async finishTool(outcome: Parameters<MemoryWriter['finishTool']>[0]) {
        await super.finishTool(outcome);
        abort.abort(new Error('Synthetic cancellation immediately after durable outcome'));
      }
    }
    const writer = new AfterOutcomeWriter();
    const runtime = new PiDurableRuntime({ writer, model, onActivity: async event => { events.push(event); },
      tools: [effectTool(async () => { effects++; return { ...result, isError }; })],
      streamFn: () => { requests++; return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'after-outcome-abort', name: 'effect', arguments: {} }] }); },
    });
    await assert.rejects(runtime.run(input('Check durable outcome cancellation'), abort.signal));
    assert.equal(effects, 1); assert.equal(requests, 1); assert.ok(writer.state.executions[0]!.outcome);
    const last = events.filter(event => event.kind === 'tool').at(-1)!;
    assert.equal(last.phase, 'finished'); assert.equal(last.status, isError ? 'failed' : 'succeeded');
    assert.ok(!events.some(event => event.kind === 'tool' && event.status === 'unknown'));
    await writer.close();
  }
});


test('activity cancellation after durable assistant append preserves the completed model request', async () => {
  const abort = new AbortController(); const events: PiRuntimeActivity[] = [];
  class AfterModelWriter extends MemoryWriter {
    override async append(...args: Parameters<MemoryWriter['append']>) {
      const version = await super.append(...args);
      const entry = decodeRecords([args[1]], args[1].parentId)[0];
      if (entry?.type === 'message' && entry.message.role === 'assistant') abort.abort(Error('Synthetic cancellation after model publication'));
      return version;
    }
  }
  const writer = new AfterModelWriter();
  const runtime = new PiDurableRuntime({ writer, model, streamFn: () => streamOf(assistant('Saved response')), onActivity: async event => { events.push(event); } });
  await assert.rejects(runtime.run(input('Check response publication'), abort.signal));
  assert.equal(events.at(-1)!.kind, 'model'); assert.equal(events.at(-1)!.phase, 'finished'); assert.equal(events.at(-1)!.status, 'completed');
  assert.ok(writer.state.records.some(record => { const entry = decodeRecords([record], record.parentId)[0]; return entry?.type === 'message' && entry.message.role === 'assistant'; }));
  await writer.close();
});


test('close settles an admission committed after dispatch was closed without leaving queued work', async () => {
  const entered = deferred(); const release = deferred();
  class SlowAdmissionParent extends Parent {
    override async createSubagent(...args: Parameters<Parent['createSubagent']>) {
      entered.resolve(); await release.promise; return super.createSubagent(...args);
    }
  }
  const f = fixture(new SlowAdmissionParent()); let requests = 0; let closed = false;
  try {
    const spawning = f.manager.spawn('close-admission', 'Never dispatched', 'none', transport(() => { requests++; return streamOf(assistant('unused')); }));
    await entered.promise;
    const closing = f.manager.close().then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, false);
    release.resolve(); await spawning; await closing;
    assert.equal(requests, 0); assert.equal(f.writers.size, 0);
    assert.equal(f.parent.children[0]!.turns[0]!.status, 'interrupted');
    assert.equal(f.parent.children[0]!.turns[0]!.startedAt, null);
    assert.equal(f.parent.events.length, 1);
  } finally { release.resolve(); await f.manager.close(); }
});

test('close interrupts unread live followups after the real in-flight child settles', async () => {
  const release = deferred(); let requests = 0;
  const f = fixture();
  const t = transport(async () => { requests++; await release.promise; return streamOf(assistant('late response')); });
  try {
    const child = await f.manager.spawn('close-followup-spawn', 'First assignment', 'none', t);
    await until(() => requests === 1);
    await f.manager.send('close-followup-next', child.id, 'Unread parent instruction', t);
    const closing = f.manager.close(); release.resolve(); await closing;
    assert.equal(requests, 1);
    assert.deepEqual(f.parent.children[0]!.turns.map(turn => turn.status), ['interrupted']);
    const followup = (await f.parent.findSubagentCall('close-followup-next'))!.followup!;
    assert.equal(followup.status, 'interrupted'); assert.equal(followup.inputRecordId, null);
    assert.equal(f.parent.events.length, 1);
  } finally { release.resolve(); await f.manager.close(); }
});

// Real child dispatcher and Pi compaction hook; summaries are deterministic
// synthetic responses, not evidence of live-provider summarization quality.
test('live child followup during frozen task summary is consumed after checkpoint in the current turn without replay', async () => {
  let effects = 0;
  const f = fixture(new Parent(), () => [effectTool(async () => { effects++; return result; })]);
  const summarizing = deferred(); const release = deferred(); let summaries = 0; let calls = 0;
  let childId = ''; const seen: string[] = [];
  const t = transport(async (_m, context) => {
    const system = getSystemMessageText(getCurrentSystemMessage(context.messages)!);
    if (system.includes('Summarize this task-scoped worker')) {
      summaries++;
      assert.doesNotMatch(system, /你是 Mira|Memory 由系统另行注入/);
      const data = JSON.parse(String(context.messages.find(m => m.role === 'user')?.content));
      assert.equal(data.memory_snapshot, null);
      assert.doesNotMatch(JSON.stringify(data), /LIVE_DURING_SUMMARY/);
      assert.match(data.persona_context, /task-scoped worker/);
      assert.ok(data.source_messages.length > 0);
      assert.ok(data.source_messages.every((m: { history_id: string }) => /^[a-f0-9-]{36}$/.test(m.history_id)));
      if (summaries === 1) { summarizing.resolve(); await release.promise; }
      return streamOf(assistant('TASK_SUMMARY: continue the assigned research; no publication permission.'));
    }
    calls++; seen.push(JSON.stringify(context.messages));
    assert.match(system, /task-scoped worker/);
    if (calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'compact-original-effect', name: 'effect', arguments: {} }] });
    return streamOf(assistant(`result-${calls}: ${'bounded research evidence '.repeat(60)}`));
  });
  try {
    childId = (await f.manager.spawn('compact-spawn', 'Research only, do not publish', 'none', t)).id;
    await until(() => f.parent.children[0]!.turns[0]!.status === 'completed');
    const parentBefore = structuredClone(f.parent.state);
    for (let i = 1; i <= 24 && summaries === 0; i++) {
      await f.manager.send(`compact-${i}`, childId, `Continue investigation ${i}`, t);
      await until(() => summaries > 0 || f.parent.children[0]!.turns.at(-1)!.status === 'completed');
    }
    assert.equal(summaries, 1);
    await summarizing.promise;
    assert.equal(f.parent.children[0]!.turns.at(-1)!.activity.current?.name, 'context-compaction');
    assert.equal(f.parent.children[0]!.turns.at(-1)!.activity.current?.phase, 'started');
    assert.ok(f.parent.children[0]!.turns.at(-1)!.activity.current?.checkpointId);
    assert.doesNotMatch(JSON.stringify(await f.manager.status(childId)), /checkpointId|toolHistoryId/);
    const currentCount = f.parent.children[0]!.turns.length;
    const currentTurn = f.parent.children[0]!.turns.at(-1)!;
    const admitted = await f.manager.send('compact-live', childId, 'LIVE_DURING_SUMMARY: inspect the new evidence only', t);
    assert.equal(admitted.delivery.route, 'current_turn'); assert.equal(admitted.delivery.status, 'pending');
    assert.equal(admitted.delivery.turnId, currentTurn.id);
    assert.equal(f.parent.children[0]!.turns.at(-1)!.status, 'running');
    assert.equal(f.parent.followups.get('compact-live')!.inputRecordId, null);
    release.resolve();
    await until(() => f.parent.children[0]!.turns.every(turn => turn.status === 'completed'));
    assert.equal(f.parent.children[0]!.turns.length, currentCount);
    assert.ok(f.parent.children[0]!.turns.flatMap(turn => turn.activity.events).some(event => event.name === 'context-compaction' && event.phase === 'finished' && event.status === 'completed'));
    assert.doesNotMatch(JSON.stringify(await f.manager.status(childId)), /checkpointId|toolHistoryId/);
    assert.match(seen.at(-1)!, /LIVE_DURING_SUMMARY/);
    assert.match(seen.at(-1)!, /TASK_SUMMARY/);
    const childWriter = [...f.writers.values()][0]!;
    const followup = f.parent.followups.get('compact-live')!;
    assert.equal(followup.status, 'consumed'); assert.ok(followup.inputRecordId);
    const checkpointIndex = childWriter.state.records.findIndex(record => record.kind === 'checkpoint');
    assert.ok(checkpointIndex >= 0);
    assert.ok(childWriter.state.records.findIndex(record => record.id === followup.inputRecordId) > checkpointIndex);
    assert.equal(effects, 1, 'pre-summary tool history is never replayed');
    assert.ok(!JSON.stringify(childWriter.state.records).includes('miraMemory'));
    assert.deepEqual(f.parent.state, parentBefore, 'child checkpoints do not enter main transcript');
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.manager.close(); }
});

test('task compaction rejects main Memory configuration before any loader runs', () => {
  let reads = 0;
  assert.throws(() => new PiDurableRuntime({ writer: new MemoryWriter(), model, streamFn: () => streamOf(assistant()),
    compactionScope: 'task', miraPrompt: { environmentContext: '', authorizationContext: '', loadMemory: async () => { reads++; return 'private'; } } }), /cannot use the main Mira prompt/);
  assert.equal(reads, 0);
});

for (const failure of ['error', 'cancel'] as const) test(`child summary ${failure} preserves history and explicit followup can continue without automatic replay`, async () => {
  const f = fixture(); const entered = deferred(); const release = deferred(); let summaries = 0; let successfulSummary = false; let calls = 0;
  const t = transport(async (_m, context) => {
    const system = getSystemMessageText(getCurrentSystemMessage(context.messages)!);
    if (system.includes('Summarize this task-scoped worker')) {
      summaries++; entered.resolve();
      if (!successfulSummary) {
        if (failure === 'cancel') await release.promise;
        return streamOf({ ...assistant(), stopReason: 'error', errorMessage: 'synthetic summary fault' });
      }
      return streamOf(assistant('RECOVERED_TASK_SUMMARY: work is read-only; continue from confirmed evidence.'));
    }
    calls++; return streamOf(assistant(`result-${calls}: ${'bounded research evidence '.repeat(60)}`));
  });
  try {
    const childId = (await f.manager.spawn(`summary-${failure}`, 'Research only', 'none', t)).id;
    await until(() => f.parent.children[0]!.turns[0]!.status === 'completed');
    for (let i = 1; i <= 24 && summaries === 0; i++) {
      await f.manager.send(`summary-${failure}-${i}`, childId, `Continue ${i}`, t);
      await until(() => summaries > 0 || f.parent.children[0]!.turns.at(-1)!.status === 'completed');
    }
    assert.equal(summaries, 1); await entered.promise;
    if (failure === 'cancel') { await f.manager.cancel(childId); release.resolve(); }
    await until(() => [...f.writers.values()][0]!.signal.aborted);
    assert.equal(f.parent.children[0]!.turns.at(-1)!.status, failure === 'cancel' ? 'cancelled' : 'failed');
    if (failure === 'error') assert.ok(f.parent.children[0]!.turns.at(-1)!.activity.events.some(event => event.name === 'context-compaction' && event.phase === 'finished' && event.status === 'failed'));
    const saved = structuredClone([...f.writers.values()][0]!.state.records);
    assert.equal(saved.filter(record => record.kind === 'checkpoint').length, 0);
    const oldCalls = calls; await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, oldCalls); assert.equal(summaries, 1);
    successfulSummary = true;
    await f.manager.send(`resume-${failure}`, childId, 'Inspect preserved results and continue', t);
    await until(() => f.parent.children[0]!.turns.at(-1)!.status === 'completed');
    const after = [...f.writers.values()][0]!.state.records;
    assert.deepEqual(after.slice(0, saved.length), saved);
    assert.equal(after.filter(record => record.kind === 'checkpoint').length, 1);
    assert.equal(summaries, 2); assert.equal(calls, oldCalls + 1);
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.manager.close(); }
});


test('followups before first claim join the same queued task in order and cannot be overtaken', async () => {
  const f = await fixture(); const entered = deferred(), release = deferred(); let calls = 0;
  const claim = f.parent.claimSubagentTurn.bind(f.parent);
  f.parent.claimSubagentTurn = async id => { entered.resolve(); await release.promise; return claim(id); };
  const t = transport((_m, context) => {
    calls++; const text = JSON.stringify(context.messages);
    assert.ok(text.indexOf('QUEUED_FIRST') < text.indexOf('QUEUED_SECOND'));
    assert.match(text, /QUEUED_FIRST/); assert.match(text, /QUEUED_SECOND/);
    return streamOf(assistant('Completed one ordered task'));
  });
  try {
    const child = await f.manager.spawn('queued-order-spawn', 'Original assignment', 'none', t);
    await entered.promise;
    const first = await f.manager.send('queued-order-first', child.id, 'QUEUED_FIRST', t);
    const second = await f.manager.send('queued-order-second', child.id, 'QUEUED_SECOND', t);
    assert.equal(first.delivery.route, 'queued_task'); assert.equal(second.delivery.route, 'queued_task');
    assert.equal(first.delivery.status, 'pending'); assert.equal(f.parent.children[0]!.turnCount, 1);
    release.resolve(); await until(() => f.parent.children[0]!.turns[0]!.status === 'completed');
    assert.equal(calls, 1); assert.equal(f.parent.children[0]!.turnCount, 1);
    assert.ok([...f.parent.followups.values()].every(value => value.status === 'consumed'));
    assert.deepEqual(f.errors, []);
  } finally { release.resolve(); await f.manager.close(); }
});
