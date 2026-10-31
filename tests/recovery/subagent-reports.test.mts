import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import type { JsonObject, TranscriptContext } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { LocalWebService } from '@mira/server';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { writeWakeInput } from '@mira/workspace';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf, model, input } from './fixtures.mts';

// ADR 0052: real PostgreSQL + service. task_report summary/question, delegated
// extension capabilities, attachments by reference, one Wake per group,
// subagent_close, and in-memory/connection retention returning to baseline.
async function until(check: () => Promise<boolean> | boolean, message: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const call = (id: string, name: string, args: JsonObject) => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }] });
const calls = (...items: Array<[string, string, JsonObject]>) => streamOf({ ...assistant(), stopReason: 'toolUse', content: items.map(([id, name, args]) => ({ type: 'toolCall' as const, id, name, arguments: args })) });
const conversation = (context: TranscriptContext) => JSON.stringify(context.messages.filter(message => message.role !== 'system'));
const isChild = (context: TranscriptContext) => (getCurrentSystemPrompt(context.messages) ?? '').includes('task-scoped worker');
const resultOf = (context: TranscriptContext, id: string) => { const found = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id); return found ? JSON.stringify(found.content) : null; };
const toolResultText = (context: TranscriptContext, id: string) => { const found = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id); return found?.role === 'toolResult' ? found.content.map(block => block.type === 'text' ? block.text : '').join('') : null; };
const TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
// A real RGBA PNG with correct CRCs, so Pi's raster decoder accepts it.
function realPng(width: number, height: number): Buffer {
  const chunk = (name: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(name), data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length + 12); out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 4 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const png = realPng(8, 8);

async function setup(prefix: string) {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp(`/tmp/${prefix}-`));
  const base = { connectionString: db.connectionString, schema: db.schema, sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, autoCompaction: { enabled: false as const }, dreaming: { enabled: false } };
  return { db, root, base, cleanup: async () => { await db.close(); await rm(root, { recursive: true, force: true }); } };
}
const idle = (service: LocalWebService) => until(async () => (await service.status()).state !== 'working' && service.activity().subagents === 0, 'work did not settle');

