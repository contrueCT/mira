import type { Json } from '@mira/context';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PiDurableRuntime, encodeEntry, messageEntry, jsonValue } from '@mira/runtime-pi';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { LocalWebService } from '@mira/server';
import { writeWakeInput } from '@mira/workspace';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf, model, input, deferred, seed, effectTool, result } from './fixtures.mts';

async function until(check: () => boolean | Promise<boolean>, limit = 10_000) { const end = Date.now() + limit; while (!await check()) { if (Date.now() > end) throw Error('Condition did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const childContext = (messages: Parameters<StreamFn>[1]['messages']) => { const system = getCurrentSystemMessage(messages); return !!system && getSystemMessageText(system).includes('task-scoped worker'); };

test('PostgreSQL actual Pi spawn dedupe, terminal receipt atomicity, followup and independent transcript recovery', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-subagent-pg-')); let manager: SubagentManager | undefined;
  try {
    let writer = await db.acquire('parent'); let childCalls = 0; const failures: unknown[] = [];
    const makeManager = () => new SubagentManager({ writer, acquire: id => db.acquire(id), tools: () => [],
      writeOverflowInput: async (id, content) => { const target = path.join(root, id); await writeFile(target, content); return { path: target, bytes: Buffer.byteLength(content) }; }, onCompletion: () => {}, onFailure: error => failures.push(error) });
    manager = makeManager(); await manager.initialize();
    let phase = 'spawn';
    const stream: StreamFn = (_m, context) => {
      if (childContext(context.messages)) { childCalls++; return streamOf(assistant(`child result ${childCalls}`)); }
      const last = context.messages.at(-1);
      if (last?.role === 'toolResult') return streamOf(assistant('parent finished'));
      if (phase === 'spawn') return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'spawn-pg', name: 'subagent_spawn', arguments: { task: 'independent work', fork: 'all' } }] });
      return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'send-pg', name: 'subagent_send', arguments: { id: phase, message: 'Follow up after restart' } }] });
    };
    const transport = { model: { ...model, contextWindow: 100_000 }, streamFn: stream };
    await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('delegate'));
    await until(async () => (await writer.listSubagents()).children[0]?.status === 'completed');
    const child = (await writer.getSubagent((await writer.listSubagents()).children[0]!.id))!;
    const retry = await manager.spawn('spawn-pg', 'independent work', 'all', transport); assert.equal(retry.id, child.id); assert.equal(childCalls, 1);
    const original = child.turns[0]!; await writer.finishSubagentTurn(original.id, 'completed', original.result!);
    assert.equal((await db.admin.query("SELECT count(*) FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].count, '1');
    assert.equal((await db.admin.query('SELECT count(*) FROM wake_requests WHERE mira_id=$1', ['parent'])).rows[0].count, '1');
    const parentSnapshot = await writer.load();
    assert.ok(!JSON.stringify(parentSnapshot.records).includes('child result 1'), 'result waits as an Event/Wake, never child direct context append');
    assert.equal((await db.admin.query('SELECT count(*) FROM context_records WHERE mira_id=$1', [child.streamId])).rows[0].count > 0, true);
    await manager.close(); await writer.close();
    writer = await db.acquire('parent'); manager = makeManager(); await manager.initialize();
    assert.equal(childCalls, 1, 'restart never reruns terminal child');
    phase = child.id;
    await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('continue worker'));
    await until(async () => (await writer.getSubagent(child.id))?.turns[1]?.status === 'completed');
    const after = await writer.getSubagent(child.id); assert.equal(after!.turns.length, 2); assert.deepEqual(after!.turns[0], original); assert.equal(childCalls, 2);
    assert.deepEqual(failures, []);
  } finally { await manager?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real web service keeps parent available, child completion wakes an idle parent once, Memory is unchanged and run details stay bounded', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-subagent-web-')); let service: LocalWebService | undefined;
  const release = deferred(); let childCalls = 0; let parentCalls = 0;
  try {
    const stream: StreamFn = async (_m, context) => {
      if (childContext(context.messages)) { childCalls++; await release.promise; return streamOf(assistant('CHILD_PRIVATE_RAW_FINDING')); }
      parentCalls++;
      if (parentCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'web-spawn', name: 'subagent_spawn', arguments: { task: 'Research the assigned subject' } }] });
      return streamOf(assistant(`Parent response ${parentCalls}`));
    };
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'web-parent', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'settings.json'), workingDirectory: root, memoryRoot: path.join(root, 'Memory'), miraHome: root, synthetic: true, syntheticStream: stream, dreaming: { enabled: false } };
    service = await LocalWebService.open(options);
    const memoryBefore = await readFile(path.join(root, 'Memory', 'MEMORY.md'), 'utf8');
    await service.submit({ id: 'web-delegate', text: 'Delegate and continue', occurredAt: '2026-10-14T00:00:00Z' });
    await until(async () => (await service!.status()).state === 'idle'); assert.equal(parentCalls, 2); assert.equal(childCalls, 1);
    await service.submit({ id: 'web-new-user', text: 'A new user question while the child works', occurredAt: '2026-10-14T00:01:00Z' });
    await until(async () => (await service!.status()).state === 'idle'); assert.equal(parentCalls, 3);
    release.resolve(); await until(() => parentCalls === 4); await until(async () => (await service!.status()).state === 'idle');
    assert.equal(await readFile(path.join(root, 'Memory', 'MEMORY.md'), 'utf8'), memoryBefore);
    const timeline = await service.timeline(); assert.ok(!JSON.stringify(timeline).includes('CHILD_PRIVATE_RAW_FINDING'), 'child output is only relayed when main model chooses to');
    assert.ok(timeline.items.every(item => !Object.hasOwn(item, 'child') && (item.text || item.attachments?.length)), 'no child-only rows or empty timestamps in chat');
    assert.ok(timeline.items.some(item => item.text === 'Parent response 4'), 'ordinary parent replies remain visible');
    const runs = await service.runs(); const details = await Promise.all(runs.items.map(run => service!.run(run.id)));
    assert.ok(details.every(d => d!.executions.every(e => !Object.hasOwn(e, 'supplemental') && !e.name?.includes('(latest activity)'))));
    const childPages = await Promise.all(runs.items.map(run => service!.children(run.id)));
    const childSummary = childPages.flatMap(page => page.items)[0]!; assert.ok(childSummary);
    const childDetail = await service.child(childSummary.runId, childSummary.id); assert(childDetail);
    assert.equal(childDetail.status, 'completed'); assert.equal(childDetail.current, null);
    assert.equal(childDetail.turns[0]!.result?.text, 'CHILD_PRIVATE_RAW_FINDING');
    assert.ok(!JSON.stringify(details).includes('CHILD_PRIVATE_RAW_FINDING'));
    const ownerPid = (await db.admin.query("SELECT l.pid FROM pg_locks l JOIN mira_owners o ON l.objid=o.lock_key::oid WHERE l.locktype='advisory' AND l.classid=1296650817::oid AND l.objsubid=2 AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND o.mira_id='web-parent'")).rows[0].pid;
    await db.admin.query('SELECT pg_terminate_backend($1)', [ownerPid]);
    await until(async () => (await service!.status()).state === 'stopped');
    const afterLoss = await Promise.all(runs.items.map(run => service!.run(run.id)));
    assert.equal(afterLoss.length, details.length);
    assert.ok(afterLoss.every(d => d!.executions.every(e => !Object.hasOwn(e, 'supplemental'))));
    assert.equal((await service.child(childSummary.runId, childSummary.id))?.status, 'completed');
    await service.close(); service = await LocalWebService.open(options); await until(async () => (await service!.status()).state === 'idle'); assert.equal(parentCalls, 4); assert.equal(childCalls, 1);
  } finally { release.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('parent ownership loss interrupts real child effects; restart preserves unknown evidence and does not replay', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const entered = deferred(); let manager: SubagentManager | undefined; let effectCount = 0;
  try {
    let writer = await db.acquire('lost-parent'); let childId = '';
    const makeManager = () => new SubagentManager({ writer, acquire: id => db.acquire(id), tools: () => [effectTool(async (_id, _args, signal) => {
      effectCount++; entered.resolve(); await new Promise<void>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); return result;
    })], writeOverflowInput: async () => { throw Error('unused'); }, onCompletion: () => {}, onFailure: () => {} });
    manager = makeManager();
    const stream: StreamFn = (_m, context) => {
      if (childContext(context.messages)) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'unknown-child-effect', name: 'effect', arguments: {} }] });
      if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('delegated'));
      return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'lost-spawn', name: 'subagent_spawn', arguments: { task: 'Execute assigned work' } }] });
    };
    const transport = { model, streamFn: stream };
    await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('delegate'));
    await entered.promise; childId = (await writer.listSubagents()).children[0]!.id;
    await writer.close(); await manager.close();
    writer = await db.acquire('lost-parent'); manager = makeManager(); await manager.initialize();
    const c = (await writer.getSubagent(childId))!; assert.equal(c.turns[0]!.status, 'interrupted'); assert.equal(effectCount, 1);
    assert.equal(c.turns[0]!.activity.current, null); assert.equal(c.turns[0]!.activity.events.at(-1)?.status, 'unknown');
    const rows = await db.admin.query('SELECT outcome FROM tool_executions WHERE mira_id=$1', [c.streamId]); assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].outcome, null);
    let observedUnknown = false;
    const resumedTransport = { model, streamFn: ((_m, context) => {
      if (childContext(context.messages)) { observedUnknown = JSON.stringify(context.messages).includes('no durable outcome exists'); return streamOf(assistant('Unknown effect inspected, no replay')); }
      if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('followup sent'));
      return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'resume-lost-child', name: 'subagent_send', arguments: { id: childId, message: 'Inspect the interrupted work, do not repeat the effect' } }] });
    }) as StreamFn };
    await new PiDurableRuntime({ writer, ...resumedTransport, tools: createSubagentTools(manager, resumedTransport) }).run(input('inspect worker'));
    await until(async () => (await writer.getSubagent(childId))?.turns[1]?.status === 'completed');
    assert.equal(observedUnknown, true); assert.equal(effectCount, 1);
    assert.match(JSON.stringify((await db.admin.query('SELECT envelope FROM context_records WHERE mira_id=$1', [c.streamId])).rows), /outcome-unknown/);
  } finally { await manager?.close(); await db.close(); }
});

