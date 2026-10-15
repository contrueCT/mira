import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { SubagentActivityInput, SubagentSpec } from '@mira/life';
import { SubagentError, prepareWakeTurn } from '@mira/life';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PiDurableRuntime, encodeEntry, messageEntry } from '@mira/runtime-pi';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf, model, input, deferred, seed } from './fixtures.mts';

const now = () => new Date().toISOString();
async function until(check: () => boolean | Promise<boolean>) { const end = Date.now() + 10_000; while (!await check()) { if (Date.now() > end) throw Error('Condition did not settle'); await new Promise(resolve => setTimeout(resolve, 5)); } }
const spec = (title = 'Inspect build'): SubagentSpec => ({ title, task: 'PRIVATE_TASK_SENTINEL', fork: { mode: 'none', text: '', bytes: 0, parentVersion: 0, parentHead: null }, model: { provider: model.provider, id: model.id, api: model.api, configurationHash: 'a'.repeat(64) } });

test('PostgreSQL actual Pi runs eight children, rejects the ninth and persists public model/progress events', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const release = deferred(); let manager: SubagentManager | undefined; let childCalls = 0;
  try {
    const writer = await db.acquire('activity-parent'); const errors: unknown[] = [];
    manager = new SubagentManager({ writer, acquire: id => db.acquire(id), tools: () => [], writeOverflowInput: async () => { throw Error('Unused'); }, onCompletion: () => {}, onFailure: error => errors.push(error) });
    const stream: StreamFn = async (_model, context) => {
      if (getSystemMessageText(getCurrentSystemMessage(context.messages)!).includes('task-scoped worker')) {
        childCalls++;
        if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('Verified public result'));
        await release.promise;
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'thinking', thinking: 'PRIVATE_REASONING_SENTINEL' },
          { type: 'toolCall', id: `progress-${childCalls}`, name: 'report_progress', arguments: { text: 'Checked the assigned build.' } },
        ] });
      }
      if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('Parent remains available'));
      return streamOf({ ...assistant(), stopReason: 'toolUse', content: Array.from({ length: 9 }, (_, index) => ({ type: 'toolCall', id: `spawn-${index}`, name: 'subagent_spawn', arguments: { title: `Check build ${index + 1}`, task: 'PRIVATE_TASK_SENTINEL' } })) });
    };
    const transport = { model: { ...model, contextWindow: 100_000 }, streamFn: stream };
    await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('Delegate independently'));
    await until(() => childCalls === 8);
    const children = await writer.listSubagents(); assert.equal(children.children.length, 8);
    const ninth = (await writer.load()).executions.find(execution => execution.intent.callId === 'spawn-8')!;
    assert.match(JSON.stringify(ninth.outcome), /capacity/);
    for (const child of children.children) {
      const turn = (await db.store.subagents(writer.miraId).getSubagent(child.id))!.turns[0]!;
      assert.equal(turn.status, 'running'); assert.ok(turn.startedAt); assert.equal(turn.activity.current?.kind, 'model');
      assert.equal(turn.activity.events.length, 1);
    }
    release.resolve(); await until(async () => (await writer.listSubagents()).children.every(child => child.status === 'completed'));
    for (const child of children.children) {
      const turn = (await writer.getSubagent(child.id))!.turns[0]!;
      assert.equal(turn.activity.current, null); assert.ok(turn.finishedAt);
      assert.ok(turn.activity.events.some(event => event.source === 'worker' && event.text === 'Checked the assigned build.'));
      assert.ok(turn.activity.events.some(event => event.kind === 'model' && event.status === 'completed'));
      assert.ok(turn.activity.events.some(event => event.kind === 'tool' && event.status === 'succeeded'));
      assert.doesNotMatch(JSON.stringify(turn.activity), /PRIVATE_REASONING_SENTINEL|PRIVATE_TASK_SENTINEL|arguments/);
    }
    assert.deepEqual(errors, []);
  } finally { release.resolve(); await manager?.close(); await db.close(); }
});