test('real PG/service: a worker with an extension capability and an image reports a question; Mira answers it on the same transcript; every tool name is dot-free', { timeout: 90_000 }, async () => {
  const { root, base, db, cleanup } = await setup('mira-subagent-report'); let service: LocalWebService | undefined;
  const extension = path.join(root, 'helper.mjs');
  await writeFile(extension, `import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
    export default defineExtension({ name: 'helper', apply(ctx) {
      ctx.registerTool({ name: 'helper_lookup', description: 'Look something up', parameters: { type: 'object', properties: {} }, execute: async () => ({ text: 'LOOKUP_OK' }) });
      ctx.registerTool({ name: 'helper_notify', mainOnly: true, description: 'Message the user', parameters: { type: 'object', properties: {} }, execute: async () => ({ text: 'SENT' }) });
      ctx.registerTool({ name: 'helper_remind', description: 'Set a reminder', parameters: { type: 'object', properties: {} }, execute: async () => {
        try { await ctx.schedules.create({ key: 'k', dueAt: new Date(Date.now() + 60000).toISOString(), event: { id: 'e', type: 'reminder', occurredAt: new Date().toISOString(), payload: {} } }); return { text: 'SCHEDULED' }; }
        catch (error) { return { text: String(error.message), isError: true }; } } });
    } });`);
  const mainTools = new Set<string>(); const childTools = new Set<string>(); const mainContexts: TranscriptContext[] = []; const childContexts: TranscriptContext[] = [];
  let childId = ''; let attachmentId = '';
  const options = { ...base, miraId: 'subagent-report', syntheticModel: { ...model, input: ['text', 'image'] as Array<'text' | 'image'>, contextWindow: 65_536 },
    extensions: { entries: [{ id: 'helper', path: extension }] },
    syntheticStream: (_model: unknown, context: TranscriptContext) => {
      const text = conversation(context);
      if (isChild(context)) {
        childContexts.push(context);
        for (const tool of getCurrentTools(context.messages)) childTools.add(tool.name);
        if (text.includes('ANSWER_42')) {
          if (resultOf(context, 'c-report-2') === null) return call('c-report-2', 'task_report', { summary: 'Done with 42. Wrote nothing; checked lookup.' });
          return streamOf(assistant('Finished with the answer.'));
        }
        if (resultOf(context, 'c-lookup') === null) return call('c-lookup', 'helper_lookup', {});
        if (resultOf(context, 'c-remind') === null) return call('c-remind', 'helper_remind', {});
        if (resultOf(context, 'c-report') === null) return call('c-report', 'task_report', { summary: 'Lookup works; reminder refused.', question: 'Which number should I use?' });
        return streamOf(assistant('FULL_CHILD_REPLY waiting for an answer.'));
      }
      mainContexts.push(context);
      for (const tool of getCurrentTools(context.messages)) mainTools.add(tool.name);
      const spawned = resultOf(context, 'm-spawn');
      if (spawned === null) return call('m-spawn', 'subagent_spawn', { title: 'Lookup', task: 'CHILD_A use the helper', capabilities: ['helper'], attachments: [attachmentId] });
      childId = /\\"id\\":\\"([0-9a-f-]{36})\\"/.exec(spawned)?.[1] ?? childId;
      if (text.includes('Which number should I use?') && resultOf(context, 'm-list') === null) return call('m-list', 'subagent_status', {});
      if (resultOf(context, 'm-list') !== null && resultOf(context, 'm-send') === null) return call('m-send', 'subagent_send', { id: childId, message: 'ANSWER_42' });
      return streamOf(assistant('NO_REPLY'));
    } };
  try {
    service = await LocalWebService.open(options);
    attachmentId = (await service.uploadAttachment('dot.png', png)).id;
    await service.submit({ id: 'go', text: '查一下', occurredAt: new Date().toISOString(), attachmentIds: [attachmentId] });
    await until(() => mainContexts.some(context => conversation(context).includes('Done with 42')), 'second report did not reach Mira', 40_000);
    await idle(service);
    // Capabilities: delegable tools only, schedules refused inside a delegated call.
    assert.ok(childTools.has('helper_lookup') && childTools.has('helper_remind') && childTools.has('task_report'));
    assert.ok(!childTools.has('helper_notify'), 'mainOnly tools never reach a worker');
    for (const name of ['subagent_spawn', 'subagent_close', 'send_reply', 'extension_manage']) assert.ok(!childTools.has(name), name);
    assert.ok(mainTools.has('helper_notify') && mainTools.has('subagent_close') && !mainTools.has('task_report'));
    for (const name of [...mainTools, ...childTools]) assert.match(name, TOOL_NAME);
    const firstChild = childContexts.find(context => resultOf(context, 'c-remind') !== null)!;
    assert.equal(toolResultText(firstChild, 'c-lookup'), 'LOOKUP_OK');
    assert.match(toolResultText(firstChild, 'c-remind')!, /Schedules are main-only/);
    // Attachment by reference: the worker sees the image natively.
    const assignment = childContexts[0]!.messages.find(message => message.role === 'user')!;
    assert.ok(Array.isArray(assignment.content) && assignment.content.some(block => block.type === 'image'), 'image block in the child request');
    assert.match(JSON.stringify(assignment.content), /dot\.png/);
    // The question Wake leads with summary/question; full reply by path only.
    const events = (await db.admin.query("SELECT event, requested_wake FROM life_events WHERE event->>'type'='subagent.result' ORDER BY history_id")).rows;
    assert.equal(events.length, 2); assert.ok(events.every(row => row.requested_wake !== null));
    const first = events.find(row => row.event.payload.question)!.event.payload;
    assert.deepEqual(Object.keys(first).slice(0, 3), ['summary', 'question', 'childId']);
    assert.equal(first.question, 'Which number should I use?');
    assert.equal(first.result.text, undefined); assert.ok(first.result.fullResultPath);
    assert.match(first.awaiting, /subagent_send/);
    const listed = JSON.parse(JSON.parse(resultOf(mainContexts.find(context => resultOf(context, 'm-list') !== null)!, 'm-list')!)[0].text);
    assert.equal(listed.children.length, 1);
    assert.match(listed.children[0], /"Lookup" · completed · has pending question$/);
    // The answer continued the same transcript; the second report has no question.
    const turns = (await db.admin.query('SELECT sequence, status, result FROM subagent_turns ORDER BY sequence')).rows;
    assert.deepEqual(turns.map(row => [row.sequence, row.status]), [[1, 'completed'], [2, 'completed']]);
    assert.equal(turns[1].result.report.summary, 'Done with 42. Wrote nothing; checked lookup.'); assert.equal(turns[1].result.report.question, undefined);
    assert.match(turns[0].result.text, /FULL_CHILD_REPLY/);
    // Nothing of this reaches the chat.
    assert.doesNotMatch(JSON.stringify(await service.timeline()), /Lookup|task_report|subagent|Which number/);
  } finally { await service?.close(); await cleanup(); }
});

