import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentTools, getSystemMessageText, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import type { HistorySearchResult, LifeEvent } from '@mira/life';
import { LocalWebService } from '@mira/server';
import { dreamingInstruction, dreamingDefaults } from '../../apps/server/src/dreaming.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, streamOf } from './fixtures.mts';

// Only the provider is synthetic. PostgreSQL, the Web service, Wake loop,
// ordinary file/history tools and Memory Git are their production adapters.
type Database = Awaited<ReturnType<typeof createTestDatabase>>;
const occurredAt = '2026-10-13T07:00:00.000Z';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function options(db: Database, root: string, miraId: string) {
  return { connectionString: db.connectionString, schema: db.schema, miraId,
    sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    memoryRoot: path.join(root, 'memory'), synthetic: true, autoCompaction: { enabled: false },
  };
}
async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw Error(message);
    await pause(10);
  }
}
async function settled(service: LocalWebService, state: 'idle' | 'error' = 'idle'): Promise<void> {
  await until(async () => (await service.status()).state !== 'working', 'Dreaming service did not settle');
  assert.equal((await service.status()).state, state, JSON.stringify(await service.status()));
}
async function dreamingEvents(db: Database) {
  return (await db.admin.query<{ event_id: string; history_id: string; event: LifeEvent; requested_wake: { id: string; reason: string } }>(
    "SELECT event_id, history_id, event, requested_wake FROM life_events WHERE event->>'type' = 'memory.dreaming' ORDER BY event_id")).rows;
}
async function age(db: Database): Promise<void> {
  // Age only technical timestamps, never fabricate compactions or tool outcomes.
  await db.admin.query("UPDATE dreaming_progress SET last_triggered_at = clock_timestamp() - interval '25 hours', idle_since = clock_timestamp() - interval '31 minutes'");
}
async function trigger(db: Database, service: LocalWebService, count = 1): Promise<void> {
  await age(db); await service.settings();
  await until(async () => (await dreamingEvents(db)).length === count, 'An eligible Dreaming Wake was not enqueued');
}
function systemText(context: TranscriptContext): string {
  const system = getCurrentSystemMessage(context.messages);
  return system ? getSystemMessageText(system) : '';
}
function resultText(context: TranscriptContext, id: string): string {
  const results = context.messages.filter(message => message.role === 'toolResult' && message.toolCallId === id);
  assert.equal(results.length, 1);
  const result = results[0]; assert.ok(result?.role === 'toolResult'); assert.equal(result.isError, false);
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}
const call = (id: string, name: string, args: ToolCall['arguments']): ToolCall => ({ type: 'toolCall', id, name, arguments: args });
const calls = (...content: ToolCall[]) => ({ ...assistant(), stopReason: 'toolUse' as const, content });

