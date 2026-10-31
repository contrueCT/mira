import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LocalWebService } from '@mira/server';
import { TIMELINE_READ_CONCURRENCY } from '../../apps/server/src/web-service.ts';
import { decodeRecords, encodeEntry, messageEntry } from '../../packages/runtime-pi/src/records.ts';
import { assistant, deferred, effectTool, input, MemoryWriter, result, runtime, streamOf } from '../recovery/fixtures.mts';
import { boundedFixtureWait } from '../recovery/service-wait-fixture.mts';

test('completed assistant commentary is persisted before execution and readable while its tool is blocked', { timeout: 10_000 }, async () => {
  const writer = new MemoryWriter();
  const atAppend = deferred(), releaseAppend = deferred(), atTool = deferred(), releaseTool = deferred();
  const atToolOnly = deferred(), releaseToolOnly = deferred();
  const commentary = 'I will check the local evidence now.';
  let requests = 0;
  writer.beforeAppend = async record => {
    const [entry] = decodeRecords([record], record.parentId);
    if (entry?.type === 'message' && entry.message.role === 'assistant' && entry.message.content.some(block => block.type === 'toolCall' && block.id === 'commentary-tool')) {
      atAppend.resolve(); await releaseAppend.promise;
    }
  };
  const history = {
    page: async () => ({ hits: writer.state.records.map(record => ({ id: record.id, kind: 'context', occurredAt: record.occurredAt })), nextCursor: null }),
    readBatch: async ({ ids }: { ids: string[] }) => ids.map(id => {
      const record = writer.state.records.find(record => record.id === id);
      return { id, entry: record ? { id, kind: 'context', miraId: writer.miraId, record, occurredAt: record.occurredAt } : null, tooLarge: false };
    }),
    snapshot: async (work: (reader: unknown) => Promise<unknown>) => work(history), findEventReceipt: async () => null,
  };
  // Real Pi runtime and Timeline projection; persistence and History reads are
  // explicitly in-memory fixtures, not a PostgreSQL or browser verification.
  const service = Reflect.construct(LocalWebService, [{ dreaming: { enabled: false } }, { signal: new AbortController().signal, onLiveInput: () => () => {} }, history]) as LocalWebService;
  const instance = runtime(writer, () => {
    requests++;
    if (requests === 3) return streamOf(assistant('Evidence checked.'));
    return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
      { type: 'thinking', thinking: 'PRIVATE_COMMENTARY_THINKING' },
      ...(requests === 1 ? [{ type: 'text' as const, text: commentary }] : []),
      { type: 'toolCall', id: requests === 1 ? 'commentary-tool' : 'PRIVATE_TOOL_ONLY_CALL', name: 'effect', arguments: {} },
    ] });
  }, { tools: [effectTool(async id => {
    const execution = writer.state.executions.find(execution => execution.intent.callId === id);
    const source = writer.state.records.find(record => record.id === execution?.intent.assistantRecordId);
    assert.ok(source, 'the exact assistant record is durable before tool execution starts');
    const [entry] = decodeRecords([source], source.parentId);
    assert.ok(entry?.type === 'message' && entry.message.role === 'assistant');
    assert.ok(entry.message.content.some(block => block.type === 'toolCall' && block.id === id));
    if (id === 'commentary-tool') {
      assert.ok(entry.message.content.some(block => block.type === 'text' && block.text === commentary));
      atTool.resolve(); await releaseTool.promise;
    } else { atToolOnly.resolve(); await releaseToolOnly.promise; }
    return result;
  })] });
  const work = instance.run(input());
  try {
    await boundedFixtureWait(atAppend.promise, 'assistant append');
    assert.equal(writer.state.executions.length, 0, 'an uncommitted assistant cannot execute tools');
    assert.deepEqual((await service.timeline()).items, [], 'nothing is published before complete assistant persistence');
    releaseAppend.resolve(); await boundedFixtureWait(atTool.promise, 'commentary tool started');
    assert.equal(requests, 1); assert.equal(writer.state.executions[0]!.outcome, null);
    const duringTool = await service.timeline();
    assert.deepEqual(duringTool.items.map(item => item.text), [commentary]);
    assert.equal(duringTool.items[0]!.id, writer.state.executions[0]!.intent.assistantRecordId);
    assert.doesNotMatch(JSON.stringify(duringTool), /PRIVATE_COMMENTARY_THINKING|commentary-tool/);
    releaseTool.resolve(); await boundedFixtureWait(atToolOnly.promise, 'tool-only execution started');
    assert.equal(requests, 2); assert.equal(writer.state.executions[1]!.outcome, null);
    assert.deepEqual((await service.timeline()).items, duringTool.items, 'thinking and tool-only messages publish no empty bubbles');
    releaseToolOnly.resolve(); await work;
    assert.deepEqual((await service.timeline()).items.map(item => item.text), [commentary, 'Evidence checked.']);
  } finally {
    releaseAppend.resolve(); releaseTool.resolve(); releaseToolOnly.resolve();
    await work; await writer.close();
  }
});

