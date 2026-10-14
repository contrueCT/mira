import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf, model, input, deferred, seed, effectTool, result } from './fixtures.mts';

async function until(check: () => boolean | Promise<boolean>, limit = 10_000) { const end = Date.now() + limit; while (!await check()) { if (Date.now() > end) throw Error('Condition did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } }
const childContext = (messages: Parameters<StreamFn>[1]['messages']) => { const system = getCurrentSystemMessage(messages); return !!system && getSystemMessageText(system).includes('task-scoped worker'); };

test('PostgreSQL actual Pi spawn dedupe, terminal receipt atomicity, followup and independent transcript recovery', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-subagent-pg-'); let manager: SubagentManager | undefined;
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
    await until(async () => (await writer.listSubagents())[0]?.turns[0]?.status === 'completed');
    const child = (await writer.listSubagents())[0]!;
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
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-subagent-web-'); let service: LocalWebService | undefined;
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
    const runs = await service.runs(); const details = await Promise.all(runs.items.map(run => service!.run(run.id)));
    assert.ok(details.some(d => d!.executions.some(e => e.kind === 'subagent' && e.status === 'completed')));
    assert.ok(!JSON.stringify(details).includes('CHILD_PRIVATE_RAW_FINDING'));
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
    await entered.promise; childId = (await writer.listSubagents())[0]!.id;
    await writer.close(); await manager.close();
    writer = await db.acquire('lost-parent'); manager = makeManager(); await manager.initialize();
    const c = (await writer.getSubagent(childId))!; assert.equal(c.turns[0]!.status, 'interrupted'); assert.equal(effectCount, 1);
    const rows = await db.admin.query('SELECT outcome FROM tool_executions WHERE mira_id=$1', [c.streamId]); assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].outcome, null);
    let observedUnknown = false;
    const resumedTransport = { model, streamFn: ((_m, context) => {
      if (childContext(context.messages)) { observedUnknown = JSON.stringify(context.messages).includes('outcome-unknown'); return streamOf(assistant('Unknown effect inspected, no replay')); }
      if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('followup sent'));
      return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'resume-lost-child', name: 'subagent_send', arguments: { id: childId, message: 'Inspect the interrupted work, do not repeat the effect' } }] });
    }) as StreamFn };
    await new PiDurableRuntime({ writer, ...resumedTransport, tools: createSubagentTools(manager, resumedTransport) }).run(input('inspect worker'));
    await until(async () => (await writer.getSubagent(childId))?.turns[1]?.status === 'completed');
    assert.equal(observedUnknown, true); assert.equal(effectCount, 1);
  } finally { await manager?.close(); await db.close(); }
});

test('SIGKILL during a real child effect releases writer ownership; restart does not replay or erase unknown evidence', { timeout: 30_000 }, async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-subagent-kill-'); const marker = path.join(root, 'effect.txt');
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
    await manager.initialize(); const child = (await writer.listSubagents())[0]!;
    assert.equal(child.turns[0]!.status, 'interrupted');
    const executions = await db.admin.query('SELECT intent,outcome FROM tool_executions WHERE mira_id=$1', [child.streamId]);
    assert.equal(executions.rows.length, 1); assert.equal(executions.rows[0].intent.callId, 'killed-effect'); assert.equal(executions.rows[0].outcome, null);
    const transport = { model, streamFn: ((_m, context) => {
      requests++; if (childContext(context.messages)) { assert.match(JSON.stringify(context.messages), /outcome-unknown/); return streamOf(assistant('Unknown effect retained without replay')); }
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
