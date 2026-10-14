import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, getCurrentTools } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { SubagentError, type SubagentWriter, type SubagentRecord, type SubagentSpec, type SubagentResult, type LifeEvent, type WakeReceipt } from '@mira/life';
import { PiDurableRuntime, freezeSubagentContext, encodeEntry } from '@mira/runtime-pi';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { MemoryWriter, assistant, streamOf, model, deferred, seed, input, effectTool, result } from '../recovery/fixtures.mts';

/** Only test storage; production never uses an in-memory fallback. */
class Parent extends MemoryWriter implements SubagentWriter {
  children: SubagentRecord[] = [];
  events: LifeEvent[] = [];
  async createSubagent(callId: string, spec: SubagentSpec, max: number) {
    const old = this.children.find(c => c.spawnCallId === callId); if (old) return structuredClone(old);
    if (this.children.filter(c => c.turns.some(t => ['queued','running'].includes(t.status))).length >= max) throw new SubagentError('capacity', 'full');
    const id = randomUUID(); const createdAt = new Date().toISOString();
    const child: SubagentRecord = { id, streamId: `subagent:${id}`, spawnCallId: callId, createdAt, spec: structuredClone(spec), turns: [
      { id: randomUUID(), childId: id, callId, sequence: 1, instruction: spec.task, status: 'queued', createdAt, finishedAt: null, result: null },
    ] }; this.children.push(child); return structuredClone(child);
  }
  async listSubagents() { return structuredClone(this.children); }
  async getSubagent(id: string) { return structuredClone(this.children.find(c => c.id === id) ?? null); }
  async sendSubagent(callId: string, id: string, instruction: string, _max: number) {
    const c = this.children.find(c => c.id === id)!;
    if (!c.turns.some(t => t.callId === callId)) c.turns.push({ id: randomUUID(), childId: id, callId, sequence: c.turns.length + 1, instruction, status: 'queued', createdAt: new Date().toISOString(), finishedAt: null, result: null });
    return structuredClone(c);
  }
  async claimSubagentTurn(id: string) { const t = this.children.find(c => c.id === id)!.turns.find(t => t.status === 'queued'); if (!t) return null; t.status = 'running'; return structuredClone(t); }
  async finishSubagentTurn(id: string, status: 'completed' | 'interrupted' | 'cancelled' | 'failed', value: SubagentResult) {
    const t = this.children.flatMap(c => c.turns).find(t => t.id === id)!;
    if (!['queued', 'running'].includes(t.status)) { assert.equal(t.status, status); assert.deepEqual(t.result, value); return; }
    t.status = status; t.result = structuredClone(value); t.finishedAt = new Date().toISOString();
    this.events.push({ id: `subagent-result:${id}`, type: 'subagent.result', source: 'system', occurredAt: t.finishedAt, payload: { childId: t.childId, status } });
  }
  async cancelSubagent(id: string) { for (const t of this.children.find(c => c.id === id)!.turns) if (['queued','running'].includes(t.status)) await this.finishSubagentTurn(t.id, 'cancelled', { text: 'Cancelled; effects may be unknown', truncated: false, fullResultPath: null, finalRecordId: null }); }
  async interruptSubagents() { for (const c of this.children) for (const t of c.turns) if (['queued','running'].includes(t.status)) await this.finishSubagentTurn(t.id, 'interrupted', { text: 'Interrupted without replay', truncated: false, fullResultPath: null, finalRecordId: null }); }
  override async receive(event: LifeEvent, _wake?: WakeReceipt): Promise<'inserted'> { this.events.push(event); return 'inserted'; }
}
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 3000; while (!await check()) { if (Date.now() > end) throw Error('Condition did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } }
function fixture(parent = new Parent(), tools = () => [] as ReturnType<typeof createSubagentTools>) {
  const writers = new Map<string, MemoryWriter>(); const errors: unknown[] = []; const spooled: string[] = []; let notifications = 0;
  const manager = new SubagentManager({ writer: parent, acquire: async id => {
    let writer = writers.get(id);
    if (!writer || writer.signal.aborted) { const next = new MemoryWriter(); if (writer) next.state = structuredClone(writer.state); writer = next; writers.set(id, writer); }
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
    assert.equal(mainCalls, 2); assert.equal(childCalls, 1);
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
    const waiting = f.manager.wait(c.id, 10_000); f.manager.onUserInput();
    assert.equal((await waiting).reason, 'user_input'); assert.equal(f.parent.children[0]!.turns[0]!.status, 'running');
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

test('result budget keeps full text in an ordinary file and a bounded completion payload', async () => {
  const f = fixture(); const text = '结果🌍'.repeat(10_000);
  try {
    await f.manager.spawn('long-result', 'Return detailed findings', 'none', transport(() => streamOf(assistant(text))));
    await until(() => f.parent.children[0]?.turns[0]?.status === 'completed');
    const value = f.parent.children[0]!.turns[0]!.result!;
    assert.equal(value.truncated, true); assert.equal(f.spooled[0], text); assert.equal(value.fullResultPath, '/tmp/synthetic-full-result.txt'); assert.ok(Buffer.byteLength(value.text) <= 16_384);
  } finally { await f.manager.close(); }
});

test('four concurrent children run independently; fifth returns capacity and spawn retry does not duplicate', async () => {
  const f = fixture(); const release = deferred(); let calls = 0;
  const t = transport(async () => { calls++; await release.promise; return streamOf(assistant('done')); });
  try {
    for (let i = 0; i < 4; i++) await f.manager.spawn(`parallel-${i}`, `Task ${i}`, 'none', t);
    await until(() => calls === 4);
    await assert.rejects(f.manager.spawn('fifth', 'More', 'none', t), (e: unknown) => e instanceof SubagentError && e.code === 'capacity');
    const retried = await f.manager.spawn('parallel-0', 'Task 0', 'none', t); assert.equal(retried.id, f.parent.children[0]!.id); assert.equal(calls, 4);
    release.resolve(); await until(() => f.parent.children.every(c => c.turns[0]!.status === 'completed'));
    assert.equal(f.parent.events.length, 4);
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

test('followup queued during a running child executes once; cancelling completed work never overwrites results', async () => {
  const f = fixture(); const release = deferred(); let calls = 0;
  const t = transport(async () => { calls++; if (calls === 1) await release.promise; return streamOf(assistant(`result-${calls}`)); });
  try {
    const c = await f.manager.spawn('queue-spawn', 'First task', 'none', t);
    await until(() => calls === 1);
    await f.manager.send('queue-message', c.id, 'Second task', t);
    await f.manager.send('queue-message', c.id, 'Second task', t);
    assert.equal(f.parent.children[0]!.turns.length, 2); assert.equal(calls, 1);
    release.resolve(); await until(() => f.parent.children[0]!.turns[1]?.status === 'completed');
    assert.equal(calls, 2); const saved = structuredClone(f.parent.children[0]!.turns);
    await f.manager.cancel(c.id); assert.deepEqual(f.parent.children[0]!.turns, saved);
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
    for (let i = 0; i < 4; i++) active.push(await f.manager.spawn(`blocked-${i}`, 'Wait in effect', 'none', t));
    await until(() => effects === 4);
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