// Exercise the real service projection with a read-only history fixture, without
// claiming PostgreSQL execution. Durable associations remain in run management.
test('chat omits delegation-only rows and reads while preserving text and attachments', async () => {
  const at = '2026-10-14T00:00:00.000Z';
  const attachment = { id: randomUUID(), name: 'evidence.txt', mimeType: 'text/plain', size: 5, sha256: 'a'.repeat(64) };
  const record = encodeEntry(messageEntry(assistant('Mira keeps the conversation going.'), null));
  const entry = (kind: string) => ({ id: randomUUID(), kind, occurredAt: at });
  const user = { ...entry('event'), event: { id: 'user-request', source: 'user', type: 'web.message', payload: { text: 'Please check the evidence.', attachments: [attachment] } } };
  const reply = { ...entry('context'), record };
  const spawn = { ...entry('tool'), intent: { toolName: 'subagent_spawn', callId: 'spawn' }, outcome: { callId: 'spawn', payload: {} } };
  const followup = { ...entry('tool'), intent: { toolName: 'subagent_send', callId: 'followup' }, outcome: null };
  const publication = { ...entry('tool'), intent: { toolName: 'send_attachment', callId: 'publish' }, outcome: null as unknown };
  const entries = [user, reply, spawn, followup, publication];
  const cursors: Array<string | undefined> = [];
  const history = {
    page: async ({ before }: { before?: string }) => { cursors.push(before); return { hits: entries.map(({ id, kind, occurredAt }) => ({ id, kind, occurredAt })), nextCursor: null }; },
    readBatch: async ({ ids }: { ids: string[] }) => ids.map(id => ({ id, entry: entries.find(value => value.id === id) ?? null, tooLarge: false })),
    snapshot: async (work: (reader: unknown) => Promise<unknown>) => work(history), findEventReceipt: async () => null,
  };
  let childReads = 0;
  const reader = { readSubagentCalls: async () => { childReads++; return [{ callId: 'spawn', runId: randomUUID(), childId: randomUUID() }]; } };
  const service = Reflect.construct(LocalWebService, [{ dreaming: { enabled: false } }, { signal: new AbortController().signal, onLiveInput: () => () => {} }, history, {}, {}, {}, {}, {}, reader]) as LocalWebService;
  const first = await service.timeline();
  assert.equal(first.nextCursor, null);
  assert.deepEqual(first.items.map(item => item.id), [user.id, reply.id]);
  assert.equal(first.items[0]!.externalEventId, 'user-request');
  assert.deepEqual(first.items[0]!.attachments, [attachment]);
  assert.equal(first.items[1]!.text, 'Mira keeps the conversation going.');
  publication.outcome = { callId: 'publish', payload: { role: 'toolResult', toolName: 'send_attachment', toolCallId: 'publish', isError: false,
    details: { version: 1, type: 'attachment-publication', text: '', attachments: [attachment] } } };
  const next = await service.timeline();
  assert.deepEqual(next.items.map(item => item.id), [user.id, reply.id, publication.id]);
  assert.deepEqual(next.items.at(-1)!.attachments, [attachment], 'pending tool cache still admits an explicit later attachment publication');
  assert.ok(next.items.every(item => !Object.hasOwn(item, 'child')));
  assert.equal(childReads, 0, 'chat does not request child metadata or start child polling');
  assert.deepEqual(cursors, [undefined, undefined]);
});

