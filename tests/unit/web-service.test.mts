import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LocalWebService } from '@mira/server';
import { encodeEntry, messageEntry } from '../../packages/runtime-pi/src/records.ts';
import { assistant } from '../recovery/fixtures.mts';

// Exercise the real service projection with a read-only history fixture, without
// claiming PostgreSQL execution. Durable associations remain in run management.
test('chat omits delegation-only rows and reads while preserving text, attachments and history cursors', async () => {
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
    page: async ({ before }: { before?: string }) => { cursors.push(before); return { hits: entries.map(({ id, kind, occurredAt }) => ({ id, kind, occurredAt })), nextCursor: 'older-history' }; },
    read: async ({ id }: { id: string }) => entries.find(value => value.id === id),
  };
  let childReads = 0;
  const reader = { readSubagentCalls: async () => { childReads++; return [{ callId: 'spawn', runId: randomUUID(), childId: randomUUID() }]; } };
  const service = Reflect.construct(LocalWebService, [{ dreaming: { enabled: false } }, { signal: new AbortController().signal, onLiveInput: () => () => {} }, history, {}, {}, {}, {}, {}, reader]) as LocalWebService;
  const first = await service.timeline();
  assert.equal(first.nextCursor, 'older-history');
  assert.deepEqual(first.items.map(item => item.id), [user.id, reply.id]);
  assert.equal(first.items[0]!.externalEventId, 'user-request');
  assert.deepEqual(first.items[0]!.attachments, [attachment]);
  assert.equal(first.items[1]!.text, 'Mira keeps the conversation going.');
  publication.outcome = { callId: 'publish', payload: { role: 'toolResult', toolName: 'send_attachment', toolCallId: 'publish', isError: false,
    details: { version: 1, type: 'attachment-publication', text: '', attachments: [attachment] } } };
  const next = await service.timeline('older-history');
  assert.deepEqual(next.items.map(item => item.id), [user.id, reply.id, publication.id]);
  assert.deepEqual(next.items.at(-1)!.attachments, [attachment], 'pending tool cache still admits an explicit later attachment publication');
  assert.ok(next.items.every(item => !Object.hasOwn(item, 'child')));
  assert.equal(childReads, 0, 'chat does not request child metadata or start child polling');
  assert.deepEqual(cursors, [undefined, 'older-history']);
});

test('automatic ownership close retains a safe persistence notice but suppresses ordinary shutdown errors', async () => {
  const { DurableOperationError } = await import('@mira/life');
  const { PersistenceFailureNotice } = await import('../../apps/server/src/persistence-errors.ts');
  for (const failure of [new DurableOperationError('persistence-write-failure', 'private database detail'), new Error('private cancellation detail')]) {
    const owner = new AbortController();
    const resource = { close: async () => {} };
    const writer = { signal: owner.signal, onLiveInput: () => () => {}, receiveLiveInput: async () => 'inserted', close: async () => {} };
    const loop = { drain: async () => { await Promise.resolve(); owner.abort(failure); throw failure; } };
    const service = Reflect.construct(LocalWebService, [{ synthetic: true, dreaming: { enabled: false } }, writer, {}, {}, { selection: null }, loop,
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