test('real PG/service: a group wakes Mira once with every member; an unreported result keeps raw text; a closed worker refuses followups', { timeout: 90_000 }, async () => {
  const { base, db, cleanup } = await setup('mira-subagent-group'); let service: LocalWebService | undefined;
  const mainContexts: TranscriptContext[] = []; const ids: string[] = [];
  const options = { ...base, miraId: 'subagent-group', subagentConcurrency: 4,
    syntheticStream: (_model: unknown, context: TranscriptContext) => {
      const text = conversation(context);
      if (isChild(context)) {
        if (text.includes('MEMBER_SLOW') && resultOf(context, 'c-wait') === null) return call('c-wait', 'bash', { command: 'sleep 0.6' });
        if (text.includes('MEMBER_SLOW') && resultOf(context, 'c-done') === null) return call('c-done', 'task_report', { summary: 'Slow member finished.' });
        if (text.includes('MEMBER_SLOW')) return streamOf(assistant('Slow done.'));
        return streamOf(assistant('RAW_FAST_RESULT plain text'));
      }
      mainContexts.push(context);
      if (resultOf(context, 'g1') === null) return calls(['g1', 'subagent_spawn', { title: 'Fast', task: 'MEMBER_FAST', group: 'batch' }], ['g2', 'subagent_spawn', { title: 'Slow', task: 'MEMBER_SLOW', group: 'batch' }]);
      for (const id of ['g1', 'g2']) { const value = /\\"id\\":\\"([0-9a-f-]{36})\\"/.exec(resultOf(context, id) ?? '')?.[1]; if (value && !ids.includes(value)) ids.push(value); }
      if (text.includes('Slow member finished.') && resultOf(context, 'close') === null) return call('close', 'subagent_close', { id: ids[0]! });
      if (resultOf(context, 'close') !== null && resultOf(context, 'after') === null) return call('after', 'subagent_send', { id: ids[0]!, message: 'more' });
      if (resultOf(context, 'after') !== null && resultOf(context, 'close2') === null) return call('close2', 'subagent_close', { id: ids[1]! });
      return streamOf(assistant('NO_REPLY'));
    } };
  try {
    service = await LocalWebService.open(options);
    await service.submit({ id: 'go', text: '两件事一起做', occurredAt: new Date().toISOString() });
    await until(() => mainContexts.some(context => resultOf(context, 'close2') !== null), 'close flow did not finish', 40_000);
    await idle(service);
    const events = (await db.admin.query("SELECT event, requested_wake FROM life_events WHERE event->>'type'='subagent.result' ORDER BY history_id")).rows;
    assert.equal(events.length, 2, 'every member keeps its own durable result');
    assert.equal(events.filter(row => row.requested_wake !== null).length, 1, 'one Wake for the whole group');
    const early = events.find(row => row.requested_wake === null)!.event.payload;
    assert.deepEqual(early.group, { name: 'batch', pending: true });
    assert.match(early.result.text, /RAW_FAST_RESULT/, 'unreported result keeps its raw text');
    assert.equal(early.summary, undefined);
    const roster = events.find(row => row.requested_wake !== null)!.event.payload.group;
    assert.equal(roster.name, 'batch'); assert.equal(roster.omitted, 0);
    assert.deepEqual(roster.members.map((member: { title: string }) => member.title), ['Fast', 'Slow']);
    assert.match(roster.members[0].excerpt, /RAW_FAST_RESULT/); assert.equal(roster.members[1].summary, 'Slow member finished.');
    // Exactly one Wake reached Mira about the group (spawn, then the group Wake).
    assert.equal(mainContexts.filter(context => conversation(context).includes('"pending":true')).length, 0, 'the non-waking member event is not a Wake');
    const closing = mainContexts.find(context => resultOf(context, 'after') !== null)!;
    const closed = JSON.parse(JSON.parse(resultOf(closing, 'close')!)[0].text);
    assert.equal(closed.closed, true); assert.ok(closed.closedAt);
    const refused = JSON.parse(JSON.parse(resultOf(closing, 'after')!)[0].text);
    assert.equal(refused.error, 'closed');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM subagent_closures')).rows[0].n, 2);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM subagent_turns')).rows[0].n, 2, 'history is kept and no new turn was queued');
    assert.doesNotMatch(JSON.stringify(await service.timeline()), /Fast|Slow|batch|subagent/);
  } finally { await service?.close(); await cleanup(); }
});