test('automatic ownership close retains a safe persistence notice but suppresses ordinary shutdown errors', async () => {
  const { DurableOperationError } = await import('@mira/life');
  const { PersistenceFailureNotice } = await import('../../apps/server/src/persistence-errors.ts');
  for (const failure of [new DurableOperationError('persistence-write-failure', 'private database detail'), new Error('private cancellation detail')]) {
    const owner = new AbortController();
    const resource = { close: async () => {} };
    const writer = { signal: owner.signal, onLiveInput: () => () => {}, receiveLiveInput: async () => 'inserted', close: async () => {} };
    const loop = { drain: async (signal: AbortSignal) => { await Promise.resolve(); owner.abort(failure); throw signal.reason; } };
    const history = { findEventRun: async () => null };
    const service = Reflect.construct(LocalWebService, [{ synthetic: true, dreaming: { enabled: false } }, writer, history, {}, { selection: null }, loop,
      { resolve: async () => [] }, resource, {}, resource, resource]) as LocalWebService;
    await service.submit({ id: 'diagnostic', text: 'Test shutdown', occurredAt: '2026-10-15T00:00:00.000Z' });
    await service.close();
    const status = await service.status();
    assert.equal(status.state, 'stopped');
    assert.equal(PersistenceFailureNotice.text(status.error), PersistenceFailureNotice.text(PersistenceFailureNotice.from(failure)));
    if (!(failure instanceof DurableOperationError)) assert.equal(status.error, null);
    assert.doesNotMatch(JSON.stringify(status), /private/);
  }
});

// In-memory History fixture with real cursor semantics: ascending hits within a
// page, newest page first. Visible rows are user messages; others are hidden.
function pagedHistory(count: number, isVisible: (index: number) => boolean, text: (index: number) => string = index => `Visible ${index}`) {
  const at = (index: number) => new Date(Date.UTC(2026, 9, 1) + index * 1000).toISOString();
  const ids: string[] = Array.from({ length: count }, () => randomUUID());
  const index = new Map(ids.map((id, position) => [id, position]));
  const calls = { pages: [] as Array<{ before: string | undefined; limit: number | undefined }>, originals: 0, snapshots: 0 };
  const history = {
    calls,
    omit: new Set<string>(),
    /** Entries that replace the generated event at a position (e.g. a tool). */
    entries: new Map<string, unknown>(),
    page: async ({ before, limit = 50 }: { before?: string; limit?: number }) => {
      calls.pages.push({ before, limit });
      const end = before === undefined ? count : Number(before.slice('raw-'.length)); const start = Math.max(0, end - limit);
      return { hits: ids.slice(start, end).map((id, offset) => ({ id, kind: 'event', occurredAt: at(start + offset) })), nextCursor: start > 0 ? `raw-${start}` : null };
    },
    readBatch: async ({ ids: requested }: { ids: string[] }) => {
      assert.ok(requested.length <= 10); calls.originals += requested.length;
      return requested.filter(id => !history.omit.has(id)).map(id => {
        const position = index.get(id)!;
        if (history.entries.has(id)) return { id, entry: history.entries.get(id), tooLarge: false };
        return { id, entry: isVisible(position) ? { id, kind: 'event', miraId: 'paged', occurredAt: at(position), requestedWake: null,
          event: { id: `event-${position}`, source: 'user', type: 'web.message', occurredAt: at(position), payload: { text: text(position) } } } : null, tooLarge: false };
      });
    },
    snapshot: async (work: (reader: unknown) => Promise<unknown>) => { calls.snapshots++; return work(history); }, findEventReceipt: async () => null,
    pageCursorThrough: async ({ id }: { id: string }) => {
      const position = index.get(id);
      return position === undefined ? null : { before: position + 1 < count ? `raw-${position + 1}` : null };
    },
  };
  const service = Reflect.construct(LocalWebService, [{ dreaming: { enabled: false } }, { signal: new AbortController().signal, onLiveInput: () => () => {} }, history, {}, {}, {}, {}, {}, {}]) as LocalWebService;
  return { history, service, ids };
}

test('reading far into older history keeps the latest window cached in least-recently-used order', async () => {
  const { history, service } = pagedHistory(8_000, () => false);
  const latest = await service.timeline(); assert.ok(latest.nextCursor); assert.deepEqual(latest.items, []);
  const latestReads = history.calls.originals; assert.ok(latestReads > 0);
  let cursor: string | null = latest.nextCursor;
  // Several complete older scans insert far more records than the cache holds.
  while (cursor) {
    const older = await service.timeline(cursor); cursor = older.nextCursor;
    const before = history.calls.originals;
    assert.deepEqual(await service.timeline(), latest);
    assert.equal(history.calls.originals, before, 'a latest poll between older scans reuses its cached window');
  }
  assert.equal(history.calls.originals, 8_000, 'every hidden original was read exactly once');
});

