import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalWebService, WebSettingsStore } from '@mira/server';
import type { JsonObject, TranscriptContext } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';
import { retryConfiguration, retrySelection, retryResponse, syntheticRetryKey } from './model-retry-fixtures.mts';

// ADR 0051: real PostgreSQL + service. Stall Wake, owner-scoped cancel
// cleanup, slot release, FIFO refusal, and a child 402 pausing Mira.
async function until(check: () => Promise<boolean> | boolean, message: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 25)); }
}
const call = (id: string, name: string, args: JsonObject) => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }] });
const conversation = (context: TranscriptContext) => JSON.stringify(context.messages.filter(message => message.role !== 'system'));
const isChild = (context: TranscriptContext) => (getCurrentSystemPrompt(context.messages) ?? '').includes('task-scoped worker');
const resultOf = (context: TranscriptContext, id: string) => { const found = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id); return found ? JSON.stringify(found.content) : null; };
const running = (marker: string) => { try { return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().length > 0; } catch { return false; } };

test('real PG/service: a quiet child emits one stall Wake; Mira cancels it; only its own terminal is closed, the slot is released, and a FIFO read is refused', { timeout: 90_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-subagent-control-'));
  execFileSync('mkfifo', [path.join(root, 'pipe')]);
  const mainMark = `sleep 61.${process.pid}`; const childMark = `sleep 62.${process.pid}`;
  let service: LocalWebService | undefined; const mainContexts: TranscriptContext[] = [];
  let childId = '';
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'subagent-control', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, autoCompaction: { enabled: false as const }, dreaming: { enabled: false },
    subagentConcurrency: 1, subagentLimits: { stallMs: 600, stallCheckMs: 50, cancelSettleMs: 1_000 },
    syntheticStream: (_model: unknown, context: TranscriptContext) => {
      const text = conversation(context);
      if (isChild(context)) {
        if (text.includes('CHILD_TWO')) return streamOf(assistant('two done'));
        if (resultOf(context, 'c-read') === null) return call('c-read', 'read', { path: 'pipe' });
        if (resultOf(context, 'c-exec') === null) return call('c-exec', 'exec_command', { command: childMark, yield_ms: 0 });
        if (resultOf(context, 'c-sleep') === null) return call('c-sleep', 'bash', { command: 'sleep 30' });
        return streamOf(assistant('child one finished'));
      }
      mainContexts.push(context);
      if (resultOf(context, 'm-exec') === null) return call('m-exec', 'exec_command', { command: mainMark, yield_ms: 0 });
      const spawned = resultOf(context, 'm-spawn');
      if (spawned === null) return call('m-spawn', 'subagent_spawn', { title: 'Quiet job', task: 'CHILD_ONE quiet work' });
      childId = /\\"id\\":\\"([0-9a-f-]{36})\\"/.exec(spawned)?.[1] ?? childId;
      if (text.includes('subagent.stalled') && resultOf(context, 'm-cancel') === null) return call('m-cancel', 'subagent_cancel', { id: childId });
      if (resultOf(context, 'm-cancel') !== null && resultOf(context, 'm-spawn2') === null) return call('m-spawn2', 'subagent_spawn', { title: 'Second job', task: 'CHILD_TWO' });
      return streamOf(assistant('NO_REPLY'));
    } };
  try {
    service = await LocalWebService.open(options);
    await service.submit({ id: 'start', text: '开始', occurredAt: new Date().toISOString() });
    await until(() => running(childMark) && running(mainMark), 'both terminals did not start');
    // One stall Wake, deduplicated while the child stays quiet.
    const stalled = async () => (await db.admin.query("SELECT event FROM life_events WHERE event->>'type' = 'subagent.stalled'")).rows;
    await until(async () => (await stalled()).length === 1, 'no stall event');
    const [stall] = await stalled();
    assert.equal(stall.event.payload.childId, childId); assert.equal(stall.event.payload.title, 'Quiet job'); assert.equal(stall.event.payload.current?.name, 'bash');
    // Mira woke on it with a one-line model-only snapshot of the child, then cancelled it.
    await until(() => mainContexts.some(context => resultOf(context, 'm-cancel') !== null), 'Mira did not cancel');
    const woke = mainContexts.find(context => conversation(context).includes('subagent.stalled'))!;
    assert.match(conversation(woke), /Subagents running: 1\.\\n- Quiet job \([0-9a-f-]{36}\) · running [^·]+ · idle /);
    const cancelled = JSON.parse(JSON.parse(resultOf(mainContexts.find(context => resultOf(context, 'm-cancel') !== null)!, 'm-cancel')!)[0].text);
    assert.equal(cancelled.cleanup.closedSessions, 1);
    await until(() => !running(childMark), 'the child terminal was not closed');
    assert.equal(running(mainMark), true, 'the main terminal survives a child cancel');
    // The slot is free (concurrency 1): the second child runs to completion.
    await until(async () => (await db.admin.query("SELECT count(*)::int AS n FROM subagent_turns WHERE status = 'completed'")).rows[0].n === 1, 'second child did not run');
    const turns = (await db.admin.query('SELECT status, activity FROM subagent_turns ORDER BY created_at')).rows;
    assert.equal(turns[0].status, 'cancelled');
    assert.equal(turns[0].activity.events.findLast((event: { kind: string }) => event.kind === 'tool').status, 'unknown');
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal((await stalled()).length, 1, 'still exactly one stall event');
    // The FIFO read was refused and recorded; nothing hung.
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE outcome::text LIKE '%is a FIFO%'")).rows[0].n, 1);
    // None of this reaches the chat.
    assert.doesNotMatch(JSON.stringify(await service.timeline()), /stall|idle|Quiet job|Subagents running/);
  } finally {
    await service?.close(); await db.close();
    try { execFileSync('pkill', ['-f', mainMark]); } catch { /* already gone */ }
    await rm(root, { recursive: true, force: true });
  }
});