test('real PostgreSQL Dreaming reads current Memory and original History, edits ordinary files, commits lineage silently and preserves the durable system snapshot until compaction', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-dreaming-tools-');
  let service: LocalWebService | undefined; let requests = 0, summaries = 0;
  try {
    const configuration = options(db, root, 'dreaming-tools');
    const file = path.join(configuration.memoryRoot, 'MEMORY.md'); const detail = path.join(configuration.memoryRoot, 'projects', 'neptune.md');
    await mkdir(configuration.memoryRoot); await writeFile(file, 'INITIAL_MEMORY_SNAPSHOT');
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      requests++;
      assert.match(systemText(context), /INITIAL_MEMORY_SNAPSHOT/);
      assert.doesNotMatch(systemText(context), /CURRENT_MEMORY_ON_DISK|REMEMBERED_NEPTUNE/);
      if (requests === 1) return streamOf(assistant('I have the project detail.'));
      const latestInput = context.messages.filter(message => message.role === 'user').at(-1);
      assert.ok(latestInput); assert.match(JSON.stringify(latestInput), /memory\.dreaming/);
      assert.match(JSON.stringify(latestInput), /\[system \|/);
      for (const text of ['Recent experiences may be worth remembering.', 'No change is a valid result.', 'Work quietly']) {
        assert.ok(JSON.stringify(latestInput).includes(text), 'the ordinary Dreaming payload reaches the actual provider');
      }
      assert.deepEqual(getCurrentTools(context.messages).filter(tool => ['read', 'write', 'edit', 'history_search', 'history_read'].includes(tool.name)).map(tool => tool.name).sort(), ['edit', 'history_read', 'history_search', 'read', 'write']);
      if (requests === 2) return streamOf(calls(
        call('dream-read-current', 'read', { path: file }),
        call('dream-search-original', 'history_search', { query: 'NEPTUNE_SOURCE_FACT', mode: 'substring', kinds: ['event'] }),
      ));
      assert.match(resultText(context, 'dream-read-current'), /CURRENT_MEMORY_ON_DISK/);
      const found = JSON.parse(resultText(context, 'dream-search-original')) as HistorySearchResult;
      assert.equal(found.hits.length, 1);
      if (requests === 3) return streamOf(calls(call('dream-read-original', 'history_read', { id: found.hits[0]!.id })));
      const original = JSON.parse(resultText(context, 'dream-read-original')) as { kind: string; event: LifeEvent };
      assert.equal(original.kind, 'event'); assert.equal(original.event.source, 'user');
      assert.deepEqual(original.event.payload, { text: 'NEPTUNE_SOURCE_FACT: Project Neptune uses PostgreSQL.' });
      if (requests === 4) return streamOf(calls(
        call('dream-write-detail', 'write', { path: detail, content: 'Project Neptune uses PostgreSQL.\n' }),
        call('dream-edit-memory', 'edit', { path: file, edits: [{ oldText: 'CURRENT_MEMORY_ON_DISK', newText: 'REMEMBERED_NEPTUNE: Project Neptune uses PostgreSQL. See projects/neptune.md.' }] }),
      ));
      assert.equal(requests, 5); resultText(context, 'dream-write-detail'); resultText(context, 'dream-edit-memory');
      return streamOf(assistant(''));
    } });
    await settled(service); assert.equal(requests, 0);
    await service.submit({ id: 'neptune-source', text: 'NEPTUNE_SOURCE_FACT: Project Neptune uses PostgreSQL.', occurredAt });
    await settled(service); assert.equal(requests, 1);
    await writeFile(file, 'CURRENT_MEMORY_ON_DISK');
    await trigger(db, service); await settled(service); assert.equal(requests, 5);
    assert.match(await readFile(file, 'utf8'), /REMEMBERED_NEPTUNE/);
    assert.equal(await readFile(detail, 'utf8'), 'Project Neptune uses PostgreSQL.\n');
    const [event] = await dreamingEvents(db); assert.ok(event);
    assert.deepEqual(event.event.payload, { instruction: dreamingInstruction });
    assert.equal(event.event.source, 'system'); assert.ok(event.requested_wake);
    const lineage = (await db.admin.query<{ run_id: string; completed: boolean; final_record_id: string; commit_id: string }>(
      `SELECT r.run_id, r.completed, r.final_record_id, m.commit_id FROM wake_runs AS r
       JOIN wake_run_requests AS q ON q.mira_id = r.mira_id AND q.run_id = r.run_id
       JOIN wake_memory_receipts AS m ON m.mira_id = r.mira_id AND m.run_id = r.run_id
       WHERE q.wake_id = $1`, [event.requested_wake.id])).rows;
    assert.equal(lineage.length, 1); assert.ok(lineage[0]!.completed); assert.ok(lineage[0]!.final_record_id); assert.ok(lineage[0]!.commit_id);
    const git = (...args: string[]) => execFileSync('git', ['-C', configuration.memoryRoot, ...args], { encoding: 'utf8' }).trim();
    const head = git('rev-parse', 'HEAD'); assert.equal(head, lineage[0]!.commit_id);
    assert.ok(git('show', '-s', '--format=%B', head).includes(`History-Id: ${lineage[0]!.run_id}`));
    assert.equal((await db.store.history(configuration.miraId).read({ id: lineage[0]!.run_id }))?.kind, 'wake');
    assert.deepEqual(git('diff-tree', '--no-commit-id', '--name-only', '-r', head).split('\n'), ['MEMORY.md', 'projects/neptune.md']);
    const timeline = await service.timeline();
    assert.deepEqual(timeline.items.map(item => item.role).sort(), ['assistant', 'user']);
    assert.doesNotMatch(JSON.stringify(timeline), /memory\.dreaming|REMEMBERED_NEPTUNE|CURRENT_MEMORY_ON_DISK/);
    const executions = (await db.admin.query('SELECT intent, outcome FROM tool_executions ORDER BY context_version')).rows;
    assert.deepEqual(executions.map(row => row.intent.toolName), ['read', 'history_search', 'history_read', 'write', 'edit']);
    assert.ok(executions.every(row => row.outcome));
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM context_records WHERE envelope->>'kind' = 'checkpoint'")).rows[0].n, 0, 'Dreaming does not force context compaction');
    await service.external.emitEvent('synthetic-sender', { id: 'silent-event', type: 'fixture.event', occurredAt, payload: { text: 'SILENT_EVENT_ONLY' } });
    await service.external.sendNotification('synthetic-sender', { id: 'notice-only', occurredAt, text: 'NOTICE_ONLY' });
    await age(db); await service.settings(); await pause(100);
    assert.equal(requests, 5); assert.equal((await dreamingEvents(db)).length, 1, 'Dreaming, file edits, event-only inputs and notices cannot feed another Dreaming loop');
    await service.close(); service = undefined;
    await writeFile(file, 'DISK_CHANGED_AFTER_DREAMING');
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      requests++; assert.match(systemText(context), /INITIAL_MEMORY_SNAPSHOT/);
      assert.doesNotMatch(systemText(context), /REMEMBERED_NEPTUNE|DISK_CHANGED_AFTER_DREAMING/);
      return streamOf(assistant('Earlier continuous answer '.repeat(2000)));
    } });
    await settled(service); assert.equal(requests, 5); assert.equal(git('rev-parse', 'HEAD'), head);
    assert.deepEqual((await db.admin.query('SELECT intent, outcome FROM tool_executions ORDER BY context_version')).rows, executions);
    assert.equal((await dreamingEvents(db)).length, 1);
    // Reset only the clock fixture so a newly accepted user message cannot
    // immediately satisfy the prior intentionally aged timer.
    await db.admin.query('UPDATE dreaming_progress SET last_triggered_at = clock_timestamp(), idle_since = clock_timestamp()');
    await service.submit({ id: 'after-dreaming', text: 'Continue from the persisted context.', occurredAt }); await settled(service); assert.equal(requests, 6);
    await service.close(); service = undefined;
    service = await LocalWebService.open({ ...configuration, autoCompaction: { threshold: 0.008, reserveTokens: 512, keepRecentTokens: 1 }, syntheticStream: (_model, context) => {
      if (systemText(context).startsWith('你负责压缩 Mira 的 Working Context')) { summaries++; return streamOf(assistant('Durable Dreaming continuity checkpoint.')); }
      requests++; assert.match(systemText(context), /DISK_CHANGED_AFTER_DREAMING/);
      assert.doesNotMatch(systemText(context), /INITIAL_MEMORY_SNAPSHOT/);
      return streamOf(assistant('Continued after ordinary compaction.'));
    } });
    await settled(service); assert.equal(requests, 6); assert.equal(summaries, 0);
    await service.submit({ id: 'later-compaction', text: 'Continue at the next natural request.', occurredAt }); await settled(service);
    assert.equal(requests, 7); assert.ok(summaries >= 1);
    assert.equal((await dreamingEvents(db)).length, 1);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL Dreaming timer waits for continuous idle after completion and fresh Wake experiences, then stops when service closes', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-dreaming-idle-');
  let service: LocalWebService | undefined; let requests = 0; const entered = deferred(); const release = deferred();
  try {
    const configuration = { ...options(db, root, 'dreaming-idle'), dreaming: { idleMs: 250, intervalMs: 1, minCompactions: 3 } };
    service = await LocalWebService.open({ ...configuration, syntheticStream: async (_model, context) => {
      requests++;
      if (requests === 1) { entered.resolve(); await release.promise; }
      if (requests === 3) assert.match(JSON.stringify(context.messages.filter(message => message.role === 'user').at(-1)), /memory\.dreaming/);
      return streamOf(assistant(''));
    } });
    await settled(service); await pause(300); assert.equal(requests, 0, 'time alone is not an experience');
    await service.external.emitEvent('idle-source', { id: 'event-only', type: 'fixture.idle', occurredAt, payload: {} });
    await service.external.sendNotification('idle-source', { id: 'notification-only', occurredAt, text: 'No Wake' });
    await service.settings(); await pause(300); assert.equal(requests, 0);
    await service.submit({ id: 'long-work', text: 'Synthetic work that stays active.', occurredAt }); await entered.promise;
    await pause(300); assert.equal(requests, 1); assert.equal((await dreamingEvents(db)).length, 0, 'active cognition is not idle');
    release.resolve(); await settled(service);
    await pause(60); await service.submit({ id: 'reset-idle', text: 'A newer user experience resets the idle clock.', occurredAt }); await settled(service);
    assert.equal(requests, 2); await pause(100); assert.equal((await dreamingEvents(db)).length, 0, 'idle must be continuous since the last completed work');
    await until(() => requests === 3, 'The real idle timer did not fire'); await settled(service);
    assert.equal((await dreamingEvents(db)).length, 1); await pause(350); assert.equal(requests, 3, 'the silent Dreaming result is not a new experience');
    await service.submit({ id: 'close-before-due', text: 'One last experience before shutdown.', occurredAt }); await settled(service); assert.equal(requests, 4);
    await service.close(); service = undefined; await pause(350);
    assert.equal(requests, 4); assert.equal((await dreamingEvents(db)).length, 1, 'close cancels the pending timer before releasing the writer');
  } finally { release.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL failed Dreaming preserves its ordinary file effect and resumes the same run only after restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-dreaming-recovery-');
  let service: LocalWebService | undefined; let requests = 0;
  try {
    const configuration = { ...options(db, root, 'dreaming-recovery'), dreaming: { idleMs: 40, intervalMs: 100, minCompactions: 3 } };
    const file = path.join(configuration.memoryRoot, 'recovered.md');
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      requests++;
      if (requests === 1) return streamOf(assistant(''));
      if (requests === 2) return streamOf(calls(call('dream-effect-once', 'write', { path: file, content: 'DURABLE_DREAMING_EFFECT\n' })));
      assert.equal(requests, 3); resultText(context, 'dream-effect-once');
      return streamOf({ ...assistant(), content: [], stopReason: 'error', errorMessage: 'Synthetic provider failure after the saved ordinary write.' });
    } });
    await settled(service); await service.submit({ id: 'recovery-source', text: 'A new experience.', occurredAt }); await settled(service);
    await trigger(db, service); await settled(service, 'error'); assert.equal(requests, 3);
    const [event] = await dreamingEvents(db); assert.ok(event);
    const [failed] = (await db.admin.query('SELECT r.* FROM wake_runs AS r JOIN wake_run_requests AS q USING (mira_id, run_id) WHERE q.wake_id = $1', [event.requested_wake.id])).rows;
    assert.ok(failed.input_record_id); assert.equal(failed.final_record_id, null); assert.equal(failed.completed, false);
    const before = (await db.admin.query('SELECT intent, outcome FROM tool_executions')).rows;
    assert.equal(before.length, 1); assert.ok(before[0].outcome); assert.equal(await readFile(file, 'utf8'), 'DURABLE_DREAMING_EFFECT\n');
    await age(db); await service.settings(); await pause(150);
    assert.equal(requests, 3); assert.equal((await service.status()).state, 'error'); assert.equal((await dreamingEvents(db)).length, 1);
    await service.close(); service = undefined;
    // A later local edit proves recovery does not replay the successful write.
    await writeFile(file, 'LATER_EDIT_MUST_NOT_BE_OVERWRITTEN\n');
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      requests++; assert.equal(requests, 4); resultText(context, 'dream-effect-once');
      assert.equal(context.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('memory.dreaming')).length, 1);
      return streamOf(assistant(''));
    } });
    await settled(service); assert.equal(requests, 4); assert.equal((await dreamingEvents(db)).length, 1);
    const [recovered] = (await db.admin.query('SELECT * FROM wake_runs WHERE run_id = $1', [failed.run_id])).rows;
    assert.equal(recovered.input_record_id, failed.input_record_id); assert.ok(recovered.final_record_id); assert.equal(recovered.completed, true);
    assert.deepEqual((await db.admin.query('SELECT intent, outcome FROM tool_executions')).rows, before);
    assert.equal(await readFile(file, 'utf8'), 'LATER_EDIT_MUST_NOT_BE_OVERWRITTEN\n');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_memory_receipts WHERE run_id = $1', [failed.run_id])).rows[0].n, 1);
    await pause(100); assert.equal(requests, 4);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL user arrivals during Dreaming wait for the active run and coalesce into the next continuous Wake', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-dreaming-arrivals-');
  let service: LocalWebService | undefined; let requests = 0; const entered = deferred(); const release = deferred();
  try {
    service = await LocalWebService.open({ ...options(db, root, 'dreaming-arrivals'), syntheticStream: async (_model, context) => {
      requests++;
      if (requests === 2) {
        assert.match(JSON.stringify(context.messages.filter(message => message.role === 'user').at(-1)), /memory\.dreaming/);
        assert.doesNotMatch(JSON.stringify(context.messages), /ARRIVAL_DURING_DREAMING/);
        entered.resolve(); await release.promise; return streamOf(assistant(''));
      }
      if (requests === 3) {
        const latest = JSON.stringify(context.messages.filter(message => message.role === 'user').at(-1));
        assert.match(latest, /2 wake requests/); assert.match(latest, /ARRIVAL_DURING_DREAMING_A/); assert.match(latest, /ARRIVAL_DURING_DREAMING_B/);
        assert.match(JSON.stringify(context.messages), /memory\.dreaming/);
      }
      return streamOf(assistant(requests === 3 ? 'Handled the newer requests.' : ''));
    } });
    await settled(service); await service.submit({ id: 'initial', text: 'Initial experience.', occurredAt }); await settled(service);
    await trigger(db, service); await entered.promise;
    await service.submit({ id: 'arrival-a', text: 'ARRIVAL_DURING_DREAMING_A', occurredAt });
    await service.submit({ id: 'arrival-b', text: 'ARRIVAL_DURING_DREAMING_B', occurredAt });
    await pause(50); assert.equal(requests, 2); assert.equal((await service.status()).state, 'working');
    release.resolve(); await settled(service); assert.equal(requests, 3);
    const membership = (await db.admin.query('SELECT run_id, count(*)::int AS n FROM wake_run_requests GROUP BY run_id')).rows;
    assert.deepEqual(membership.map(row => row.n).sort(), [1, 1, 2]);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE completed')).rows[0].n, 3);
    assert.equal((await dreamingEvents(db)).length, 1);
  } finally { release.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL restart claims a queued Dreaming and a newer user request together without a second cognitive stream', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-dreaming-mixed-');
  let service: LocalWebService | undefined; let requests = 0;
  try {
    const configuration = options(db, root, 'dreaming-mixed');
    service = await LocalWebService.open({ ...configuration, syntheticStream: () => { requests++; return streamOf(assistant('')); } });
    await settled(service); await service.submit({ id: 'initial', text: 'An initial completed experience.', occurredAt }); await settled(service);
    await service.close(); service = undefined; await age(db);
    const writer = await db.acquire(configuration.miraId);
    assert.equal((await writer.requestDreaming({ ...dreamingDefaults, instruction: dreamingInstruction })).status, 'inserted');
    await writer.receive({ id: 'queued-user', type: 'web.message', source: 'user', occurredAt, payload: { text: 'USER_PRIORITY_IN_MIXED_BATCH' } }, { id: 'web:queued-user', reason: 'User message from the local web interface' });
    await writer.close();
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      requests++; const latest = JSON.stringify(context.messages.filter(message => message.role === 'user').at(-1));
      assert.match(latest, /2 wake requests/); assert.match(latest, /memory\.dreaming/); assert.match(latest, /USER_PRIORITY_IN_MIXED_BATCH/);
      assert.match(latest, /Give any new user request priority/);
      return streamOf(assistant('Handled the user request in the existing stream.'));
    } });
    await settled(service); assert.equal(requests, 2); assert.equal((await dreamingEvents(db)).length, 1);
    assert.deepEqual((await db.admin.query('SELECT count(*)::int AS n FROM wake_run_requests GROUP BY run_id')).rows.map(row => row.n).sort(), [1, 2]);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL shutdown cancels active Dreaming, then restart resumes its exact persisted input', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-dreaming-close-');
  let service: LocalWebService | undefined; let requests = 0; const entered = deferred(); let original: unknown;
  try {
    const configuration = options(db, root, 'dreaming-close');
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context, streamOptions) => {
      requests++; if (requests === 1) return streamOf(assistant(''));
      original = structuredClone(context.messages.filter(message => message.role === 'user').at(-1));
      const stream = createAssistantMessageEventStream(); entered.resolve();
      const abort = () => stream.push({ type: 'error', reason: 'aborted', error: { ...assistant(), stopReason: 'aborted', errorMessage: 'Synthetic Dreaming cancellation.' } });
      streamOptions?.signal?.addEventListener('abort', abort, { once: true });
      if (streamOptions?.signal?.aborted) abort(); return stream;
    } });
    await settled(service); await service.submit({ id: 'initial', text: 'A completed experience.', occurredAt }); await settled(service);
    await trigger(db, service); await entered.promise; await service.close(); service = undefined;
    const [pending] = (await db.admin.query('SELECT * FROM wake_runs WHERE NOT completed')).rows; assert.ok(pending);
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      requests++; const inputs = context.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('memory.dreaming'));
      assert.deepEqual(inputs, [original]); return streamOf(assistant(''));
    } });
    await settled(service); assert.equal(requests, 3); assert.equal((await dreamingEvents(db)).length, 1);
    const [completed] = (await db.admin.query('SELECT * FROM wake_runs WHERE run_id = $1', [pending.run_id])).rows;
    assert.equal(completed.input_record_id, pending.input_record_id); assert.equal(completed.completed, true);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL three actual automatic compactions unlock idle Dreaming before 24 hours, while two checkpoints and a failed summary do not', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-dreaming-compactions-');
  let service: LocalWebService | undefined; let naturalRequests = 0, summaryAttempts = 0, successfulSummaries = 0, dreamingRequests = 0;
  try {
    const checkpoints = async () => (await db.admin.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM context_records WHERE envelope->>'kind' = 'checkpoint'")).rows[0]!.n;
    const configuration = { ...options(db, root, 'dreaming-real-compactions'),
      dreaming: { idleMs: 60, intervalMs: dreamingDefaults.intervalMs, minCompactions: 3 },
      // The static system fits below this budget, while each large ordinary
      // reply forces one genuine Pi compaction at the next natural request.
      autoCompaction: { threshold: 0.02, reserveTokens: 512, keepRecentTokens: 1 },
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        if (systemText(context).startsWith('你负责压缩 Mira 的 Working Context')) {
          summaryAttempts++;
          if (summaryAttempts === 3) return streamOf({ ...assistant(), content: [], stopReason: 'error', errorMessage: 'Synthetic summary failure before checkpoint publication.' });
          successfulSummaries++;
          return streamOf(assistant(`Successful automatic continuity summary ${successfulSummaries}.`));
        }
        const latest = JSON.stringify(context.messages.filter(message => message.role === 'user').at(-1));
        if (latest.includes('memory.dreaming')) {
          dreamingRequests++; assert.equal(successfulSummaries, 3);
          return streamOf(assistant(''));
        }
        naturalRequests++;
        return streamOf(assistant(naturalRequests <= 3 ? 'Long natural answer for automatic compaction. '.repeat(4000) : 'Short answer after the recovered third checkpoint.'));
      },
    };
    service = await LocalWebService.open(configuration); await settled(service);
    const baseline = (await db.admin.query<{ last_triggered_at: Date }>('SELECT last_triggered_at FROM dreaming_progress')).rows[0]!.last_triggered_at;
    for (let index = 0; index < 3; index++) {
      await service.submit({ id: `real-compaction-${index}`, text: `New natural experience ${index}.`, occurredAt }); await settled(service);
      assert.equal(naturalRequests, index + 1); assert.equal(successfulSummaries, index); assert.equal(await checkpoints(), index);
      await pause(150); await service.settings(); await pause(25);
      assert.equal((await dreamingEvents(db)).length, 0, `New experience and continuous idle are insufficient after only ${index} committed automatic compactions`);
    }
    await service.submit({ id: 'real-compaction-fails', text: 'This natural request reaches the third summary attempt.', occurredAt }); await settled(service, 'error');
    assert.equal(summaryAttempts, 3); assert.equal(successfulSummaries, 2); assert.equal(naturalRequests, 3);
    assert.equal(await checkpoints(), 2, 'A provider summary failure cannot publish or count a checkpoint');
    const [failed] = (await db.admin.query<{ run_id: string; input_record_id: string }>('SELECT run_id, input_record_id FROM wake_runs WHERE NOT completed')).rows;
    assert.ok(failed?.input_record_id);
    await pause(150); await service.settings(); await pause(25);
    assert.equal(summaryAttempts, 3, 'The Dreaming scheduler must not retry a failed compaction');
    assert.equal((await dreamingEvents(db)).length, 0);
    await service.close(); service = undefined;
    service = await LocalWebService.open(configuration);
    await until(() => dreamingRequests === 1, 'The third successful automatic checkpoint did not unlock the real Dreaming timer');
    await settled(service);
    assert.equal(naturalRequests, 4); assert.equal(summaryAttempts, 4); assert.equal(successfulSummaries, 3); assert.equal(await checkpoints(), 3);
    const [recovered] = (await db.admin.query<{ input_record_id: string; completed: boolean }>('SELECT input_record_id, completed FROM wake_runs WHERE run_id = $1', [failed.run_id])).rows;
    assert.equal(recovered!.input_record_id, failed.input_record_id); assert.equal(recovered!.completed, true, 'Restart finishes the same user Wake after publishing its real checkpoint');
    const events = await dreamingEvents(db); assert.equal(events.length, 1);
    assert.ok(Date.parse(events[0]!.event.occurredAt) - baseline.getTime() < dreamingDefaults.intervalMs, 'The real three-checkpoint branch triggered before the 24-hour alternative');
    await pause(150); assert.equal(dreamingRequests, 1); assert.equal(await checkpoints(), 3);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