test('timeline passes raw cursors through, bounds latest polls and fills older requests to visible messages', async () => {
  // 1,000 records: the newest 400 hidden, then one visible message every tenth record.
  const { history, service, ids } = pagedHistory(1_000, index => index < 600 && index % 10 === 0);
  const latest = await service.timeline();
  assert.deepEqual(latest, { items: [], nextCursor: 'raw-700' }, 'a latest poll scans three raw pages, then returns its exact continuation');
  assert.deepEqual(history.calls.pages, [{ before: undefined, limit: 100 }, { before: 'raw-900', limit: 100 }, { before: 'raw-800', limit: 100 }]);
  assert.equal(history.calls.snapshots, 1);
  history.calls.pages.length = 0;
  const older = await service.timeline(latest.nextCursor!);
  // Pages 600-699 (hidden) and 0-599 (60 visible) are consumed whole: 50 is reached
  // inside the 100-199 page, so 10 visible rows remain behind cursor raw-100.
  assert.deepEqual(history.calls.pages.map(page => page.before), ['raw-700', 'raw-600', 'raw-500', 'raw-400', 'raw-300', 'raw-200']);
  assert.equal(older.nextCursor, 'raw-100');
  assert.deepEqual(older.items.map(item => item.id), ids.filter((_, index) => index >= 100 && index < 600 && index % 10 === 0));
  assert.equal(older.items.length, 50);
  const oldest = await service.timeline(older.nextCursor!);
  assert.equal(oldest.nextCursor, null);
  assert.deepEqual(oldest.items.map(item => item.text), Array.from({ length: 10 }, (_, i) => `Visible ${i * 10}`));
  assert.equal(history.calls.snapshots, 3, 'one snapshot per response');
});

test('timeline stops between raw pages once visible text reaches the response budget', async () => {
  const { history, service } = pagedHistory(500, index => index % 5 < 2, () => 'x'.repeat(110_000));
  const page = await service.timeline('raw-500');
  // 40 visible rows of 110 kB pass the 4 MiB budget within the first page, below
  // the 50-row target; the whole page is returned with its exact continuation.
  assert.equal(page.items.length, 40); assert.equal(page.nextCursor, 'raw-400');
  assert.equal(history.calls.pages.length, 1);
});

test('timeline rejects a history batch that omits a requested original instead of hiding it', async () => {
  const { HistoryError } = await import('@mira/life');
  const { history, service, ids } = pagedHistory(20, () => true);
  history.omit.add(ids[7]!);
  await assert.rejects(service.timeline(), (error: unknown) => error instanceof HistoryError && error.code === 'corrupt');
  history.omit.clear();
  assert.equal((await service.timeline()).items.length, 20, 'a later complete batch is projected normally');
});

test('a quoted message is located contiguously from the reader frontier when near, else by its own window', async () => {
  const { history, service, ids } = pagedHistory(3_000, index => index % 3 === 0);
  const latest = await service.timeline(); assert.ok(latest.nextCursor);
  const loaded = new Set(latest.items.map(item => item.id));
  // Near: reading on from the frontier reaches the message without leaving a gap.
  const near = await service.locateTimeline(ids[2_400]!, latest.nextCursor);
  assert.equal(near?.mode, 'contiguous');
  assert.ok(near.items.some(item => item.id === ids[2_400]));
  assert.ok(near.items.length > 50, 'reading continues past the ordinary target until the message');
  assert.equal(near.items.at(-1)!.id, ids[2_799], 'the page continues directly below the loaded window');
  assert.ok(near.items.every(item => !loaded.has(item.id)));
  // Far: beyond the 2,000-record contiguous budget, the window ends at the message.
  const snapshots = history.calls.snapshots;
  const far = await service.locateTimeline(ids[30]!, latest.nextCursor);
  assert.equal(history.calls.snapshots, snapshots + 1, 'one snapshot per lookup');
  assert.equal(far?.mode, 'window');
  assert.equal(far.items.at(-1)!.id, ids[30], 'the window ends at the quoted message');
  assert.equal(far.items[0]!.id, ids[0]);
  assert.equal(far.nextCursor, null);
  const without = await service.locateTimeline(ids[1_500]!);
  assert.equal(without?.mode, 'window'); assert.equal(without.items.at(-1)!.id, ids[1_500]); assert.ok(without.nextCursor);
  // Private or unknown records are never located.
  assert.equal(await service.locateTimeline(ids[31]!), null);
  assert.equal(await service.locateTimeline(randomUUID()), null);
});