test('real PG/service: a child refused for insufficient balance records the reason, Mira pauses on her own refusal, and a user message resumes', { timeout: 60_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-subagent-balance-'));
  const file = path.join(root, 'models.json');
  const store = new WebSettingsStore(file, process.cwd()); const current = await store.get();
  await store.save({ revision: current.revision, selection: retrySelection, configuration: { builtinCredentials: {}, customConnections: retryConfiguration.customConnections.map(({ apiKeyEnv: _env, ...connection }) => ({ ...connection, apiKey: syntheticRetryKey })) } });
  const refusal = (id: string) => new Response(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } }), { status: 402, headers: { 'content-type': 'application/json', 'x-request-id': id } });
  let main = 0; let child = 0; let topUp = false;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    const body = String(init?.body ?? '');
    if (body.includes('task-scoped worker')) { child++; return refusal('child-402'); }
    main++;
    if (main === 1) return retryResponse('', 'spawn-bal', 'subagent_spawn', { title: 'Balance child', task: 'CHILD_BAL' });
    if (main === 2) return retryResponse('已安排。');
    if (!topUp) return refusal('main-402');
    return retryResponse('继续。');
  }) as typeof globalThis.fetch;
  let service: LocalWebService | undefined;
  try {
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'subagent-balance', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
      spoolDirectory: path.join(root, 'spool'), settingsFile: file, autoCompaction: { enabled: false as const }, dreaming: { enabled: false }, modelFetch: fetch });
    await service.submit({ id: 'go', text: '派个子任务', occurredAt: new Date().toISOString() });
    await until(async () => (await service!.status()).state === 'paused', 'Mira did not pause');
    assert.equal(child, 1, 'the child request was not retried');
    const [turn] = (await db.admin.query('SELECT status, result FROM subagent_turns')).rows;
    assert.equal(turn.status, 'failed');
    assert.match(turn.result.text, /insufficient balance \(HTTP 402, request child-402\)/);
    assert.equal((await service.status()).pause?.requestId, 'main-402');
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type' = 'model.balance-paused'")).rows[0].n, 1);
    // A user message resumes Mira as before.
    topUp = true;
    await service.submit({ id: 'topped-up', text: '充好了', occurredAt: new Date().toISOString() });
    await until(async () => (await service!.status()).state === 'idle', 'did not resume');
    assert.equal((await service.status()).pause, undefined);
    assert.equal(child, 1);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
