import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { AgentToolCall } from '@earendil-works/pi-agent-core';
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { ArtifactStore, readExtensionConfiguration, type ChangeStatus, type ExtensionStatus } from '@mira/extension-host';
import type { LifeEvent, RecoverySnapshot, ToolExecution } from '@mira/life';
import { decodeRecords } from '@mira/runtime-pi';
import { extensionReceiver, runDemo } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';
import { createExtensionFixture, fixtureParameters } from './extension-fixtures.mts';

const event = (id: string): LifeEvent => ({ id, type: 'synthetic.user-message', source: 'user', occurredAt: '2026-10-05T08:00:00.000Z', payload: { text: `Synthetic extension request ${id}` } });
const request = (id: string, name: string, args: AgentToolCall['arguments']) => ({ type: 'toolCall' as const, id, name, arguments: args });
const calls = (...content: AssistantMessage['content']): AssistantMessage => ({ ...assistant(), stopReason: 'toolUse', content });
const builtinNames = ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'history.search', 'history.read', 'extension.inspect', 'extension.stage', 'extension.manage'];

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
  assert.equal(getCurrentSystemPrompt(stored), getCurrentSystemPrompt(context.messages), 'the same current Prompt is durable before the provider request');
  assert.deepEqual(getCurrentTools(context.messages).filter(tool => tool.name !== 'fixture.echo').map(tool => tool.name), builtinNames);
}