test('PostgreSQL public activity is bounded, rejects raw fields and restart clears current without replay', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire('bounded-activity');
    await seed(writer, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'activity-child', name: 'subagent_spawn', arguments: {} }] }]);
    const state = await writer.load();
    await writer.beginTool(state.version, { callId: 'activity-child', toolName: 'subagent_spawn', assistantRecordId: state.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: now() });
    const child = await writer.createSubagent('activity-child', spec(), 8);
    const turn = await writer.claimSubagentTurn(child.id); assert(turn);
    await assert.rejects(async () => writer.recordSubagentActivity(turn.id, { occurredAt: now(), source: 'runtime', kind: 'tool', phase: 'started', name: 'subagent_spawn', callId: 'activity-child', status: null, text: null }), error => error instanceof SubagentError && error.code === 'invalid');
    const progress: SubagentActivityInput = { occurredAt: now(), source: 'worker', kind: 'progress', phase: 'reported', name: null, callId: null, status: null, text: 'Public check completed.' };
    await assert.rejects(async () => writer.recordSubagentActivity(turn.id, { ...progress, text: '界'.repeat(1000) }), error => error instanceof SubagentError && error.code === 'invalid');
    await assert.rejects(async () => writer.recordSubagentActivity(turn.id, { ...progress, rawArguments: 'SECRET' } as SubagentActivityInput), error => error instanceof SubagentError && error.code === 'invalid');
    for (let index = 0; index < 60; index++) await writer.recordSubagentActivity(turn.id, { ...progress, text: `Public check ${index}` });
    const childWriter = await db.acquire(child.streamId);
    await seed(childWriter, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'child-read', name: 'read', arguments: {} }] }]);
    const childState = await childWriter.load();
    await childWriter.beginTool(childState.version, { callId: 'child-read', toolName: 'read', assistantRecordId: childState.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: now() });
    await writer.recordSubagentActivity(turn.id, { occurredAt: now(), source: 'runtime', kind: 'tool', phase: 'started', name: 'read', callId: 'child-read', status: null, text: null });
    let saved = (await writer.getSubagent(child.id))!.turns[0]!;
    assert.equal(saved.activity.events.length, 40); assert.equal(saved.activity.dropped, 21);
    assert.equal(saved.activity.current?.kind, 'tool'); assert.equal(saved.activity.events[0]!.sequence, 22);
    assert.ok(Buffer.byteLength(JSON.stringify(saved.activity)) < 131_072);
    await writer.close();
    assert.equal((await db.store.subagents('bounded-activity').getSubagent(child.id))!.turns[0]!.activity.current?.kind, 'tool');
    writer = await db.acquire('bounded-activity'); await writer.interruptSubagents();
    saved = (await writer.getSubagent(child.id))!.turns[0]!;
    assert.equal(saved.status, 'interrupted'); assert.equal(saved.activity.current, null);
    assert.equal(saved.activity.events.at(-1)!.status, 'unknown'); assert.equal(saved.activity.events.at(-1)!.phase, 'finished');
    const terminal = structuredClone(saved);
    await writer.recordSubagentActivity(turn.id, progress); await writer.interruptSubagents();
    assert.deepEqual((await writer.getSubagent(child.id))!.turns[0], terminal);
    assert.equal((await db.admin.query("SELECT count(*) FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].count, '1');
  } finally { await db.close(); }
});