const publishedAttachment = { id: randomUUID(), name: 'late.txt', mimeType: 'text/plain', size: 4, sha256: 'a'.repeat(64) };
function attachmentTool(id: string, occurredAt: string, done: boolean) {
  return { id, kind: 'tool', miraId: 'paged', occurredAt, intent: { toolName: 'send_attachment', callId: 'late-call' },
    outcome: done ? { callId: 'late-call', payload: { role: 'toolResult', toolName: 'send_attachment', toolCallId: 'late-call', isError: false, details: { version: 1, type: 'attachment-publication', text: '附件到了', attachments: [publishedAttachment] } } } : null };
}

test('an attachment publication that completes after leaving the latest window reaches latest polls as an update', async () => {
  // Regression for audit #10: the publication sits at its intent record, 400 raw records before the newest.
  const { history, service, ids } = pagedHistory(1_000, index => index > 700 && index % 10 === 0);
  const tool = ids[600]!; const at = new Date(Date.UTC(2026, 9, 1) + 600 * 1000).toISOString();
  history.entries.set(tool, attachmentTool(tool, at, false));
  // The tool was pending when the user read that stretch of older history.
  const latest = await service.timeline(); assert.equal(latest.updates, undefined);
  const older = await service.timeline(latest.nextCursor!);
  assert.equal(older.items.some(item => item.id === tool), false);
  // It completes; the latest window (newest 300 raw records) never covers it.
  history.entries.set(tool, attachmentTool(tool, at, true));
  const polled = await service.timeline();
  assert.equal(polled.items.some(item => item.id === tool), false);
  assert.deepEqual(polled.updates?.map(item => ({ id: item.id, role: item.role, text: item.text, attachments: item.attachments?.map(file => file.name) })), [{ id: tool, role: 'assistant', text: '附件到了', attachments: ['late.txt'] }]);
  // Other tabs polling later still receive it; older reads never carry updates.
  assert.equal((await service.timeline()).updates?.[0]?.id, tool);
  assert.equal((await service.timeline(latest.nextCursor!)).updates, undefined);
  // Reading the stretch again now shows the completed publication in place.
  assert.equal((await service.timeline(latest.nextCursor!)).items.some(item => item.id === tool), true);
});

test('pending tool tracking is bounded and forgets entries that vanish', async () => {
  const { history, service, ids } = pagedHistory(1_000, () => false);
  for (const id of ids) history.entries.set(id, attachmentTool(id, new Date(Date.UTC(2026, 9, 1)).toISOString(), false));
  // Latest covers 700-999; an older read sees 700 more pending tools.
  const latest = await service.timeline(); await service.timeline(latest.nextCursor!);
  const reads = async () => { const before = history.calls.originals; await service.timeline(); return history.calls.originals - before; };
  // 300 for the window itself plus at most 512 tracked tools outside it.
  const first = await reads(); assert.ok(first <= 300 + 512, `poll re-read ${first} originals`); assert.ok(first > 300);
  // Records that are no longer readable stop being tracked.
  for (const id of ids.slice(0, 700)) history.omit.add(id);
  await reads(); assert.equal(await reads(), 300);
});

test('concurrent timeline reads share a bounded number of snapshots and all complete in order', async () => {
  const { history, service } = pagedHistory(400, index => index % 4 === 0);
  let active = 0, peak = 0; const original = history.snapshot;
  history.snapshot = async (work: (reader: unknown) => Promise<unknown>) => {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 5)); return await original(work); } finally { active--; }
  };
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => index % 3 ? service.timeline() : service.timeline('raw-200')));
  assert.equal(peak, TIMELINE_READ_CONCURRENCY);
  assert.equal(results.length, 12); assert.ok(results.every(result => result.items.length > 0));
  // A failing read releases its slot.
  history.snapshot = async () => { throw new Error('synthetic'); };
  await assert.rejects(Promise.all(Array.from({ length: 6 }, () => service.timeline())));
  history.snapshot = original;
  assert.ok((await service.timeline()).items.length > 0);
});
