import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { AgentToolCall } from '@earendil-works/pi-agent-core';
import { getCurrentTools, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import type { LifeEvent, RecoverySnapshot, ToolExecution } from '@mira/life';
import { decodeRecords } from '@mira/runtime-pi';
import { extensionReceiver, runDemo } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';
import { createExtensionFixture, fixtureParameters } from './extension-fixtures.mts';

const event = (id: string): LifeEvent => ({ id, type: 'synthetic.user-message', source: 'user', occurredAt: '2026-10-05T08:00:00.000Z', payload: { text: `Synthetic extension request ${id}` } });
const request = (id: string, name: string, args: AgentToolCall['arguments']) => ({ type: 'toolCall' as const, id, name, arguments: args });
const calls = (...content: AssistantMessage['content']): AssistantMessage => ({ ...assistant(), stopReason: 'toolUse', content });
const builtinNames = ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'history.search', 'history.read', 'extension.inspect', 'extension.manage'];

function messages(snapshot: RecoverySnapshot) {
  return decodeRecords(snapshot.records).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
}
function assertExactOutcomes(snapshot: RecoverySnapshot): void {
  const transcript = messages(snapshot);
  for (const execution of snapshot.executions) {
    assert.ok(execution.outcome);
    const message = transcript.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
    assert.ok(message?.role === 'toolResult');
    assert.deepEqual(execution.outcome.payload, message);
    assert.equal(execution.outcome.occurredAt, new Date(message.timestamp).toISOString());
  }
}
async function assertDurableDeclarations(db: Awaited<ReturnType<typeof createTestDatabase>>, miraId: string, context: TranscriptContext): Promise<void> {
  const rows = await db.admin.query('SELECT envelope FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId]);
  const stored = decodeRecords(rows.rows.map(row => row.envelope)).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  assert.deepEqual(getCurrentTools(stored), getCurrentTools(context.messages), 'real PostgreSQL declarations precede the provider request');
  assert.deepEqual(getCurrentTools(context.messages).filter(tool => tool.name !== 'fixture.echo').map(tool => tool.name), builtinNames);
}

test('real PostgreSQL server enables and invokes a manual extension in one Wake, then restores exact history against the current registry', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture();
  const miraId = 'manual-extension'; let requests = 0; let oldDescription = '';
  const options = { connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(fixture.root, 'spool'), workingDirectory: fixture.root };
  try {
    const first = await runDemo({ ...options,
      extensions: { entries: [{ id: 'manual', path: fixture.modulePath, enabled: false, config: fixture.config }] },
      events: [{ event: event('enable'), wake: { id: 'wake-enable', reason: 'Enable and use the configured synthetic extension' } }],
      streamFn: async (_model, context) => {
        requests++; await assertDurableDeclarations(db, miraId, context);
        const tool = getCurrentTools(context.messages).find(tool => tool.name === 'fixture.echo');
        if (requests === 1) {
          assert.equal(tool, undefined);
          return streamOf(calls(request('enable-manual', 'extension.manage', { id: 'manual', action: 'enable' }), request('builtin-ls', 'ls', { path: fixture.root })));
        }
        assert.ok(tool); assert.deepEqual(tool.parameters, fixtureParameters);
        oldDescription = tool.description;
        assert.match(oldDescription, /Extension "manual", activation /);
        const results = context.messages.filter(message => message.role === 'toolResult');
        assert.ok(results.some(message => message.toolCallId === 'enable-manual'));
        assert.ok(results.some(message => message.toolCallId === 'builtin-ls' && !message.isError));
        if (requests === 2) return streamOf(calls(request('extension-effect', 'fixture.echo', { count: '7', label: 'synthetic' })));
        assert.equal(requests, 3);
        assert.match(JSON.stringify(results), /Synthetic extension result/);
        return streamOf(assistant('Completed the synthetic extension request in this Wake'));
      },
    });
    assert.equal(first.completedRuns, 1); assert.equal(first.modelCalls, 3);
    assert.deepEqual(await fixture.effects(), [{ extensionId: 'manual', revision: 1, callId: 'extension-effect', arguments: { count: 7, label: 'synthetic' } }]);
    const reader = await db.acquire(miraId); const saved = await reader.load(); await reader.close();
    assertExactOutcomes(saved);
    assert.deepEqual(saved.executions.map(execution => execution.intent.callId), ['enable-manual', 'builtin-ls', 'extension-effect']);
    assert.ok(saved.executions.every(execution => JSON.stringify(execution.intent.authorization) === JSON.stringify({ source: 'synthetic-demo', intent: 'execute the explicitly configured synthetic demo tool calls' })));
    const execution = saved.executions.find(execution => execution.intent.callId === 'extension-effect')!;
    assert.deepEqual(execution.intent.requestedArguments, { count: '7', label: 'synthetic' });
    assert.deepEqual(execution.intent.arguments, { count: 7, label: 'synthetic' });
    const rawExecutions = await db.admin.query<{ intent: ToolExecution['intent']; outcome: ToolExecution['outcome'] }>('SELECT intent, outcome FROM tool_executions WHERE mira_id = $1 ORDER BY context_version', [miraId]);
    assert.deepEqual(rawExecutions.rows, saved.executions);
    const firstRuns = await db.admin.query('SELECT completed, input_record_id, final_record_id FROM wake_runs WHERE mira_id = $1', [miraId]);
    assert.equal(firstRuns.rows.length, 1); assert.equal(firstRuns.rows[0].completed, true);
    assert.ok(firstRuns.rows[0].input_record_id); assert.ok(firstRuns.rows[0].final_record_id);

    // Starting a current registry without a Wake neither rewrites declaration
    // history nor replays the old management or extension operation.
    const current = { entries: [{ id: 'manual', path: fixture.modulePath, config: { ...fixture.config, revision: 2 } }] };
    const quiet = await runDemo({ ...options, extensions: current, events: [], streamFn: () => { throw Error('No Wake must remain asleep'); } });
    assert.equal(quiet.modelCalls, 0); assert.equal(quiet.version, saved.version);
    assert.equal((await fixture.effects()).length, 1);
    let restartRequests = 0;
    const continued = await runDemo({ ...options, extensions: current,
      events: [{ event: event('continue'), wake: { id: 'wake-continue', reason: 'Continue the same Mira after restart' } }],
      streamFn: async (_model, context) => {
        restartRequests++; await assertDurableDeclarations(db, miraId, context);
        assert.match(JSON.stringify(context.messages), /Completed the synthetic extension request in this Wake/);
        const tool = getCurrentTools(context.messages).find(tool => tool.name === 'fixture.echo'); assert.ok(tool);
        assert.deepEqual(tool.parameters, fixtureParameters);
        assert.notEqual(tool.description, oldDescription); assert.match(tool.description, /revision 2/);
        assert.match(tool.description, /Extension "manual", activation /);
        if (restartRequests === 1) return streamOf(calls(request('current-effect', 'fixture.echo', { count: 4, label: 'synthetic' })));
        assert.equal(restartRequests, 2); return streamOf(assistant('Current extension result recorded'));
      },
    });
    assert.equal(continued.completedRuns, 1); assert.equal(continued.modelCalls, 2); assert.equal(continued.miraId, first.miraId);
    const replacement = await db.acquire(miraId); const after = await replacement.load(); await replacement.close();
    assert.deepEqual(after.records.slice(0, saved.records.length), saved.records);
    assert.deepEqual(after.executions.slice(0, saved.executions.length), saved.executions);
    assertExactOutcomes(after);
    assert.deepEqual((await fixture.effects()).map(effect => [effect.callId, effect.revision]), [['extension-effect', 1], ['current-effect', 2]]);
    const deltas = decodeRecords(after.records.slice(saved.records.length), saved.records.at(-1)!.id)
      .flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
    assert.equal(deltas.length, 1); assert.deepEqual(deltas[0]!.toolsRemoved, [{ name: 'fixture.echo' }]);
    assert.equal(deltas[0]!.toolsAdded?.length, 1); assert.match(deltas[0]!.toolsAdded![0]!.description, /revision 2/);
  } finally { await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('real PostgreSQL extension events bind configured identity, stay asleep, and deduplicate coalesced Wake receipts across restarts', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture(); const miraId = 'extension-receipts';
  const synthetic = (id: string) => ({ id, type: 'fixture.observation', occurredAt: '2026-10-05T08:00:00.000Z',
    source: 'user', extensionId: 'spoofed-identity', payload: { text: id, extensionId: 'payload-claim', source: 'user' } });
  const silent = synthetic('same-silent-id');
  const wakeItems = ['one', 'two'].map(id => ({ event: synthetic(`ready-${id}`), wake: { id: `same-wake-${id}`, reason: `Synthetic readiness ${id}` } }));
  const entries = (wake: boolean) => ['alpha', 'beta'].map(id => ({ id, path: fixture.modulePath,
    config: { ...fixture.config, toolName: `fixture.${id}`, startup: [{ event: silent }, ...(wake ? wakeItems : [])] } }));
  const options = { connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(fixture.root, 'spool'), events: [] };
  try {
    for (let restart = 0; restart < 2; restart++) {
      const quiet = await runDemo({ ...options, extensions: { entries: entries(false) }, streamFn: () => { throw Error('emitEvent must not call the model'); } });
      assert.equal(quiet.modelCalls, 0); assert.equal(quiet.completedRuns, 0); assert.equal(quiet.version, 0);
    }
    const quietEvents = await db.admin.query<{ event_id: string; event: LifeEvent; requested_wake: unknown }>('SELECT event_id, event, requested_wake FROM life_events ORDER BY event_id');
    assert.equal(quietEvents.rows.length, 2);
    for (const id of ['alpha', 'beta']) {
      const row = quietEvents.rows.find(row => row.event_id === JSON.stringify(['extension', id, silent.id])); assert.ok(row);
      assert.equal(row.event.source, 'extension'); assert.equal(row.requested_wake, null);
      assert.deepEqual(row.event.payload, { extensionId: id, eventId: silent.id, data: silent.payload });
    }
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_requests')).rows[0].n, 0);
    assert.deepEqual((await fixture.receipts()).map(receipt => receipt.receipt), ['inserted', 'inserted', 'duplicate', 'duplicate']);

    const woken = await runDemo({ ...options, extensions: { entries: entries(true) }, streamFn: (_model, context) => {
      const user = context.messages.filter(message => message.role === 'user'); assert.equal(user.length, 1);
      for (const id of ['alpha', 'beta', 'ready-one', 'ready-two']) assert.match(JSON.stringify(user[0]), new RegExp(id));
      return streamOf(assistant('Handled four coalesced extension receipts'));
    } });
    assert.equal(woken.completedRuns, 1); assert.equal(woken.modelCalls, 1);
    const duplicate = await runDemo({ ...options, extensions: { entries: entries(true) }, streamFn: () => { throw Error('Restart must not wake for duplicate extension receipts'); } });
    assert.equal(duplicate.completedRuns, 0); assert.equal(duplicate.modelCalls, 0); assert.equal(duplicate.version, woken.version);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, 6);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_requests')).rows[0].n, 4);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_run_requests')).rows[0].n, 4);
    assert.deepEqual((await fixture.receipts()).slice(-6).map(receipt => receipt.receipt), Array(6).fill('duplicate'));

    const writer = await db.acquire(miraId); const receive = extensionReceiver(writer);
    assert.equal(await receive('alpha', silent), 'duplicate');
    await assert.rejects(receive('alpha', { ...silent, payload: { text: 'changed' } }), /Event ID was reused/);
    await assert.rejects(receive('alpha', silent, { id: 'late-upgrade', reason: 'Must not upgrade an existing event-only receipt' }), /Event ID was reused/);
    await assert.rejects(receive('alpha', synthetic('rolled-back-new-event'), wakeItems[0]!.wake), /Wake ID already belongs to another event/);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n, 6, 'conflicting Wake rolls its event insertion back');
    assert.equal(await writer.claimWakeBatch(), null); await writer.close();
  } finally { await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('real PostgreSQL extension Wake requests during a tool batch queue for the next coalesced run', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture(); let requests = 0;
  try {
    const queued = ['a', 'b'].map(id => ({ event: { id: `queued-${id}`, type: 'fixture.followup', occurredAt: '2026-10-05T08:01:00.000Z', payload: { text: `Queued extension ${id}` } }, wake: { id: `queued-wake-${id}`, reason: 'Synthetic extension followup' } }));
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'queued-extension', sourceDirectory: process.cwd(), spoolDirectory: path.join(fixture.root, 'spool'),
      extensions: { entries: [{ id: 'manual', path: fixture.modulePath, config: { ...fixture.config, wakeOnExecute: queued } }] } };
    const completed = await runDemo({ ...options, events: [{ event: event('start'), wake: { id: 'wake-start', reason: 'Use synthetic extension' } }],
      streamFn: (_model, context) => {
        requests++;
        if (requests === 1) return streamOf(calls(request('queue-during-effect', 'fixture.echo', { count: 1, label: 'synthetic' })));
        const inputs = context.messages.filter(message => message.role === 'user');
        if (requests === 2) {
          assert.equal(inputs.length, 1); assert.doesNotMatch(JSON.stringify(inputs), /Queued extension/);
          return streamOf(assistant('Original Wake complete'));
        }
        assert.equal(requests, 3); assert.equal(inputs.length, 2);
        assert.match(JSON.stringify(inputs[1]), /Queued extension a/); assert.match(JSON.stringify(inputs[1]), /Queued extension b/);
        assert.match(JSON.stringify(context.messages), /Original Wake complete/);
        return streamOf(assistant('Queued extensions handled together'));
      },
    });
    assert.equal(completed.completedRuns, 2); assert.equal(completed.modelCalls, 3);
    const runSizes = await db.admin.query('SELECT count(*)::int AS n FROM wake_run_requests GROUP BY run_id ORDER BY n');
    assert.deepEqual(runSizes.rows.map(row => row.n), [1, 2]);
    assert.equal((await fixture.effects()).length, 1);
    const restarted = await runDemo({ ...options, events: [], streamFn: () => { throw Error('Completed queue must remain drained after restart'); } });
    assert.equal(restarted.completedRuns, 0); assert.equal(restarted.version, completed.version);
  } finally { await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
