import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LocalWebService } from '@mira/server';
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
    snapshot: async (work: (reader: unknown) => Promise<unknown>) => work(history),
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
    snapshot: async (work: (reader: unknown) => Promise<unknown>) => work(history),
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
    page: async ({ before, limit = 50 }: { before?: string; limit?: number }) => {
      calls.pages.push({ before, limit });
      const end = before === undefined ? count : Number(before.slice('raw-'.length)); const start = Math.max(0, end - limit);
      return { hits: ids.slice(start, end).map((id, offset) => ({ id, kind: 'event', occurredAt: at(start + offset) })), nextCursor: start > 0 ? `raw-${start}` : null };
    },
    readBatch: async ({ ids: requested }: { ids: string[] }) => {
      assert.ok(requested.length <= 10); calls.originals += requested.length;
      return requested.filter(id => !history.omit.has(id)).map(id => {
        const position = index.get(id)!;
        return { id, entry: isVisible(position) ? { id, kind: 'event', miraId: 'paged', occurredAt: at(position), requestedWake: null,
          event: { id: `event-${position}`, source: 'user', type: 'web.message', occurredAt: at(position), payload: { text: text(position) } } } : null, tooLarge: false };
      });
    },
    snapshot: async (work: (reader: unknown) => Promise<unknown>) => { calls.snapshots++; return work(history); },
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