test('independent PostgreSQL child/run ownership and pages survive parent history pagination and owner close', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('run-children');
    await writer.receive({ id: 'request', type: 'web.message', source: 'user', occurredAt: now(), payload: {} }, { id: 'request', reason: 'Delegate' });
    const run = await writer.claimWakeBatch(); assert(run);
    await writer.appendWakeInput(run.id, 0, encodeEntry(messageEntry(input('Start'), null)));
    const ids: string[] = [];
    for (let index = 0; index < 55; index++) {
      const callId = `run-spawn-${index}`;
      await seed(writer, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name: 'subagent_spawn', arguments: {} }] }]);
      const state = await writer.load();
      await writer.beginTool(state.version, { callId, toolName: 'subagent_spawn', assistantRecordId: state.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: now() });
      const child = await writer.createSubagent(callId, spec(`Check ${index}`), 8); ids.push(child.id);
      await writer.finishSubagentTurn(child.turns[0]!.id, 'completed', { text: 'Public result', truncated: false, fullResultPath: null, finalRecordId: null });
    }
    // Terminal results now belong to this run. Consume their sourced input
    // through the same append-only API before publishing its final record.
    const live = await writer.loadLiveInputs(run.id); assert.equal(live.length, 55);
    for (const item of live) {
      const rendered = await prepareWakeTurn({ ...run, id: item.request.eventId, claimedAt: item.request.event.occurredAt, requests: [item.request] }, async () => { throw Error('Unexpected overflow'); }, 65_536);
      const state = await writer.load();
      await writer.appendLiveInput(run.id, item.request.wake.id, state.version, encodeEntry(messageEntry({ role: 'user', content: rendered.input, timestamp: Date.parse(rendered.occurredAt) }, state.records.at(-1)!.id)));
    }
    let state = await writer.load();
    await writer.appendWakeFinal(run.id, state.version, encodeEntry(messageEntry(assistant('Done'), state.records.at(-1)!.id))); await writer.completeWakeRun(run.id);
    assert.equal(await writer.claimWakeBatch(), null, 'consumed child results cannot create a duplicate Wake');
    // A genuinely new request creates the next run; it must not own old children.
    await writer.receive({ id: 'next-request', type: 'web.message', source: 'user', occurredAt: now(), payload: {} }, { id: 'next-request', reason: 'New request' });
    const next = await writer.claimWakeBatch(); assert(next); assert.notEqual(next.id, run.id);
    state = await writer.load();
    await writer.appendWakeInput(next.id, state.version, encodeEntry(messageEntry(input('New request'), state.records.at(-1)!.id)));
    const history = await db.store.history(writer.miraId).readRun({ id: run.id, limit: 1 }); assert(history); assert.equal(history.records[0]!.kind, 'context');
    const reader = db.store.subagents(writer.miraId);
    const page = await reader.readSubagentsForRun(run.id); assert.equal(page.children.length, 50); assert(page.nextCursor);
    const older = await reader.readSubagentsForRun(run.id, page.nextCursor); assert.equal(older.children.length, 5); assert.equal(older.nextCursor, null);
    assert.equal(new Set([...page.children, ...older.children].map(child => child.id)).size, 55);
    assert.equal((await reader.getSubagentForRun(ids[0]!, run.id))!.id, ids[0]);
    assert.equal(await reader.getSubagentForRun(ids[0]!, next.id), null);
    assert.equal(await db.store.subagents('another-parent').getSubagentForRun(ids[0]!, run.id), null);
    assert.equal((await reader.readSubagentsForRun(next.id)).children.length, 0);
    await assert.rejects(reader.readSubagentsForRun(next.id, page.nextCursor), error => error instanceof SubagentError && error.code === 'missing');
    const calls = await reader.readSubagentCalls(['run-spawn-0']); assert.equal(calls[0]!.callId, 'run-spawn-0'); assert.equal(calls[0]!.runId, run.id);
    assert.doesNotMatch(JSON.stringify(page), /PRIVATE_TASK_SENTINEL|Public result|instruction|fork/);
    await writer.close();
    assert.deepEqual(await reader.readSubagentsForRun(run.id), page);
    assert.equal((await reader.getSubagentForRun(ids[0]!, run.id))!.id, ids[0]);
    assert.equal(await reader.getSubagentForRun(randomUUID(), run.id), null);
  } finally { await db.close(); }
});


test('restart activity reconciliation preserves a known durable tool outcome across the observation crash window', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('known-activity');
    await seed(writer, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'known-child', name: 'subagent_spawn', arguments: {} }] }]);
    const state = await writer.load();
    await writer.beginTool(state.version, { callId: 'known-child', toolName: 'subagent_spawn', assistantRecordId: state.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: now() });
    const child = await writer.createSubagent('known-child', spec(), 8);
    const turn = await writer.claimSubagentTurn(child.id); assert(turn);
    const childWriter = await db.acquire(child.streamId);
    const longCallId = 'known-effect-' + 'provider-id-'.repeat(100);
    await seed(childWriter, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: longCallId, name: 'read', arguments: {} }] }]);
    const childState = await childWriter.load();
    await childWriter.beginTool(childState.version, { callId: longCallId, toolName: 'read', assistantRecordId: childState.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: now() });
    await writer.recordSubagentActivity(turn.id, { occurredAt: now(), source: 'runtime', kind: 'tool', phase: 'started', name: 'read', callId: longCallId, status: null, text: null });
    await childWriter.finishTool({ callId: longCallId, occurredAt: now(), payload: { opaque: 'Known durable result, no Pi interpretation' } });
    const before = (await writer.getSubagent(child.id))!.turns[0]!.activity;
    assert.equal(before.current?.toolHistoryId, (await db.admin.query('SELECT history_id FROM tool_executions WHERE mira_id=$1 AND call_id=$2', [child.streamId,longCallId])).rows[0].history_id);
    assert.doesNotMatch(JSON.stringify(before), /provider-id-|known-effect-/);
    assert.equal(Object.hasOwn(before.current!, 'callId'), false);
    await writer.close();
    const replacement = await db.acquire('known-activity'); await replacement.interruptSubagents();
    const saved = (await replacement.getSubagent(child.id))!.turns[0]!;
    assert.equal(saved.status, 'interrupted'); assert.equal(saved.activity.current, null);
    assert.equal(saved.activity.events.at(-1)!.status, 'completed', 'Known durable evidence must not be downgraded to unknown');
  } finally { await db.close(); }
});