test('real PG: spawning and closing many workers returns maps, listeners and writer connections to baseline; close is owner-scoped; the idle backstop keeps workers resumable', { timeout: 90_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-subagent-leaks-')); let manager: SubagentManager | undefined;
  try {
    const writer = await db.acquire('leak-parent');
    const overflow = (runId: string, content: string) => writeWakeInput({ rootDirectory: path.join(root, 'spool'), sourceDirectory: process.cwd(), runId, content });
    let open = 0; const closedOwners: string[] = []; const failures: unknown[] = [];
    manager = new SubagentManager({ writer, maxConcurrent: 4, idleReleaseMs: 60_000, cancelSettleMs: 500,
      acquire: async id => { const child = await db.acquire(id); open++; const close = child.close.bind(child); let done = false; child.close = async () => { if (!done) { done = true; open--; } return close(); }; return child; },
      tools: () => [], writeOverflowInput: overflow, onCompletion: () => {}, onFailure: error => failures.push(error),
      closeOwner: async owner => { closedOwners.push(owner); return { closed: 0, kept: 0 }; } });
    await manager.initialize();
    const baseline = manager.retained();
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    let round = 0;
    const transport = { model: { ...model, contextWindow: 65_536 }, streamFn: (async (_model, context, options) => {
      if (isChild(context as TranscriptContext)) {
        if (conversation(context as TranscriptContext).includes('HANG')) { await new Promise<void>(resolve => { options?.signal?.addEventListener('abort', () => resolve(), { once: true }); void blocked.then(resolve); }); }
        return streamOf(assistant('ok'));
      }
      const text = conversation(context as TranscriptContext);
      if (!text.includes(`"round-${round}-0"`)) return calls(...[0, 1, 2, 3].map(index => [`round-${round}-${index}`, 'subagent_spawn', { task: round === 3 && index === 0 ? 'HANG' : `job ${round}.${index}` }] as [string, string, JsonObject]));
      return streamOf(assistant('spawned'));
    }) as StreamFn };
    const runtime = () => new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager!, transport), writeOverflowInput: overflow });
    for (round = 0; round < 3; round++) { await runtime().run(input(`spawn round ${round}`)); await until(() => !manager!.hasActiveWork, `round ${round} did not finish`); }
    // A fourth round leaves one worker hanging in a model request.
    await runtime().run(input('spawn round 3')); await until(() => manager!.activeCount === 1, 'hanging worker did not stay active');
    const all = (await db.admin.query<{ child_id: string; stream_id: string }>('SELECT child_id, stream_id FROM subagents ORDER BY created_at')).rows;
    assert.equal(all.length, 16);
    // The idle backstop releases sessions but does not close durably.
    await manager.releaseIdle(Date.now() + 120_000);
    assert.equal(manager.retained()['idle'], 0);
    assert.equal(closedOwners.length, 15, 'one release per finished worker');
    for (const [index, row] of all.entries()) {
      const result = await manager.closeChild(`close-${index}`, row.child_id);
      assert.equal(result.closed, true);
      await assert.rejects(manager.send(`send-${index}`, row.child_id, 'again', transport), /closed/);
    }
    release();
    await until(() => !manager!.hasActiveWork && manager!.abandonedCount === 0, 'closed work did not settle');
    await until(() => open === 0, `child writers still open: ${open}`);
    assert.deepEqual(manager.retained(), baseline, 'every in-memory map is back to its baseline');
    assert.ok(closedOwners.every(owner => owner.startsWith('subagent:')), 'never the main owner');
    assert.ok(!closedOwners.includes(writer.miraId));
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM subagent_closures')).rows[0].n, 16);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM subagent_turns WHERE status IN ('queued','running')")).rows[0].n, 0);
    // Closing again is idempotent; history stays readable.
    assert.ok((await manager.status(all[0]!.child_id) as { turns: unknown[] }).turns.length > 0);
    assert.deepEqual(failures, []);
  } finally { await manager?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