test('SIGKILL during a real child effect releases writer ownership; restart does not replay or erase unknown evidence', { timeout: 30_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-subagent-kill-')); const marker = path.join(root, 'effect.txt');
  let manager: SubagentManager | undefined;
  const worker = spawn(process.execPath, [fileURLToPath(new URL('./subagent-process-worker.mts', import.meta.url)), db.schema, marker], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env['PATH'], HOME: root, MIRA_TEST_DATABASE_URL: db.connectionString, NODE_OPTIONS: process.env['NODE_OPTIONS'] },
  });
  try {
    await Promise.race([once(worker, 'message'), once(worker, 'exit').then(([code]) => { throw Error(`Child fixture exited prematurely (${code})`); })]);
    assert.equal(await readFile(marker, 'utf8'), 'effect dispatched once');
    const exit = once(worker, 'exit'); worker.kill('SIGKILL'); await exit;
    const writer = await db.acquire('killed-parent');
    let requests = 0;
    manager = new SubagentManager({ writer, acquire: id => db.acquire(id), tools: () => [], writeOverflowInput: async () => { throw Error('unused'); }, onCompletion: () => {}, onFailure: () => {} });
    await manager.initialize(); const child = (await writer.getSubagent((await writer.listSubagents()).children[0]!.id))!;
    assert.equal(child.turns[0]!.status, 'interrupted');
    assert.equal(child.turns[0]!.activity.current, null); assert.equal(child.turns[0]!.activity.events.at(-1)?.status, 'unknown');
    const executions = await db.admin.query('SELECT intent,outcome FROM tool_executions WHERE mira_id=$1', [child.streamId]);
    assert.equal(executions.rows.length, 1); assert.equal(executions.rows[0].intent.callId, 'killed-effect'); assert.equal(executions.rows[0].outcome, null);
    const transport = { model, streamFn: ((_m, context) => {
      requests++; if (childContext(context.messages)) { assert.match(JSON.stringify(context.messages), /no durable outcome exists/); return streamOf(assistant('Unknown effect retained without replay')); }
      if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('explicit followup sent'));
      return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'after-kill-send', name: 'subagent_send', arguments: { id: child.id, message: 'Inspect unknown effect; do not repeat it' } }] });
    }) as StreamFn };
    assert.equal(requests, 0, 'initialize must not call a model');
    await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('inspect interrupted delegation'));
    await until(async () => (await writer.getSubagent(child.id))?.turns[1]?.status === 'completed');
    assert.equal((await db.admin.query('SELECT count(*) FROM tool_executions WHERE mira_id=$1', [child.streamId])).rows[0].count, '1');
    assert.equal(await readFile(marker, 'utf8'), 'effect dispatched once');
  } finally { if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL'); await manager?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('terminal result and parent Wake roll back together on a failed database transaction', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire('atomic-parent');
    await seed(writer, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'atomic-spawn', name: 'subagent_spawn', arguments: { task: 'atomic fixture' } }] }]);
    const state = await writer.load();
    await writer.beginTool(state.version, { callId: 'atomic-spawn', assistantRecordId: state.records.at(-1)!.id, toolName: 'subagent_spawn', requestedArguments: { task: 'atomic fixture' }, arguments: { task: 'atomic fixture' }, occurredAt: new Date().toISOString() });
    const child = await writer.createSubagent('atomic-spawn', { task: 'atomic fixture', fork: { mode: 'none', text: '', bytes: 0, parentVersion: state.version, parentHead: state.records.at(-1)!.id }, model: { provider: model.provider, id: model.id, api: model.api, configurationHash: 'a'.repeat(64) } }, 4);
    const turn = (await writer.claimSubagentTurn(child.id))!;
    await db.admin.query(`CREATE FUNCTION fail_child_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event->>'type'='subagent.result' THEN RAISE EXCEPTION 'synthetic receipt failure'; END IF; RETURN NEW; END $$`);
    await db.admin.query('CREATE TRIGGER fail_child_receipt BEFORE INSERT ON life_events FOR EACH ROW EXECUTE FUNCTION fail_child_receipt()');
    await assert.rejects(writer.finishSubagentTurn(turn.id, 'completed', { text: 'result', truncated: false, fullResultPath: null, finalRecordId: null }));
    assert.equal((await db.admin.query('SELECT status FROM subagent_turns WHERE turn_id=$1', [turn.id])).rows[0].status, 'running');
    assert.equal((await db.admin.query("SELECT count(*) FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].count, '0');
    assert.equal((await db.admin.query('SELECT count(*) FROM wake_requests WHERE mira_id=$1', ['atomic-parent'])).rows[0].count, '0');
    await writer.close(); await db.admin.query('DROP TRIGGER fail_child_receipt ON life_events');
    writer = await db.acquire('atomic-parent'); await writer.interruptSubagents();
    assert.equal((await writer.getSubagent(child.id))!.turns[0]!.status, 'interrupted');
    assert.equal((await db.admin.query("SELECT count(*) FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].count, '1');
    assert.equal((await db.admin.query('SELECT count(*) FROM wake_requests WHERE mira_id=$1', ['atomic-parent'])).rows[0].count, '1');
  } finally { await db.close(); }
});


test('registry metadata is paginated in SQL and recent-turn reads remain bounded after lifetime growth and owner loss', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('bounded-parent');
    const invoke = async <T,>(id: string, toolName: string, args: Record<string, Json>, action: () => Promise<T>): Promise<T> => {
      await seed(writer, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name: toolName, arguments: args }] }]);
      const state = await writer.load();
      await writer.beginTool(state.version, { callId: id, assistantRecordId: state.records.at(-1)!.id, toolName, requestedArguments: args, arguments: args, occurredAt: new Date().toISOString() });
      const value = await action();
      const message = { role: 'toolResult' as const, toolCallId: id, toolName, content: [{ type: 'text' as const, text: 'synthetic registry fixture receipt' }], isError: false, timestamp: Date.now() };
      await writer.finishTool({ callId: id, occurredAt: new Date(message.timestamp).toISOString(), payload: jsonValue(message) });
      await writer.append(state.version, encodeEntry(messageEntry(message, state.records.at(-1)!.id)));
      return value;
    };
    const ids: string[] = [];
    for (let index=0; index<55; index++) {
      const callId = `bounded-spawn-${index}`;
      const child = await invoke(callId,'subagent_spawn',{task:'PRIVATE_TASK_BODY'}, async () => {
        const state = await writer.load(); const text = 'PRIVATE_FROZEN_CONTEXT '.repeat(100);
        return writer.createSubagent(callId, { task: 'PRIVATE_TASK_BODY', fork: { mode: 'all', text, bytes: Buffer.byteLength(text), parentVersion: state.version, parentHead: state.records.at(-1)!.id }, model: { provider:model.provider,id:model.id,api:model.api,configurationHash:'a'.repeat(64) } },4);
      });
      ids.push(child.id);
      await writer.finishSubagentTurn(child.turns[0]!.id,'completed',{text:'PRIVATE_RESULT_BODY',truncated:false,fullResultPath:null,finalRecordId:null});
    }
    for (let index=0; index<12; index++) {
      const callId = `bounded-follow-${index}`;
      const child = await invoke(callId,'subagent_send',{id:ids[0]!,message:'PRIVATE_FOLLOWUP_BODY'}, () => writer.sendSubagent(callId,ids[0]!,'PRIVATE_FOLLOWUP_BODY',4));
      await writer.finishSubagentTurn(child.turns.at(-1)!.id,'completed',{text:'PRIVATE_RESULT_BODY',truncated:false,fullResultPath:null,finalRecordId:null});
    }
    const page = await writer.listSubagents(); assert.equal(page.children.length,50); assert.ok(page.nextCursor);
    const older = await writer.listSubagents(page.nextCursor!); assert.equal(older.children.length,5); assert.equal(older.nextCursor,null);
    assert.equal(new Set([...page.children,...older.children].map(child=>child.id)).size,55);
    assert.doesNotMatch(JSON.stringify(page),/PRIVATE_TASK_BODY|PRIVATE_FROZEN_CONTEXT|PRIVATE_RESULT_BODY|PRIVATE_FOLLOWUP_BODY/);
    const child = (await writer.getSubagent(ids[0]!))!;
    assert.equal(child.turnCount,13); assert.equal(child.turns.length,8); assert.equal(child.turns[0]!.sequence,6);
    const original = await writer.findSubagentCall('bounded-spawn-0'); assert.equal(original!.turn.sequence,1); assert.equal(original!.child.turns.length,8);
    const calls = await writer.readSubagentCalls(['bounded-spawn-0','bounded-follow-0']); assert.equal(calls.length,2);
    assert.doesNotMatch(JSON.stringify(calls),/PRIVATE_/);
    await writer.close();
    const readOnly = db.store.subagents('bounded-parent');
    assert.deepEqual(await readOnly.listSubagents(),page);
    assert.equal((await readOnly.getSubagent(ids[0]!))!.turns.length,8);
    assert.deepEqual(await readOnly.readSubagentCalls(['bounded-spawn-0','bounded-follow-0']),calls);
    assert.deepEqual(await db.store.subagents('different-parent').readSubagentCalls(['bounded-spawn-0']),[]);
  } finally { await db.close(); }
});

