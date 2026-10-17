import { boundedFixtureWait, providerEntered } from './service-wait-fixture.mts';
import type { Json } from '@mira/context';
import assert from 'node:assert/strict';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { LocalWebService, WebHttpError, createLocalHttp } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf, deferred } from './fixtures.mts';
import { getCurrentSystemMessage, getCurrentTools, getSystemMessageText } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';

async function settled(service: LocalWebService): Promise<void> {
  const end = Date.now() + 15_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > end) throw Error(`Service did not settle: ${JSON.stringify(await service.status())}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const status = await service.status(); assert.equal(status.state, 'idle', JSON.stringify(status));
}
test('bidirectional replies persist canonical snapshots, attachments and exact publication IDs across PostgreSQL restart', { timeout: 45_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-reply-recovery-'));
  let service: LocalWebService | undefined; let calls = 0; let target = ''; let attachmentId = ''; const requests: string[] = [];
  try {
    const syntheticStream: StreamFn = (_model, context) => {
      calls++; requests.push(JSON.stringify(context));
      if (calls === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'reply-once', name: 'send_reply', arguments: { replyToMessageId: target, text: 'Published reply', attachmentIds: [attachmentId] } }] });
      return streamOf(assistant(calls === 1 ? 'First assistant target' : ''));
    };
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'replies-main', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, syntheticStream };
    service = await LocalWebService.open(options); await settled(service);
    await service.submit({ id: 'first', text: 'Original user target', occurredAt: '2026-10-16T10:00:00.000Z' }); await settled(service);
    let page = await service.timeline(); const firstUser = page.items.find(item => item.role === 'user')!; const firstAssistant = page.items.find(item => item.role === 'assistant')!;
    target = firstUser.id;
    assert.ok(requests[0]!.includes(firstUser.id), 'ordinary user canonical ID reaches actual model request');
    attachmentId = (await service.uploadAttachment('reply.txt', Buffer.from('reply attachment'))).id;
    const input = { id: 'reply-user', text: 'User reply', replyToMessageId: firstAssistant.id, occurredAt: '2026-10-16T10:01:00.000Z' };
    assert.equal((await service.submit(input)).receipt, 'inserted'); await settled(service);
    assert.equal(calls, 3);
    page = await service.timeline(); const userReply = page.items.find(item => item.externalEventId === input.id)!;
    assert.deepEqual(userReply.reply, { messageId: firstAssistant.id, role: 'assistant', text: firstAssistant.text });
    const published = page.items.find(item => item.text === 'Published reply')!;
    assert.deepEqual(published.reply, { messageId: firstUser.id, role: 'user', text: firstUser.text });
    assert.equal(published.attachments?.[0]?.id, attachmentId);
    assert.ok(requests[1]!.includes(firstAssistant.id)); assert.ok(requests[1]!.includes(firstAssistant.text));
    assert.equal((await service.submit(input)).receipt, 'duplicate');
    await assert.rejects(service.submit({ ...input, replyToMessageId: firstUser.id }), (error: unknown) => error instanceof WebHttpError && error.code === 'conflict');
    for (const id of ['not-a-uuid', randomUUID()]) await assert.rejects(service.submit({ ...input, id: randomUUID(), replyToMessageId: id }), (error: unknown) => error instanceof WebHttpError && error.code === 'invalid_input');
    assert.ok(!JSON.stringify(page).includes(root));
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service);
    assert.equal(calls, 3, 'successful tool must not replay');
    page = await service.timeline(); assert.equal(page.items.filter(item => item.text === 'Published reply').length, 1);
    assert.deepEqual(page.items.find(item => item.id === published.id), published);
    assert.deepEqual(page.items.find(item => item.id === userReply.id), userReply);
    assert.equal((await service.submit(input)).receipt, 'duplicate'); assert.equal(calls, 3);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('same-Mira public projection rejects cross-Mira, notices, Wake and internal events', { timeout: 45_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-reply-boundaries-')); let service: LocalWebService | undefined;
  try {
    const main = await db.acquire('boundary-main');
    await main.receive({ id: 'internal', type: 'hidden', source: 'system', occurredAt: '2026-10-16T10:00:00.000Z', payload: { text: 'secret' } });
    await main.receive({ id: 'wake', type: 'hidden', source: 'system', occurredAt: '2026-10-16T10:00:00.000Z', payload: {} }, { id: 'hidden-wake', reason: 'internal' });
    await main.receive({ id: JSON.stringify(['external-notification', 'fixture', 'notice']), type: 'external.notification', source: 'external', occurredAt: '2026-10-16T10:00:00.000Z', payload: { operation: 'notification', senderId: 'fixture', notificationId: 'notice', text: 'notice target prohibited' } });
    await main.close();
    const foreign = await db.acquire('other-mira');
    await foreign.receive({ id: 'foreign', type: 'web.message', source: 'user', occurredAt: '2026-10-16T10:00:00.000Z', payload: { text: 'foreign' } }); await foreign.close();
    const child = await db.acquire('boundary-child');
    await child.receive({ id: 'child', type: 'web.message', source: 'user', occurredAt: '2026-10-16T10:00:00.000Z', payload: { text: 'child secret' } }); await child.close();
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'boundary-main', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, syntheticStream: () => streamOf(assistant('')) }); await settled(service);
    const ids = [];
    for (const mira of ['boundary-main', 'boundary-child', 'other-mira']) ids.push(...(await db.store.history(mira).page({ kinds: ['event', 'wake'] })).hits.map(hit => hit.id));
    assert.ok(ids.length >= 4);
    for (const replyToMessageId of ids) await assert.rejects(service.submit({ id: randomUUID(), text: 'reply', occurredAt: '2026-10-16T11:00:00.000Z', replyToMessageId }), (error: unknown) => error instanceof WebHttpError && error.code === 'invalid_input');
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real child transcript IDs stay private and generic extension sources retain frozen reply provenance', { timeout: 45_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-reply-source-')); let service: LocalWebService | undefined;
  let mainCalls = 0; let childChecked = false;
  try {
    const writer = await db.acquire('source-main');
    for (const direction of ['inbound', 'outbound']) await writer.receive({ id: JSON.stringify(['extension', 'fixture-source', direction]), source: 'extension', type: 'message', occurredAt: '2026-10-16T10:00:00.000Z', payload: { extensionId: 'fixture-source', eventId: direction, message: { direction, text: `${direction} source content`, sourceLabel: 'Fixture source', senderId: 'sender', senderVerified: true } } });
    await writer.close();
    const stream: StreamFn = (_model, context) => {
      const system = getCurrentSystemMessage(context.messages);
      if (system && getSystemMessageText(system).includes('task-scoped worker')) {
        const tools = getCurrentTools(context.messages); assert.ok(tools.some(tool => tool.name === 'read')); assert.ok(!tools.some(tool => tool.name === 'send_reply')); childChecked = true;
        return streamOf(assistant('CHILD_PRIVATE_REPLY_TARGET'));
      }
      mainCalls++;
      if (mainCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'spawn-reply-child', name: 'subagent_spawn', arguments: { task: 'Produce a private child finding', fork: 'none' } }] });
      return streamOf(assistant(''));
    };
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'source-main', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, syntheticStream: stream }); await settled(service);
    const sources = (await service.timeline()).items.filter(item => item.source);
    assert.equal(sources.length, 2);
    await service.submit({ id: 'spawn', text: 'Delegate a task', occurredAt: '2026-10-16T11:00:00.000Z' });
    const end = Date.now() + 15_000;
    while (!childChecked || !(await db.admin.query('SELECT 1 FROM subagent_turns WHERE parent_mira_id=$1 AND status=$2', ['source-main', 'completed'])).rowCount) { if (Date.now() > end || (await service.status()).state === 'error') throw Error(`Child not completed: service=${JSON.stringify(await service.status())}; turns=${JSON.stringify((await db.admin.query('SELECT status FROM subagent_turns WHERE parent_mira_id=$1', ['source-main'])).rows)}`); await new Promise(resolve => setTimeout(resolve, 10)); }
    await settled(service);
    const childIds = (await db.admin.query('SELECT record_id FROM context_records JOIN subagents ON subagents.stream_id=context_records.mira_id WHERE subagents.parent_mira_id=$1', ['source-main'])).rows.map(row => row.record_id as string);
    assert.ok(childIds.length > 0);
    for (const replyToMessageId of childIds) await assert.rejects(service.submit({ id: randomUUID(), text: 'Cannot expose child', occurredAt: '2026-10-16T12:00:00.000Z', replyToMessageId }), (error: unknown) => error instanceof WebHttpError && error.code === 'invalid_input');
    for (const source of sources) { await service.submit({ id: `reply-${source.source!.direction}`, text: 'Reply to source', occurredAt: '2026-10-16T12:00:00.000Z', replyToMessageId: source.id }); await settled(service); }
    const timeline = await service.timeline();
    for (const source of sources) { const reply = timeline.items.find(item => item.externalEventId === `reply-${source.source!.direction}`)!.reply!; assert.deepEqual(reply.source, source.source); assert.equal(reply.role, source.role); assert.equal(reply.messageId, source.id); }
    assert.ok(!JSON.stringify(timeline).includes('CHILD_PRIVATE_REPLY_TARGET'));
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('live Web reply is admitted during a real tool and reaches the next model request with frozen metadata', { timeout: 45_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-reply-live-')); let service: LocalWebService | undefined; let calls = 0; let observed = ''; let target = '';
  try {
    const stream: StreamFn = (_model, context) => {
      calls++;
      if (calls === 1) return streamOf(assistant('Original assistant target'));
      if (calls === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'reply-live-delay', name: 'bash', arguments: { command: 'sleep 1' } }] });
      observed = JSON.stringify(context.messages); return streamOf(assistant('Consumed live reply'));
    };
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'reply-live', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, syntheticStream: stream };
    service = await LocalWebService.open(options); await settled(service);
    await service.submit({ id: 'target', text: 'Prepare target', occurredAt: '2026-10-16T10:00:00.000Z' }); await settled(service);
    target = (await service.timeline()).items.find(item => item.role === 'assistant')!.id;
    await service.submit({ id: 'working', text: 'Wait briefly', occurredAt: '2026-10-16T10:01:00.000Z' });
    const end = Date.now() + 10_000;
    while (!(await db.admin.query('SELECT 1 FROM tool_executions WHERE mira_id=$1 AND call_id=$2', ['reply-live', 'reply-live-delay'])).rowCount) { if (Date.now() > end || (await service.status()).state === 'error') throw Error(`Tool not entered: ${JSON.stringify(await service.status())}`); await new Promise(resolve => setTimeout(resolve, 5)); }
    const reply = { id: 'live-reply', text: 'Reply during work', occurredAt: '2026-10-16T10:02:00.000Z', replyToMessageId: target };
    await service.submit(reply); await settled(service);
    assert.match(observed, /Reply during work/); assert.ok(observed.includes(target)); assert.match(observed, /Original assistant target/);
    const inputs = (await db.admin.query('SELECT * FROM wake_live_inputs WHERE mira_id=$1', ['reply-live'])).rows;
    assert.equal(inputs.length, 1); assert.ok(inputs[0].input_record_id);
    const saved = (await service.timeline()).items.find(item => item.externalEventId === reply.id)!;
    assert.equal(saved.reply?.messageId, target);
    const before = calls; await service.close(); service = await LocalWebService.open(options); await settled(service);
    assert.equal(calls, before); assert.deepEqual((await service.timeline()).items.find(item => item.id === saved.id), saved);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('HTTP retries preserve old pending envelopes and actual history tools discover legacy reply targets', { timeout: 30_000 }, async t => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-reply-old-retry-')); let service: LocalWebService | undefined;
  const release = deferred(); let entered = false; let providerFailure: unknown; let calls = 0; let discoveredId = '';
  try {
    const input = { id: 'old-pending', text: 'Original pending message', occurredAt: '2026-10-16T10:00:00.000Z' };
    const writer = await db.acquire('old-retry');
    await writer.receiveLiveInput({ id: input.id, occurredAt: input.occurredAt, type: 'web.message', source: 'user', payload: { text: input.text } }, { id: `web:${input.id}`, reason: 'User message from the local web interface' });
    await writer.close();
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'old-retry', sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, syntheticStream: async (_model, context, streamOptions) => {
      try {
        calls++;
        if (calls === 1) { entered = true; await boundedFixtureWait(release.promise, 'Legacy provider release', AbortSignal.any([t.signal, ...(streamOptions?.signal ? [streamOptions.signal] : [])])); return streamOf(assistant('Finished old input')); }
        const call = (id: string, name: string, args: Record<string, Json>) => streamOf({ ...assistant(), stopReason: 'toolUse' as const, content: [{ type: 'toolCall' as const, id, name, arguments: args }] });
        if (calls === 2) return call('find-old-target', 'history_search', { query: 'Original pending message', mode: 'substring', kinds: ['event'] });
        const expectedCall = calls === 3 ? 'find-old-target' : 'read-old-target';
        const last = context.messages.findLast(message => message.role === 'toolResult' && message.toolCallId === expectedCall);
        if (calls === 3 || calls === 4) {
          assert.ok(last?.role === 'toolResult'); assert.equal(last.toolName, calls === 3 ? 'history_search' : 'history_read'); assert.equal(last.isError, false); const block = last.content.find(item => item.type === 'text'); assert.ok(block?.type === 'text');
          const result = JSON.parse(block.text);
          if (calls === 3) { assert.equal(result.hits.length, 1); discoveredId = result.hits[0].id; return call('read-old-target', 'history_read', { id: discoveredId }); }
          assert.equal(result.id, discoveredId); assert.deepEqual(result.event.payload, { text: input.text });
          return call('reply-to-legacy', 'send_reply', { replyToMessageId: result.id, text: 'Reply discovered through History' });
        }
        return streamOf(assistant(''));
      } catch (error) { providerFailure = error; throw error; }
    } });
    await providerEntered(service, () => entered, () => providerFailure, t.signal);
    const app = createLocalHttp({ backend: service, port: 4779 });
    try {
      const headers = { host: '127.0.0.1:4779', origin: 'http://127.0.0.1:4779', 'x-mira-client': 'web' };
      const retry = await app.inject({ method: 'POST', url: '/api/messages', headers, payload: input }); assert.equal(retry.statusCode, 200); assert.equal(retry.json().receipt, 'duplicate');
      assert.equal((await app.inject({ method: 'POST', url: '/api/messages', headers, payload: { ...input, text: 'Changed' } })).statusCode, 409);
      const eventId = (await db.store.history('old-retry').findEventRun(input.id))!.eventId;
      const original = await db.store.history('old-retry').read({ id: eventId }); assert.ok(original?.kind === 'event');
      assert.deepEqual(original.event.payload, { text: input.text });
    } finally { await app.close(); }
    release.resolve(); await settled(service).catch(error => { throw providerFailure ?? error; });
    await service.submit({ id: 'find-older', text: 'Find the earlier user message and reply to it', occurredAt: '2026-10-16T11:00:00.000Z' }); await settled(service).catch(error => { throw providerFailure ?? error; });
    if (providerFailure !== undefined) throw providerFailure;
    const published = (await service.timeline()).items.find(item => item.text === 'Reply discovered through History');
    assert.ok(published); assert.equal(published.reply?.messageId, discoveredId); assert.equal(published.reply?.text, input.text); assert.equal(calls, 5);
  } finally { release.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