interface Inspection { extensions: ExtensionStatus[]; changes: ChangeStatus[]; diagnostics: string[] }
function toolResult<T>(context: TranscriptContext, callId: string): T {
  const message = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === callId);
  assert.ok(message?.role === 'toolResult' && !message.isError && message.content[0]?.type === 'text');
  return JSON.parse(message.content[0].text) as T;
}
function assertCapability(context: TranscriptContext, revision: number | null, parameters = fixtureParameters): string {
  const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'fixture.echo');
  const prompt = getCurrentSystemPrompt(context.messages);
  if (revision === null) {
    assert.equal(declaration, undefined); assert.doesNotMatch(prompt, /Synthetic echo revision|fixture\.echo/); return '';
  }
  assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters);
  assert.match(declaration.description, new RegExp(`Synthetic echo revision ${revision}\\n`));
  assert.ok(prompt.includes(declaration.description), 'Prompt guidance and executable declaration use the same activation');
  return declaration.description;
}
async function assertStoredChain(db: Awaited<ReturnType<typeof createTestDatabase>>, miraId: string): Promise<RecoverySnapshot> {
  const writer = await db.acquire(miraId); const snapshot = await writer.load(); await writer.close();
  assertExactOutcomes(snapshot);
  const rows = await db.admin.query<{ intent: ToolExecution['intent']; outcome: ToolExecution['outcome'] }>('SELECT intent, outcome FROM tool_executions WHERE mira_id = $1 ORDER BY context_version', [miraId]);
  assert.deepEqual(rows.rows, snapshot.executions);
  for (const execution of snapshot.executions) {
    assert.equal('authorization' in execution.intent, false);
    const source = decodeRecords(snapshot.records).find(entry => entry.id === execution.intent.assistantRecordId);
    assert.ok(source?.type === 'message' && source.message.role === 'assistant');
    const call = source.message.content.find(block => block.type === 'toolCall' && block.id === execution.intent.callId);
    assert.ok(call?.type === 'toolCall'); assert.equal(call.name, execution.intent.toolName);
    assert.deepEqual(call.arguments, execution.intent.requestedArguments, 'intent retains the exact assistant request');
  }
  return snapshot;
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
    assert.ok(saved.executions.every(execution => !('authorization' in execution.intent)));
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
      .flatMap(entry => entry.type === 'message' && entry.message.role === 'system' && (entry.message.toolsAdded || entry.message.toolsRemoved) ? [entry.message] : []);
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

test('real PostgreSQL model configure, reload and remove preserve batch resources, saved config and immutable receipts across restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture(); const miraId = 'managed-extension';
  const configurationFile = path.join(fixture.root, 'extensions.json');
  const initialConfig = { ...fixture.config, lifecyclePath: fixture.lifecyclePath, configurationFile, revision: 1 };
  const updatedParameters = { ...fixtureParameters, properties: { ...fixtureParameters.properties, count: { type: 'number', minimum: 2 } } };
  const updatedConfig = { ...initialConfig, revision: 2, parameters: updatedParameters };
  const initialEntry = { id: 'manual', path: fixture.modulePath, enabled: true, config: initialConfig };
  const updatedEntry = { ...initialEntry, config: updatedConfig };
  const metadata = { comment: 'Synthetic owner metadata survives management' };
  const options = { connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(fixture.root, 'spool'), workingDirectory: fixture.root };
  const accepted = new Map<string, ChangeStatus>();
  let requests = 0; let originalDescription = ''; let configuredDescription = ''; let reloadedDescription = ''; let configuredBytes = ''; let checkedEffects = 0;
  const remember = (context: TranscriptContext, callId: string, action: ChangeStatus['action'], persistence: ChangeStatus['persistence']): ChangeStatus => {
    const result = toolResult<ChangeStatus>(context, callId);
    assert.match(result.id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(result, { id: result.id, extensionId: 'manual', action, status: 'accepted', persistence });
    accepted.set(callId, structuredClone(result)); return result;
  };
  const assertAccepted = (context: TranscriptContext) => {
    for (const [callId, receipt] of accepted) assert.deepEqual(toolResult(context, callId), receipt, 'applied state never rewrites the accepted tool result');
  };
  try {
    await writeFile(configurationFile, JSON.stringify({ entries: [initialEntry], ...metadata }));
    const sourceBytes = await readFile(fixture.modulePath, 'utf8');
    // An optional fixture observer reads through a separate real-PG connection at
    // the effect boundary. The extension still runs through the full server path.
    await fixture.observeEffects(async effect => {
      checkedEffects++;
      const rows = await db.admin.query<{ intent: ToolExecution['intent']; outcome: ToolExecution['outcome']; context_version: number }>(
        'SELECT intent, outcome, context_version::int AS context_version FROM tool_executions WHERE mira_id = $1 AND call_id = $2', [miraId, effect.callId]);
      assert.equal(rows.rows.length, 1); const row = rows.rows[0]!;
      assert.equal(row.outcome, null, 'durable intent exists before the fixture effect, without a manufactured outcome');
      assert.deepEqual(row.intent.arguments, effect.arguments); assert.equal(row.intent.toolName, 'fixture.echo');
      const records = await db.admin.query('SELECT envelope FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId]);
      const stored = decodeRecords(records.rows.map(item => item.envelope));
      const source = stored.find(entry => entry.id === row.intent.assistantRecordId);
      assert.ok(source?.type === 'message' && source.message.role === 'assistant');
      const call = source.message.content.find(block => block.type === 'toolCall' && block.id === effect.callId);
      assert.ok(call?.type === 'toolCall'); assert.deepEqual(call.arguments, row.intent.requestedArguments);
      assert.equal(records.rows.length, row.context_version, 'intent refers to the current durable boundary');
      assert.equal(stored.some(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === effect.callId), false);
    });
    const first = await runDemo({ ...options, extensions: await readExtensionConfiguration(configurationFile),
      events: [{ event: event('configure'), wake: { id: 'wake-configure', reason: 'Configure and reload this synthetic extension' } }],
      streamFn: async (_model, context) => {
        requests++; await assertDurableDeclarations(db, miraId, context); assertAccepted(context);
        if (requests === 1) {
          originalDescription = assertCapability(context, 1);
          assert.deepEqual((await fixture.lifecycle()).map(item => [item.phase, item.saved]), [['apply', initialEntry]]);
          return streamOf(calls(request('configure-manual', 'extension.manage', { id: 'manual', action: 'configure', config: updatedConfig }),
            request('configure-sibling', 'fixture.echo', { count: '7', label: 'synthetic' }), request('inspect-configure-queued', 'extension.inspect', {})));
        }
        if (requests === 2) {
          configuredDescription = assertCapability(context, 2, updatedParameters);
          assert.notEqual(configuredDescription, originalDescription); assert.ok(!getCurrentSystemPrompt(context.messages).includes(originalDescription));
          const receipt = remember(context, 'configure-manual', 'configure', 'pending');
          const queued = toolResult<Inspection>(context, 'inspect-configure-queued');
          assert.deepEqual(queued.changes, [receipt]); assert.equal(queued.extensions[0]!.status, 'active');
          assert.deepEqual(queued.extensions[0]!.config, initialConfig); assert.ok(originalDescription.includes(queued.extensions[0]!.activation!));
          const lifecycle = await fixture.lifecycle();
          assert.deepEqual(lifecycle.map(item => [item.phase, item.revision]), [['apply', 1], ['execute', 1], ['cleanup', 1], ['apply', 2]]);
          assert.deepEqual(lifecycle[1]!.saved, initialEntry, 'queued configure does not replace config while its sibling is executing');
          assert.deepEqual(lifecycle[2]!.saved, updatedEntry, 'desired config is saved before old resource cleanup');
          assert.deepEqual(lifecycle[3]!.saved, updatedEntry, 'apply reads the actual new configuration file, not a later observation');
          configuredBytes = await readFile(configurationFile, 'utf8');
          return streamOf(calls(request('inspect-configure-applied', 'extension.inspect', {}), request('reload-manual', 'extension.manage', { id: 'manual', action: 'reload' }),
            request('reload-sibling', 'fixture.echo', { count: '8', label: 'synthetic' }), request('inspect-reload-queued', 'extension.inspect', {})));
        }
        if (requests === 3) {
          reloadedDescription = assertCapability(context, 2, updatedParameters);
          assert.notEqual(reloadedDescription, configuredDescription); assert.ok(!getCurrentSystemPrompt(context.messages).includes(configuredDescription));
          const configured = toolResult<Inspection>(context, 'inspect-configure-applied');
          assert.deepEqual(configured.changes, [{ ...accepted.get('configure-manual')!, status: 'applied', persistence: 'saved' }]);
          const receipt = remember(context, 'reload-manual', 'reload', 'not-required');
          const queued = toolResult<Inspection>(context, 'inspect-reload-queued');
          assert.deepEqual(queued.changes, [...configured.changes, receipt]);
          assert.ok(configuredDescription.includes(queued.extensions[0]!.activation!)); assert.deepEqual(queued.extensions[0]!.config, updatedConfig);
          assert.deepEqual((await fixture.lifecycle()).map(item => [item.phase, item.activation, item.revision]), [
            ['apply', 1, 1], ['execute', 1, 1], ['cleanup', 1, 1], ['apply', 2, 2], ['execute', 2, 2], ['cleanup', 2, 2], ['apply', 3, 2],
          ]);
          assert.equal(new Set((await fixture.lifecycle()).map(item => item.moduleId)).size, 1, 'manual reload reactivates the same imported module; this does not test source HMR');
          assert.equal(await readFile(configurationFile, 'utf8'), configuredBytes, 'reload does not rewrite the desired configuration');
          return streamOf(calls(request('inspect-reload-applied', 'extension.inspect', {}), request('reloaded-effect', 'fixture.echo', { count: '9', label: 'synthetic' })));
        }
        assert.equal(requests, 4); assert.equal(assertCapability(context, 2, updatedParameters), reloadedDescription);
        assert.deepEqual(toolResult<Inspection>(context, 'inspect-reload-applied').changes, [
          { ...accepted.get('configure-manual')!, status: 'applied', persistence: 'saved' }, { ...accepted.get('reload-manual')!, status: 'applied' },
        ]);
        return streamOf(assistant('Configured and reloaded the synthetic extension'));
      },
    });
    assert.equal(first.completedRuns, 1); assert.equal(first.modelCalls, 4);
    const saved = await assertStoredChain(db, miraId);
    assert.deepEqual(saved.executions.map(item => item.intent.callId), ['configure-manual', 'configure-sibling', 'inspect-configure-queued', 'inspect-configure-applied', 'reload-manual', 'reload-sibling', 'inspect-reload-queued', 'inspect-reload-applied', 'reloaded-effect']);
    for (const execution of saved.executions.filter(item => item.intent.toolName === 'fixture.echo')) {
      const count = (execution.intent.arguments as { count: number }).count;
      assert.deepEqual(execution.intent.requestedArguments, { count: String(count), label: 'synthetic' });
      assert.deepEqual(execution.intent.arguments, { count, label: 'synthetic' });
    }
    const quiet = await runDemo({ ...options, extensions: await readExtensionConfiguration(configurationFile), events: [], streamFn: () => { throw Error('Restart without Wake stays asleep'); } });
    assert.equal(quiet.version, saved.version); assert.equal(quiet.modelCalls, 0); assert.equal(quiet.completedRuns, 0);
    assert.equal((await fixture.effects()).length, 3); assert.equal(await readFile(configurationFile, 'utf8'), configuredBytes);
    assert.deepEqual((await fixture.lifecycle()).slice(-2).map(item => [item.phase, item.activation, item.saved]), [['apply', 4, updatedEntry], ['cleanup', 4, updatedEntry]]);

    let resumedRequests = 0;
    const continued = await runDemo({ ...options, extensions: await readExtensionConfiguration(configurationFile),
      events: [{ event: event('remove'), wake: { id: 'wake-remove', reason: 'Remove the saved synthetic extension' } }],
      streamFn: async (_model, context) => {
        resumedRequests++; await assertDurableDeclarations(db, miraId, context); assertAccepted(context);
        assert.match(JSON.stringify(context.messages), /Configured and reloaded the synthetic extension/);
        if (resumedRequests === 1) {
          assert.notEqual(assertCapability(context, 2, updatedParameters), reloadedDescription);
          return streamOf(calls(request('inspect-restarted', 'extension.inspect', {}), request('remove-manual', 'extension.manage', { id: 'manual', action: 'remove' }),
            request('remove-sibling', 'fixture.echo', { count: '10', label: 'synthetic' }), request('inspect-remove-queued', 'extension.inspect', {}),
            request('remove-missing', 'extension.manage', { id: 'missing', action: 'remove' })));
        }
        assertCapability(context, null);
        if (resumedRequests === 2) {
          const restarted = toolResult<Inspection>(context, 'inspect-restarted');
          assert.deepEqual(restarted.changes, [], 'restart loads saved state, without replaying prior management calls');
          assert.deepEqual(restarted.extensions[0]!.config, updatedConfig);
          const receipt = remember(context, 'remove-manual', 'remove', 'pending');
          const queued = toolResult<Inspection>(context, 'inspect-remove-queued');
          assert.deepEqual(queued.changes, [receipt]); assert.deepEqual(queued.extensions, restarted.extensions);
          assert.deepEqual(toolResult(context, 'remove-missing'), { status: 'rejected', error: 'Unknown configured extension: missing' });
          assert.deepEqual((await fixture.lifecycle()).slice(-2).map(item => [item.phase, item.activation, item.saved]), [['execute', 5, updatedEntry], ['cleanup', 5, null]]);
          assert.deepEqual(JSON.parse(await readFile(configurationFile, 'utf8')), { entries: [], ...metadata });
          return streamOf(calls(request('inspect-remove-applied', 'extension.inspect', {})));
        }
        assert.equal(resumedRequests, 3);
        const removed = toolResult<Inspection>(context, 'inspect-remove-applied');
        assert.deepEqual(removed.extensions, []); assert.deepEqual(removed.diagnostics, []);
        assert.deepEqual(removed.changes, [{ ...accepted.get('remove-manual')!, status: 'applied', persistence: 'saved' }]);
        return streamOf(assistant('Removed the extension and reported the invalid target truthfully'));
      },
    });
    assert.equal(continued.completedRuns, 1); assert.equal(continued.modelCalls, 3);
    const after = await assertStoredChain(db, miraId);
    assert.deepEqual(after.records.slice(0, saved.records.length), saved.records); assert.deepEqual(after.executions.slice(0, saved.executions.length), saved.executions);
    assert.deepEqual(after.executions.slice(saved.executions.length).map(item => item.intent.callId), ['inspect-restarted', 'remove-manual', 'remove-sibling', 'inspect-remove-queued', 'remove-missing', 'inspect-remove-applied']);
    const effects = await fixture.effects(); assert.equal(checkedEffects, 4);
    assert.deepEqual(effects.map(item => [item.callId, item.revision, item.arguments]), [
      ['configure-sibling', 1, { count: 7, label: 'synthetic' }], ['reload-sibling', 2, { count: 8, label: 'synthetic' }],
      ['reloaded-effect', 2, { count: 9, label: 'synthetic' }], ['remove-sibling', 2, { count: 10, label: 'synthetic' }],
    ]);
    const lifecycle = await fixture.lifecycle();
    assert.deepEqual(lifecycle.filter(item => item.phase === 'cleanup').map(item => item.activation), [1, 2, 3, 4, 5], 'each retired activation cleans up exactly once');
    for (const witness of lifecycle.filter(item => item.phase === 'execute')) assert.deepEqual(witness.listeners, [witness.activation], 'retired event listeners are removed before the next activation executes');
    assert.equal(await readFile(fixture.modulePath, 'utf8'), sourceBytes, 'remove retains the manual source file');
    const removedRestart = await runDemo({ ...options, extensions: await readExtensionConfiguration(configurationFile), events: [], streamFn: () => { throw Error('Removed extension cannot create a Wake'); } });
    assert.equal(removedRestart.modelCalls, 0); assert.equal(removedRestart.version, after.version);
    assert.deepEqual(await fixture.lifecycle(), lifecycle); assert.deepEqual(await fixture.effects(), effects);
    const runs = await db.admin.query('SELECT completed FROM wake_runs WHERE mira_id = $1', [miraId]);
    assert.deepEqual(runs.rows, [{ completed: true }, { completed: true }]);
  } finally { await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('real PostgreSQL model removal retires a generated activation but retains source, release and activation files', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture(); const miraId = 'remove-generated-extension';
  const configurationFile = path.join(fixture.root, 'extensions.json'); const artifactsDirectory = path.join(fixture.root, 'artifacts');
  const sourceRoot = path.join(fixture.root, 'source'); const sourceFile = path.join(sourceRoot, 'fixture.mjs');
  const config = { ...fixture.config, lifecyclePath: fixture.lifecyclePath, configurationFile, revision: 1 };
  const options = { connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(fixture.root, 'spool'), workingDirectory: fixture.root };
  let requests = 0; let activationDirectories: string[] = [];
  const accepted = new Map<string, ChangeStatus>();
  try {
    await mkdir(sourceRoot); const sourceBytes = await readFile(fixture.modulePath, 'utf8'); await writeFile(sourceFile, sourceBytes);
    await writeFile(configurationFile, JSON.stringify({ entries: [], artifactsDirectory, comment: 'Retain the ordinary version files' }));
    const store = new ArtifactStore(artifactsDirectory); const release = await store.stage(sourceRoot, 'fixture.mjs');
    const completed = await runDemo({ ...options, extensions: await readExtensionConfiguration(configurationFile),
      events: [{ event: event('generated-remove'), wake: { id: 'wake-generated-remove', reason: 'Install, activate and remove a synthetic generated extension' } }],
      streamFn: async (_model, context) => {
        requests++; await assertDurableDeclarations(db, miraId, context);
        for (const [callId, receipt] of accepted) assert.deepEqual(toolResult(context, callId), receipt, 'later lifecycle changes never revise an accepted result');
        if (requests === 1) {
          assertCapability(context, null);
          return streamOf(calls(request('install-generated-removal', 'extension.manage', { id: 'generated', action: 'install', digest: release.digest, config })));
        }
        const previous = requests === 2 ? ['install-generated-removal', 'install'] : requests === 3 ? ['activate-generated-removal', 'activate'] : requests === 4 ? ['remove-generated', 'remove'] : null;
        if (previous) {
          const receipt = toolResult<ChangeStatus>(context, previous[0]!);
          assert.deepEqual(receipt, { id: receipt.id, extensionId: 'generated', action: previous[1], status: 'accepted', persistence: 'pending' });
          accepted.set(previous[0]!, structuredClone(receipt));
        }
        if (requests === 2) {
          assertCapability(context, null); assert.deepEqual(await fixture.lifecycle(), [], 'staging and disabled install never import or apply');
          const installed = (await readExtensionConfiguration(configurationFile)).entries[0]!;
          assert.equal(installed.enabled, false); assert.equal(installed.generated!.digest, release.digest); assert.deepEqual(installed.config, config);
          return streamOf(calls(request('activate-generated-removal', 'extension.manage', { id: 'generated', action: 'activate' })));
        }
        if (requests === 3) {
          assert.match(assertCapability(context, 1), new RegExp(release.digest));
          const current = (await readExtensionConfiguration(configurationFile)).entries[0]!;
          assert.equal(current.enabled, true); assert.deepEqual((await fixture.lifecycle())[0]!.saved, current, 'generated apply observes saved activation config');
          activationDirectories = await readdir(path.join(artifactsDirectory, 'activations')); assert.equal(activationDirectories.length, 1);
          return streamOf(calls(request('remove-generated', 'extension.manage', { id: 'generated', action: 'remove' }),
            request('generated-remove-sibling', 'fixture.echo', { count: '12', label: 'synthetic' }), request('inspect-generated-remove-queued', 'extension.inspect', {})));
        }
        assertCapability(context, null);
        if (requests === 4) {
          const queued = toolResult<Inspection>(context, 'inspect-generated-remove-queued');
          assert.equal(queued.extensions[0]!.status, 'active'); assert.equal(queued.extensions[0]!.generated!.digest, release.digest);
          assert.deepEqual(queued.changes.map(item => [item.action, item.status, item.persistence]), [['install', 'applied', 'saved'], ['activate', 'applied', 'saved'], ['remove', 'accepted', 'pending']]);
          assert.deepEqual(queued.changes.at(-1), accepted.get('remove-generated'));
          assert.deepEqual((await fixture.lifecycle()).map(item => item.phase), ['apply', 'execute', 'cleanup']);
          assert.equal((await fixture.lifecycle()).at(-1)!.saved, null, 'remove saves desired absence before resource cleanup');
          assert.deepEqual(JSON.parse(await readFile(configurationFile, 'utf8')), { entries: [], artifactsDirectory, comment: 'Retain the ordinary version files' });
          return streamOf(calls(request('inspect-generated-removed', 'extension.inspect', {})));
        }
        assert.equal(requests, 5);
        const inspected = toolResult<Inspection & { releases: Array<{ digest: string }> }>(context, 'inspect-generated-removed');
        assert.deepEqual(inspected.extensions, []); assert.deepEqual(inspected.diagnostics, []);
        assert.deepEqual(inspected.releases.map(item => item.digest), [release.digest]);
        assert.deepEqual(inspected.changes.at(-1), { ...accepted.get('remove-generated')!, status: 'applied', persistence: 'saved' });
        return streamOf(assistant('Generated extension removed while its ordinary files were retained'));
      },
    });
    assert.equal(completed.completedRuns, 1); assert.equal(completed.modelCalls, 5);
    const saved = await assertStoredChain(db, miraId);
    assert.deepEqual(saved.executions.map(item => item.intent.callId), ['install-generated-removal', 'activate-generated-removal', 'remove-generated', 'generated-remove-sibling', 'inspect-generated-remove-queued', 'inspect-generated-removed']);
    const effect = saved.executions.find(item => item.intent.callId === 'generated-remove-sibling')!;
    assert.deepEqual(effect.intent.requestedArguments, { count: '12', label: 'synthetic' }); assert.deepEqual(effect.intent.arguments, { count: 12, label: 'synthetic' });
    assert.deepEqual(await fixture.effects(), [{ extensionId: 'generated', revision: 1, callId: 'generated-remove-sibling', arguments: { count: 12, label: 'synthetic' } }]);
    const lifecycle = await fixture.lifecycle(); assert.deepEqual(lifecycle.map(item => [item.phase, item.activation]), [['apply', 1], ['execute', 1], ['cleanup', 1]]);
    assert.deepEqual(lifecycle[1]!.listeners, [1]);
    const retained = async () => {
      assert.equal(await readFile(sourceFile, 'utf8'), sourceBytes);
      assert.deepEqual(await store.read(release.digest), release); await store.verify(release);
      assert.equal(await readFile(release.entry, 'utf8'), sourceBytes);
      assert.deepEqual(await readdir(path.join(artifactsDirectory, 'activations')), activationDirectories);
      for (const directory of activationDirectories) assert.equal(await readFile(path.join(artifactsDirectory, 'activations', directory, 'workspace', 'fixture.mjs'), 'utf8'), sourceBytes);
    };
    await retained();
    const quiet = await runDemo({ ...options, extensions: await readExtensionConfiguration(configurationFile), events: [], streamFn: () => { throw Error('Removed generated version cannot replay a Wake'); } });
    assert.equal(quiet.modelCalls, 0); assert.equal(quiet.completedRuns, 0); assert.equal(quiet.version, saved.version);
    assert.deepEqual(await fixture.lifecycle(), lifecycle); assert.equal((await fixture.effects()).length, 1); await retained();
    assert.deepEqual(await assertStoredChain(db, miraId), saved, 'restart preserves exact current history and outcomes without replay');
  } finally { await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