test('PostgreSQL pre-input child interruption retains original assignment and frozen constraints on explicit followup', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  let writer = await db.acquire('pre-input-parent'); let manager: SubagentManager | undefined;
  let phase = 'spawn'; let childId = ''; let childCalls = 0; let seen = '';
  const stream: StreamFn = (_m, context) => {
    if (childContext(context.messages)) { childCalls++; seen = JSON.stringify(context.messages); return streamOf(assistant('recovered task')); }
    if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('parent available'));
    return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: `pre-input-${phase}`, name: phase === 'spawn' ? 'subagent_spawn' : 'subagent_send', arguments: phase === 'spawn' ? { task: 'ORIGINAL_TASK_SENTINEL', fork: 'all' } : { id: childId, message: 'FOLLOWUP_SENTINEL: inspect interrupted work' } }] });
  };
  const transport = { model: { ...model, contextWindow: 100_000 }, streamFn: stream };
  const makeManager = (failBeforeInput: boolean) => new SubagentManager({ writer, acquire: async id => {
    if (failBeforeInput) throw new Error('Synthetic process initialization interruption before child input');
    return db.acquire(id);
  }, tools: () => [], writeOverflowInput: async () => { throw Error('Unexpected overflow'); }, onCompletion: () => {}, onFailure: error => { throw error; } });
  try {
    manager = makeManager(true); await manager.initialize();
    await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('FROZEN_CONSTRAINT_SENTINEL: delegate the task'));
    await until(async () => (await writer.listSubagents()).children[0]?.status === 'interrupted');
    childId = (await writer.listSubagents()).children[0]!.id;
    const child = (await writer.getSubagent(childId))!;
    assert.equal((await db.admin.query('SELECT count(*) FROM context_records WHERE mira_id=$1', [child.streamId])).rows[0].count, '0');
    assert.equal(childCalls, 0);
    await manager.close(); await writer.close();
    writer = await db.acquire('pre-input-parent'); manager = makeManager(false); await manager.initialize();
    phase = 'followup';
    await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('Explicitly resume the worker'));
    await until(async () => (await writer.getSubagent(childId))?.turns.at(-1)?.status === 'completed');
    assert.equal(childCalls, 1);
    assert.match(seen, /ORIGINAL_TASK_SENTINEL/); assert.match(seen, /FROZEN_CONSTRAINT_SENTINEL/); assert.match(seen, /FOLLOWUP_SENTINEL/);
    assert.match(seen, /quoted reference data/);
    assert.equal((await writer.getSubagent(childId))!.turns[0]!.status, 'interrupted');
  } finally { await manager?.close(); await writer.close(); await db.close(); }
});