test('run child pagination discovers newly associated old children despite exhausted pages and a backwards clock', { timeout: 30_000 }, async context => {
  const db = await createTestDatabase();
  context.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-14T00:00:00.000Z') });
  try {
    const writer = await db.acquire('association-order');
    const register = async (callId: string, childId?: string) => {
      const name = childId ? 'subagent_send' : 'subagent_spawn';
      await seed(writer, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name, arguments: {} }] }]);
      const state = await writer.load();
      await writer.beginTool(state.version, { callId, toolName: name, assistantRecordId: state.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: now() });
      const child = childId ? await writer.sendSubagent(callId, childId, 'Inspect the next step', 8) : await writer.createSubagent(callId, spec(callId), 8);
      await writer.finishSubagentTurn(child.turns.at(-1)!.id, 'completed', { text: 'Public result', truncated: false, fullResultPath: null, finalRecordId: null });
      return child;
    };
    const old = await register('old-child');
    context.mock.timers.setTime(Date.parse('2026-10-14T00:01:00.000Z'));
    await writer.receive({ id: 'new-request', type: 'web.message', source: 'user', occurredAt: now(), payload: {} }, { id: 'new-request', reason: 'Delegate current work' });
    const run = await writer.claimWakeBatch(); assert(run);
    const state = await writer.load();
    await writer.appendWakeInput(run.id, state.version, encodeEntry(messageEntry(input('Current work'), state.records.at(-1)!.id)));
    const currentIds: string[] = [];
    for (let index = 0; index < 55; index++) currentIds.push((await register(`current-child-${index}`)).id);
    const reader = db.store.subagents(writer.miraId);
    const first = await reader.readSubagentsForRun(run.id); assert.equal(first.children.length, 50); assert(first.nextCursor);
    const last = await reader.readSubagentsForRun(run.id, first.nextCursor); assert.equal(last.children.length, 5); assert.equal(last.nextCursor, null);
    assert.deepEqual([...first.children, ...last.children].map(child => child.id), [...currentIds].reverse(), 'equal wall-clock times still have a strict append order');
    assert.equal(await reader.getSubagentForRun(old.id, run.id), null);
    const globalBefore = await reader.listSubagents();
    assert.ok(!globalBefore.children.some(child => child.id === old.id));

    context.mock.timers.setTime(Date.parse('2026-10-13T23:00:00.000Z'));
    await register('associate-old-child-now', old.id);
    const refreshed = await reader.readSubagentsForRun(run.id);
    assert.equal(refreshed.children[0]!.id, old.id, 'new run membership belongs at the head even for an old child and a backwards clock');
    assert.equal(refreshed.children[0]!.createdAt, old.createdAt, 'display creation metadata is not rewritten');
    assert.notEqual(refreshed.nextCursor, first.nextCursor);
    assert.equal((await reader.getSubagentForRun(old.id, run.id))!.id, old.id);

    context.mock.timers.setTime(Date.parse('2026-10-15T00:00:00.000Z'));
    await register('follow-already-associated-child', currentIds[0]!);
    assert.deepEqual(await reader.readSubagentsForRun(run.id), refreshed, 'later followups do not move an already associated child or its page boundary');
    assert.deepEqual(await reader.listSubagents(), globalBefore, 'global child creation ordering is unchanged');
    const remaining = await reader.readSubagentsForRun(run.id, refreshed.nextCursor!);
    assert.equal(remaining.nextCursor, null);
    assert.equal(new Set([...refreshed.children, ...remaining.children].map(child => child.id)).size, 56);
    await writer.close();
    assert.deepEqual(await reader.readSubagentsForRun(run.id), refreshed);
  } finally { context.mock.timers.reset(); await db.close(); }
});
