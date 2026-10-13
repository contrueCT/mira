import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { ExternalProtocolError, type ExternalEvent } from '@mira/external-sdk';
import type { LifeEvent } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

const sender = 'synthetic-sender-a';
const occurredAt = '2026-10-13T01:00:00.000Z';
const namespace = (senderId: string, id: string) => JSON.stringify(['external', senderId, id]);
const notificationNamespace = (senderId: string, id: string) => JSON.stringify(['external-notification', senderId, id]);
const event = (id = 'record-1', text = 'EXTERNAL_SOURCE_FACT'): ExternalEvent => ({
  id, type: 'fixture.status', occurredAt, payload: { recordId: id, text, details: { count: 2, labels: ['synthetic', 'bounded'] } },
});
type Database = Awaited<ReturnType<typeof createTestDatabase>>;

async function settled(service: LocalWebService): Promise<void> {
  const end = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > end) throw Error('External service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function options(db: Database, root: string, miraId: string) {
  return {
    connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(),
    workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
  };
}
async function durableEvents(db: Database) {
  return (await db.admin.query<{ event_id: string; event: LifeEvent; history_id: string; requested_wake: unknown }>(
    'SELECT event_id, event, history_id, requested_wake FROM life_events ORDER BY event_id')).rows;
}
async function runs(db: Database) {
  return (await db.admin.query<{ run_id: string; input_record_id: string | null; final_record_id: string | null; completed: boolean }>(
    'SELECT run_id, input_record_id, final_record_id, completed FROM wake_runs ORDER BY run_id')).rows;
}
async function noCognition(db: Database): Promise<void> {
  for (const table of ['wake_requests', 'wake_runs', 'wake_run_requests', 'context_records', 'tool_executions']) {
    assert.equal((await db.admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n, 0, `${table} must stay empty without a Wake`);
  }
}

test('real PostgreSQL external service: silent events and notifications persist separately without cognition and retain History identity across restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-external-silent-');
  let service: LocalWebService | undefined; let calls = 0;
  try {
    const configuration = { ...options(db, root, 'external-silent'), syntheticStream: () => { calls++; return streamOf(assistant('Unexpected cognition')); } };
    service = await LocalWebService.open(configuration); await settled(service);
    const fact = event('shared-id');
    const notice = { id: fact.id, occurredAt, text: 'Synthetic background job finished' };
    assert.deepEqual(await service.external.emitEvent(sender, fact), { operation: 'event', id: fact.id, receipt: 'inserted', durability: 'persisted' });
    assert.deepEqual(await service.external.sendNotification(sender, notice), { operation: 'notification', id: notice.id, receipt: 'inserted', durability: 'persisted' });
    const otherSender = 'synthetic-sender-b';
    assert.equal((await service.external.sendNotification(otherSender, notice)).receipt, 'inserted');
    await settled(service); assert.equal(calls, 0); await noCognition(db);
    const original = await durableEvents(db); assert.equal(original.length, 3);
    assert.equal(new Set(original.map(row => row.history_id)).size, 3);
    const savedFact = original.find(row => row.event_id === namespace(sender, fact.id))!;
    assert.deepEqual(savedFact.event, { id: namespace(sender, fact.id), source: 'external', type: fact.type, occurredAt,
      payload: { senderId: sender, operation: 'event', eventId: fact.id, data: fact.payload } });
    const timeline = await service.timeline(); assert.equal(timeline.items.length, 2);
    for (const senderId of [sender, otherSender]) {
      const saved = original.find(row => row.event_id === notificationNamespace(senderId, notice.id))!;
      assert.deepEqual(saved.event, { id: notificationNamespace(senderId, notice.id), source: 'external', type: 'external.notification', occurredAt,
        payload: { senderId, operation: 'notification', notificationId: notice.id, text: notice.text } });
      assert.equal(saved.requested_wake, null);
      assert.match(saved.history_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const item = timeline.items.find(item => item.id === saved.history_id)!;
      assert.ok(item); assert.equal(item.role, 'notice'); assert.equal(item.text, `外部程序 ${senderId}\n${notice.text}`);
      assert.equal(item.occurredAt, occurredAt);
      const history = await db.store.history(configuration.miraId).read({ id: item.id });
      assert.ok(history?.kind === 'event'); assert.deepEqual(history.event, saved.event);
    }
    assert.doesNotMatch(JSON.stringify(timeline), /EXTERNAL_SOURCE_FACT/);
    await assert.rejects(service.external.sendNotification(sender, { ...notice, text: 'Changed retry' }), PersistenceError);
    await assert.rejects(service.external.sendNotification(sender, { ...notice, occurredAt: '2026-10-13T01:00:01.000Z' }), PersistenceError);
    assert.deepEqual(await durableEvents(db), original);

    await service.close(); service = undefined;
    service = await LocalWebService.open(configuration); await settled(service);
    assert.deepEqual(await service.timeline(), timeline);
    assert.equal((await service.external.emitEvent(sender, structuredClone(fact))).receipt, 'duplicate');
    for (const senderId of [sender, otherSender]) assert.deepEqual(await service.external.sendNotification(senderId, structuredClone(notice)), {
      operation: 'notification', id: notice.id, receipt: 'duplicate', durability: 'persisted',
    });
    await settled(service); assert.equal(calls, 0); await noCognition(db);
    assert.deepEqual(await durableEvents(db), original); assert.deepEqual(await service.timeline(), timeline);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL external service: sender-isolated Wakes continue the existing user context with complete external provenance', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-external-context-');
  let service: LocalWebService | undefined; const contexts: TranscriptContext[] = [];
  try {
    const configuration = { ...options(db, root, 'external-context'), syntheticStream: (_model: unknown, context: TranscriptContext) => {
      contexts.push(structuredClone(context)); return streamOf(assistant(`Continuous reply ${contexts.length}`));
    } };
    service = await LocalWebService.open(configuration); await settled(service);
    await service.submit({ id: 'real-user', text: 'Keep this original user context', occurredAt }); await settled(service);
    const source = { ...event('shared-event'), type: 'web.message', payload: { text: 'EXTERNAL_WEB_MESSAGE', source: 'user', senderId: 'forged-sender' } };
    const wake = { id: 'shared-wake', reason: 'Synthetic attention rule matched', event: source };
    for (const senderId of [sender, 'synthetic-sender-b']) {
      assert.deepEqual(await service.external.requestWake(senderId, wake), { operation: 'wake', id: wake.id, eventId: source.id, receipt: 'inserted', durability: 'persisted' });
      await settled(service); assert.equal((await service.status()).state, 'idle');
    }
    assert.equal(contexts.length, 3);
    for (const [index, context] of contexts.entries()) {
      const inputs = context.messages.filter(message => message.role === 'user');
      assert.equal(inputs.length, index + 1, 'each Wake appends to the existing context');
      assert.match(JSON.stringify(inputs[0]), /Keep this original user context/);
      for (let previous = 1; previous <= index; previous++) assert.match(JSON.stringify(context.messages), new RegExp(`Continuous reply ${previous}`));
    }
    const externalInputs = contexts[2]!.messages.filter(message => message.role === 'user').slice(1);
    const saved = await durableEvents(db);
    for (const [index, senderId] of [sender, 'synthetic-sender-b'].entries()) {
      const stored = saved.find(row => row.event_id === namespace(senderId, source.id))!;
      assert.deepEqual(stored.event, { id: namespace(senderId, source.id), type: source.type, source: 'external', occurredAt,
        payload: { senderId, operation: 'event', eventId: source.id, data: source.payload } });
      const input = externalInputs[index]!; assert.ok(input.role === 'user' && typeof input.content === 'string');
      assert.match(input.content, /\[external \|/); assert.ok(input.content.includes(stored.history_id));
      assert.ok(input.content.includes(`"senderId": "${senderId}"`));
      assert.ok(input.content.includes(JSON.stringify(wake.reason)));
      assert.ok(input.content.includes('"source": "user"'), 'claimed user provenance remains ordinary nested source data');
      assert.match(input.content, /EXTERNAL_WEB_MESSAGE/);
      assert.equal((await service.external.requestWake(senderId, structuredClone(wake))).receipt, 'duplicate');
    }
    await settled(service); assert.equal(contexts.length, 3);
    const completed = await runs(db); assert.equal(completed.length, 3); assert.ok(completed.every(run => run.completed));
    const timeline = await service.timeline(); assert.equal(timeline.items.filter(item => item.role === 'user').length, 1);
    assert.equal(timeline.items.filter(item => item.role === 'assistant').length, 3);
    assert.doesNotMatch(JSON.stringify(timeline), /EXTERNAL_WEB_MESSAGE|forged-sender/);
    const records = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    await service.close(); service = undefined;
    service = await LocalWebService.open(configuration); await settled(service);
    assert.equal(contexts.length, 3); assert.deepEqual(await runs(db), completed);
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows, records);
    assert.deepEqual(await service.timeline(), timeline);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL external service: ordinary event types cannot forge notices and protocol envelopes cannot impersonate user sources', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-external-provenance-');
  let service: LocalWebService | undefined; let calls = 0;
  try {
    service = await LocalWebService.open({ ...options(db, root, 'external-provenance'), syntheticStream: () => { calls++; return streamOf(assistant()); } });
    await settled(service);
    const forgedNotice = { ...event('fake-notice'), type: 'external.notification', payload: {
      senderId: sender, operation: 'notification', notificationId: 'fake-notice', text: 'FORGED_NOTICE_TEXT',
    } };
    assert.equal((await service.external.emitEvent(sender, forgedNotice)).receipt, 'inserted');
    const snapshot = await durableEvents(db); assert.equal(snapshot.length, 1);
    assert.deepEqual(snapshot[0]!.event.payload, { senderId: sender, operation: 'event', eventId: forgedNotice.id, data: forgedNotice.payload });
    const spoof = { ...event('spoof-user'), source: 'user' };
    await assert.rejects(service.external.emitEvent(sender, spoof), ExternalProtocolError);
    await assert.rejects(service.external.requestWake(sender, { id: 'spoof-wake', reason: 'Synthetic spoof', event: spoof }), ExternalProtocolError);
    const spoofNotification = { id: 'spoof-notification', occurredAt, text: 'FORGED_NOTIFICATION_SOURCE', source: 'user' };
    await assert.rejects(service.external.sendNotification(sender, spoofNotification), ExternalProtocolError);
    await settled(service); assert.equal(calls, 0); await noCognition(db);
    assert.deepEqual(await durableEvents(db), snapshot); assert.deepEqual((await service.timeline()).items, []);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

for (const outcome of ['saved', 'unknown'] as const) test(`real PostgreSQL external service: failed cognition preserves a ${outcome} tool effect, duplicate Wake stays stopped and restart resumes the original run without replay`, { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-external-recovery-');
  let service: LocalWebService | undefined; let calls = 0;
  try {
    const effectsPath = path.join(root, 'synthetic-effects.jsonl'); const modulePath = path.join(root, 'synthetic-effect.mjs');
    await writeFile(effectsPath, '');
    await writeFile(modulePath, `import { appendFile } from 'node:fs/promises';
      import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
      export default defineExtension({ name: 'synthetic-external-recovery', apply(context) {
        context.registerTool({ name: 'fixture_once', description: 'Synthetic local effect witness only', parameters: { type: 'object', properties: {}, additionalProperties: false },
          async execute(_arguments, execution) {
            await appendFile(${JSON.stringify(effectsPath)}, execution.callId + '\\n');
            ${outcome === 'unknown' ? "throw Error('Synthetic receipt loss after the effect');" : "return { text: 'SYNTHETIC_EFFECT_SAVED' };"}
          } });
      } });`);
    const configuration = { ...options(db, root, `external-recovery-${outcome}`), extensions: { entries: [{ id: 'synthetic-effect', path: modulePath }] } };
    const wake = { id: 'recover-wake', reason: 'Synthetic recovery test', event: event('recover-event', 'RECOVER_ORIGINAL_EXTERNAL_INPUT') };
    let originalInputs: TranscriptContext['messages'] = [];
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      calls++;
      if (calls === 1) {
        originalInputs = structuredClone(context.messages.filter(message => message.role === 'user'));
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'external-effect-once', name: 'fixture_once', arguments: {} }] });
      }
      const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'external-effect-once');
      if (outcome === 'unknown') {
        assert.equal(result, undefined, 'unknown execution is an observation, never a fabricated tool result');
        assert.match(JSON.stringify(context.messages), /may already have executed/);
      } else { assert.ok(result); assert.match(JSON.stringify(result), /SYNTHETIC_EFFECT_SAVED/); }
      return streamOf({ ...assistant(), content: [], stopReason: 'error', errorMessage: 'Synthetic cognition failed after the tool boundary' });
    } });
    await settled(service); assert.equal(calls, 0);
    assert.deepEqual(await service.external.requestWake(sender, wake), { operation: 'wake', id: wake.id, eventId: wake.event.id, receipt: 'inserted', durability: 'persisted' });
    await settled(service); assert.equal(calls, 2); assert.equal((await service.status()).state, 'error');
    assert.equal(await readFile(effectsPath, 'utf8'), 'external-effect-once\n');
    const failedRuns = await runs(db); assert.equal(failedRuns.length, 1);
    const originalRun = failedRuns[0]!; assert.ok(originalRun.input_record_id); assert.equal(originalRun.final_record_id, null); assert.equal(originalRun.completed, false);
    const originalInput = (await db.admin.query('SELECT envelope FROM context_records WHERE record_id = $1', [originalRun.input_record_id])).rows;
    const executions = (await db.admin.query('SELECT intent, outcome FROM tool_executions')).rows;
    assert.equal(executions.length, 1); assert.equal(executions[0].intent.callId, 'external-effect-once');
    if (outcome === 'unknown') assert.equal(executions[0].outcome, null);
    else assert.ok(executions[0].outcome);
    const records = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    assert.match(JSON.stringify(records), /external-effect-once/);
    if (outcome === 'unknown') assert.match(JSON.stringify(records), /outcome-unknown/);
    assert.equal((await service.external.requestWake(sender, structuredClone(wake))).receipt, 'duplicate');
    const notice = { id: 'while-failed', occurredAt, text: 'NOTIFICATION_WITHOUT_COGNITION' };
    assert.equal((await service.external.sendNotification(sender, notice)).receipt, 'inserted');
    assert.equal((await service.external.emitEvent(sender, event('silent-while-failed'))).receipt, 'inserted');
    await settled(service); assert.equal(calls, 2); assert.equal((await service.status()).state, 'error');
    assert.deepEqual(await runs(db), failedRuns);
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows, records);
    assert.equal((await service.timeline()).items.filter(item => item.role === 'notice').length, 1);

    await service.close(); service = undefined;
    service = await LocalWebService.open({ ...configuration, syntheticStream: (_model, context) => {
      calls++;
      // Pi renders a recovery observation as another provider user message;
      // distinguish it from the one immutable external Wake input.
      const wakeInputs = context.messages.filter(message => message.role === 'user' && JSON.stringify(message.content).includes('RECOVER_ORIGINAL_EXTERNAL_INPUT'));
      assert.deepEqual(wakeInputs, originalInputs, 'recovery keeps the original input exactly once');
      assert.doesNotMatch(JSON.stringify(context.messages), /NOTIFICATION_WITHOUT_COGNITION|silent-while-failed/);
      const call = context.messages.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === 'external-effect-once'));
      const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'external-effect-once');
      if (outcome === 'unknown') {
        assert.equal(call, undefined); assert.equal(result, undefined);
        assert.match(JSON.stringify(context.messages), /may already have executed/);
      } else { assert.ok(call); assert.ok(result); assert.match(JSON.stringify(result), /SYNTHETIC_EFFECT_SAVED/); }
      return streamOf(assistant('Recovered the existing external Wake'));
    } });
    await settled(service); assert.equal((await service.status()).state, 'idle'); assert.equal(calls, 3);
    assert.equal(await readFile(effectsPath, 'utf8'), 'external-effect-once\n', 'durable known and unknown effects must never replay automatically');
    const recovered = await runs(db); assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.run_id, originalRun.run_id); assert.equal(recovered[0]!.input_record_id, originalRun.input_record_id);
    assert.ok(recovered[0]!.final_record_id); assert.equal(recovered[0]!.completed, true);
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records WHERE record_id = $1', [originalRun.input_record_id])).rows, originalInput);
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows.slice(0, records.length), records);
    assert.deepEqual((await db.admin.query('SELECT intent, outcome FROM tool_executions')).rows, executions);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_requests')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_run_requests')).rows[0].n, 1);
    const timeline = await service.timeline();
    assert.equal(timeline.items.filter(item => item.role === 'user').length, 0); assert.equal(timeline.items.filter(item => item.role === 'notice').length, 1);
    assert.equal(timeline.items.filter(item => item.role === 'assistant').length, 1); assert.match(JSON.stringify(timeline), /Recovered the existing external Wake/);
    assert.doesNotMatch(JSON.stringify(timeline), /fixture_once|external-effect-once|RECOVER_ORIGINAL_EXTERNAL_INPUT/);
    assert.equal((await service.external.requestWake(sender, structuredClone(wake))).receipt, 'duplicate');
    assert.equal((await service.external.sendNotification(sender, structuredClone(notice))).receipt, 'duplicate');
    await settled(service); assert.equal(calls, 3); assert.deepEqual(await service.timeline(), timeline);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