test('child auto-compaction checkpoints survive PostgreSQL restart without main Memory or Dreaming state', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-subagent-compaction-')); let manager: SubagentManager | undefined;
  const writeOverflowInput = (runId: string, content: string) => writeWakeInput({ rootDirectory: root, sourceDirectory: process.cwd(), runId, content });
  try {
    let writer = await db.acquire('compact-parent'); await writer.initializeDreaming();
    const beforeDreaming = (await db.admin.query("SELECT checkpoint_version, consumed_receipt_order, last_triggered_at FROM dreaming_progress WHERE mira_id='compact-parent'")).rows;
    const failures: unknown[] = []; let summaries = 0; let calls = 0; let latest = '';
    const transport = { model, streamFn: ((_m, context) => {
      const system = getSystemMessageText(getCurrentSystemMessage(context.messages)!);
      if (system.includes('Summarize this task-scoped worker')) {
        summaries++;
        const data = JSON.parse(String(context.messages.find(m => m.role === 'user')?.content));
        assert.equal(data.memory_snapshot, null); assert.match(data.persona_context, /task-scoped worker/);
        return streamOf(assistant('PG_TASK_SUMMARY: read-only research remains pending; preserve sources.'));
      }
      calls++; latest = JSON.stringify(context.messages);
      return streamOf(assistant(`step-${calls}: ${'bounded research evidence '.repeat(60)}`));
    }) as StreamFn };
    const makeManager = () => new SubagentManager({ writer, acquire: id => db.acquire(id), tools: () => [],
      writeOverflowInput, onCompletion: () => {}, onFailure: error => failures.push(error) });
    manager = makeManager(); await manager.initialize();
    const parentCall = async (callId: string, name: string, args: Record<string, string>) => {
      let requested = false;
      const runtime = new PiDurableRuntime({ writer, writeOverflowInput, model: { ...model, contextWindow: 1_000_000 }, autoCompaction: { enabled: false },
        tools: createSubagentTools(manager!, transport), streamFn: () => {
          if (requested) return streamOf(assistant('Delegation recorded'));
          requested = true;
          return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name, arguments: args }] });
        } });
      const context = await runtime.run(input(`Dispatch ${callId}`));
      const result = context.entries.find(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === callId);
      assert.ok(result?.type === 'message' && result.message.role === 'toolResult');
      const text = result.message.content.find(block => block.type === 'text'); assert.ok(text?.type === 'text');
      return JSON.parse(text.text) as { id: string };
    };
    const c = await parentCall('pg-compaction', 'subagent_spawn', { task: 'Read-only investigation' });
    await until(async () => (await writer.getSubagent(c.id))!.turns.at(-1)!.status === 'completed');
    for (let i = 1; i <= 24 && summaries === 0; i++) {
      await parentCall(`pg-followup-${i}`, 'subagent_send', { id: c.id, message: `Continue ${i}` });
      await until(async () => (await writer.getSubagent(c.id))!.turns.at(-1)!.status === 'completed');
    }
    assert.equal(summaries, 1); const child = (await writer.getSubagent(c.id))!;
    const records = (await db.admin.query('SELECT envelope FROM context_records WHERE mira_id=$1 ORDER BY version', [child.streamId])).rows;
    assert.equal(records.filter(row => row.envelope.kind === 'checkpoint').length, 1);
    assert.equal((await writer.load()).records.filter(record => record.kind === 'checkpoint').length, 0);
    assert.doesNotMatch(JSON.stringify(records), /miraMemory/);
    assert.deepEqual((await db.admin.query("SELECT checkpoint_version, consumed_receipt_order, last_triggered_at FROM dreaming_progress WHERE mira_id='compact-parent'")).rows, beforeDreaming);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM dreaming_progress WHERE mira_id LIKE 'subagent:%'")).rows[0].n, 0);
    await manager.close(); await writer.close();
    const beforeCalls = calls; writer = await db.acquire('compact-parent'); manager = makeManager(); await manager.initialize();
    assert.equal(calls, beforeCalls); assert.equal(summaries, 1);
    await parentCall('pg-after-restart', 'subagent_send', { id: c.id, message: 'RESTART_FOLLOWUP: inspect the preserved findings' });
    await until(async () => (await writer.getSubagent(c.id))!.turns.at(-1)!.status === 'completed');
    assert.match(latest, /PG_TASK_SUMMARY/); assert.match(latest, /RESTART_FOLLOWUP/);
    assert.equal(calls, beforeCalls + 1);
    const after = (await db.admin.query('SELECT envelope FROM context_records WHERE mira_id=$1 ORDER BY version', [child.streamId])).rows;
    assert.deepEqual(after.slice(0, records.length), records);
    assert.equal((await writer.load()).records.filter(record => record.kind === 'checkpoint').length, 0); assert.deepEqual(failures, []);
  } finally { await manager?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
