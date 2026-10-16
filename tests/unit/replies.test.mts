import { boundedFixtureWait, providerEntered } from '../recovery/service-wait-fixture.mts';
import type { LocalWebService } from '@mira/server';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import type { HistoryEntry, HistoryEvent, HistoryTool, HistoryReader } from '@mira/life';
import { resolveReply, replyPublication, createReplyTool, ReplyTargetError } from '../../apps/server/src/replies.ts';
import { visible } from '../../apps/server/src/web-service.ts';
import { AttachmentStore } from '../../apps/server/src/attachments.ts';
import { createLocalHttp, type WebBackend } from '../../apps/server/src/http.ts';

function event(text = 'original'): HistoryEvent { return { id: randomUUID(), kind: 'event', miraId: 'main', occurredAt: '2026-10-16T10:00:00.000Z', event: { id: 'external', type: 'web.message', source: 'user', occurredAt: '2026-10-16T10:00:00.000Z', payload: { text } }, requestedWake: null }; }
function history(entry: HistoryEntry | null): HistoryReader { return { miraId: 'main', read: async () => entry } as unknown as HistoryReader; }
test('reply resolver uses only public same-Mira targets, Unicode bounds and source whitelist', async () => {
  const original = event('😀'.repeat(600));
  const quote = await resolveReply(history(original), visible, original.id);
  assert.equal([...quote.text].length, 500); assert.equal(quote.role, 'user');
  for (const entry of [null, { ...original, miraId: 'child' }, { ...original, event: { ...original.event, source: 'system' } }] as Array<HistoryEntry | null>) await assert.rejects(resolveReply(history(entry), visible, original.id), ReplyTargetError);
  await assert.rejects(resolveReply(history(original), visible, 'external'), ReplyTargetError);
  const source = { ...original, event: { id: JSON.stringify(['extension', 'provider', 'e']), type: 'message', source: 'extension', occurredAt: original.occurredAt, payload: { extensionId: 'provider', eventId: 'e', message: { direction: 'inbound', text: 'source content', sourceLabel: 'Provider', senderId: 'sender', senderVerified: true, private: 'secret' } } } } as HistoryEntry;
  const sourced = await resolveReply(history(source), visible, source.id);
  assert.deepEqual(sourced.source, { kind: 'extension', extensionId: 'provider', label: 'Provider', direction: 'inbound', senderId: 'sender', senderVerified: true });
  assert.ok(!JSON.stringify(sourced).includes('secret'));
});
test('send_reply publication requires immutable successful exact call linkage and strips paths', async t => {
  const root = await mkdtemp('/tmp/mira-reply-unit-'); t.after(() => rm(root, { recursive: true, force: true }));
  const store = await AttachmentStore.open(path.join(root, 'store'), []); const attachment = await store.stage('reply.txt', Buffer.from('bytes'));
  const target = event(); const tool = createReplyTool(history(target), visible, store);
  const result = await tool.execute('call', { replyToMessageId: target.id, text: 'sent', attachmentIds: [attachment.id] });
  const entry = { id: randomUUID(), kind: 'tool', intent: { toolName: 'send_reply', callId: 'call' }, outcome: { callId: 'call', payload: { role: 'toolResult', toolName: 'send_reply', toolCallId: 'call', isError: false, ...result } } } as unknown as HistoryTool;
  const publication = replyPublication(entry)!; assert.equal(publication.reply.messageId, target.id); assert.equal(publication.text, 'sent'); assert.equal(publication.attachments?.[0]?.id, attachment.id); assert.ok(!JSON.stringify(publication).includes(root));
  assert.equal(replyPublication({ ...entry, outcome: null } as HistoryEntry), null);
  assert.equal(replyPublication({ ...entry, outcome: { ...entry.outcome, callId: 'different' } } as HistoryEntry), null);
  assert.equal(replyPublication({ ...entry, outcome: { ...entry.outcome, payload: { ...(entry.outcome!.payload as Record<string, unknown>), isError: true } } } as HistoryEntry), null);
});
test('HTTP accepts only target UUID and whitelists reply fields on both timeline routes', async t => {
  const id = randomUUID(); let accepted: unknown;
  const backend = { submit: async (input: unknown) => { accepted = input; return { id: 'request', receipt: 'inserted' }; }, timeline: async () => ({ items: [{ id: randomUUID(), role: 'user', text: 'new', occurredAt: '2026-10-16T10:00:00.000Z', reply: { messageId: id, role: 'assistant', text: 'original' } }], nextCursor: null }) } as unknown as WebBackend;
  const app = createLocalHttp({ backend, port: 4777 }); t.after(() => app.close());
  const headers = { host: '127.0.0.1:4777', origin: 'http://127.0.0.1:4777', 'content-type': 'application/json', 'x-mira-client': 'web' };
  const body = { id: 'request', text: 'reply', occurredAt: '2026-10-16T10:00:00.000Z', replyToMessageId: id };
  assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers, payload: body })).statusCode, 201); assert.deepEqual(accepted, body);
  for (const payload of [{ ...body, replyToMessageId: 'external' }, { ...body, reply: { text: 'forged' } }]) assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers, payload })).statusCode, 400);
  const response = await app.inject({ method: 'GET', url: '/api/timeline', headers }); assert.equal(response.statusCode, 200); assert.deepEqual(response.json().items[0].reply, { messageId: id, role: 'assistant', text: 'original' });
  const older = await app.inject({ method: 'POST', url: '/api/timeline', headers, payload: { before: 'cursor' } }); assert.equal(older.statusCode, 200); assert.deepEqual(older.json().items[0].reply, response.json().items[0].reply);
});


test('fixture barriers unwind cleanup on their own deadline and propagate provider assertions', async () => {
  let cleaned = false;
  await assert.rejects((async () => {
    try { await boundedFixtureWait(new Promise<void>(() => {}), 'synthetic held provider', undefined, 20); }
    finally { cleaned = true; }
  })(), /synthetic held provider: timed out/);
  assert.equal(cleaned, true, 'fixture finally runs without relying on Node test timeout');
  const failure = new Error('exact failed provider assertion');
  const service = { status: async () => ({ state: 'error', error: 'protected service error' }) } as unknown as LocalWebService;
  await assert.rejects(providerEntered(service, () => false, () => failure), error => error === failure);
  await assert.rejects(providerEntered(service, () => false, () => undefined), /Provider did not enter:.*protected service error/);
});

test('fixture held provider honors abort and cleans up its pending deadline', async () => {
  const controller = new AbortController(); const reason = new Error('fixture test cancelled'); let cleaned = false;
  const work = (async () => { try { await boundedFixtureWait(new Promise<void>(() => {}), 'release', controller.signal); } finally { cleaned = true; } })();
  controller.abort(reason);
  await assert.rejects(work, error => error === reason); assert.equal(cleaned, true);
});
