import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentTool, AgentToolCall } from '@earendil-works/pi-agent-core';
import { getCurrentTools, toToolDeclaration, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { ExtensionHost, readExtensionConfiguration, type ArtifactManifest, type Json } from '@mira/extension-host';
import { ArtifactStore } from '@mira/extension-host/artifacts';
import type { RecoverySnapshot, ToolExecution } from '@mira/life';
import { decodeRecords } from '@mira/runtime-pi';
import { extensionManagementTools, extensionReceiver, extensionTools, runDemo } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, overrideWriter, runtime, streamOf } from './fixtures.mts';

const parameters = {
  one: { type: 'object', properties: { count: { type: 'number', minimum: 1 } }, required: ['count'], additionalProperties: false },
  two: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
};
const request = (id: string, name: string, args: AgentToolCall['arguments']) => ({ type: 'toolCall' as const, id, name, arguments: args });
const calls = (...content: AssistantMessage['content']): AssistantMessage => ({ ...assistant(), stopReason: 'toolUse', content });
type Witness = { extensionId: string; version: string; label: string; callId: string; serial: number; arguments: Json };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-generated-recovery-'));
  const artifactsDirectory = path.join(root, 'artifacts');
  const configurationFile = path.join(root, 'extensions.json');
  const effectsPath = path.join(root, 'effects.jsonl');
  const lifecyclePath = path.join(root, 'lifecycle.jsonl');
  await writeFile(effectsPath, ''); await writeFile(lifecyclePath, '');
  await writeFile(configurationFile, JSON.stringify({ entries: [], artifactsDirectory }));
  const sources = { one: path.join(root, 'one'), two: path.join(root, 'two') };
  for (const version of ['one', 'two'] as const) {
    const source = sources[version];
    await mkdir(path.join(source, 'node_modules/@mira'), { recursive: true });
    await symlink(fileURLToPath(new URL('../../packages/extension-sdk/', import.meta.url)), path.join(source, 'node_modules/@mira/extension-sdk'));
    await writeFile(path.join(source, 'package.json'), '{"type":"module","private":true}');
    // Counter lives in a transitive module: a fresh entry URL alone cannot reset it.
    await writeFile(path.join(source, 'helper.mjs'), `export const version = ${JSON.stringify(version)}; export const parameters = ${JSON.stringify(parameters[version])}; let serial = 0; export const next = () => ++serial;`);
    await writeFile(path.join(source, 'entry.mjs'), `
import { appendFile } from 'node:fs/promises';
import { defineExtension } from '@mira/extension-sdk';
import { version, parameters, next } from './helper.mjs';
await appendFile(${JSON.stringify(lifecyclePath)}, JSON.stringify({ phase: 'import', version }) + '\\n');
export default defineExtension({ name: 'synthetic-generated', async apply(context, config) {
  await appendFile(config.lifecyclePath, JSON.stringify({ phase: 'apply', version, label: config.label }) + '\\n');
  context.registerTool({ name: 'generated_echo', description: 'Synthetic generated echo ' + version, parameters,
    async execute(args, execution) {
      execution.signal.throwIfAborted();
      const witness = { extensionId: context.id, version, label: config.label, callId: execution.callId, serial: next(), arguments: args };
      await appendFile(config.effectsPath, JSON.stringify(witness) + '\\n');
      return { text: 'Generated result ' + JSON.stringify(witness), details: witness };
    } });
} });
`);
  }
  return { root, sources, artifactsDirectory, configurationFile,
    config: (label: string) => ({ effectsPath, lifecyclePath, label }),
    effects: async (): Promise<Witness[]> => (await readFile(effectsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    lifecycle: async () => (await readFile(lifecyclePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { phase: string; version: string; label?: string }),
  };
}
function toolResult<T>(context: TranscriptContext, callId: string): T {
  const message = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === callId);
  assert.ok(message?.role === 'toolResult' && !message.isError && message.content[0]?.type === 'text');
  return JSON.parse(message.content[0].text) as T;
}
const event = (id: string) => ({ id, type: 'synthetic.generated-request', source: 'user' as const, occurredAt: '2026-10-05T08:00:00.000Z', payload: { text: `Synthetic generated lifecycle ${id}` } });
const builtinNames = ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash', 'history_search', 'history_read', 'extension_inspect', 'extension_stage', 'extension_manage'];
function messages(snapshot: RecoverySnapshot) {
  return decodeRecords(snapshot.records).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
}
function assertExactOutcomes(snapshot: RecoverySnapshot) {
  const transcript = messages(snapshot);
  for (const execution of snapshot.executions) {
    assert.ok(execution.outcome);
    const result = transcript.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
    assert.ok(result?.role === 'toolResult'); assert.deepEqual(execution.outcome.payload, result);
    assert.equal(execution.outcome.occurredAt, new Date(result.timestamp).toISOString());
    if (execution.intent.toolName === 'extension_manage') {
      assert.ok(result.content[0]?.type === 'text'); assert.equal(JSON.parse(result.content[0].text).status, 'applied');
    }
  }
}
function assertStaleOutcomes(snapshot: RecoverySnapshot, callIds: string[]) {
  for (const callId of callIds) {
    const execution = snapshot.executions.find(item => item.intent.callId === callId);
    assert.ok(execution?.outcome, 'stale dispatch is a known durable outcome');
    const result = messages(snapshot).find(message => message.role === 'toolResult' && message.toolCallId === callId);
    assert.ok(result?.role === 'toolResult' && result.isError);
    assert.deepEqual(result.details, {
      status: 'stale', executed: false, extensionId: 'generated',
      activation: (result.details as { activation: string }).activation, toolName: 'generated_echo',
    });
    assert.equal(typeof (result.details as { activation: unknown }).activation, 'string');
    assert.deepEqual(execution.outcome.payload, result);
  }
}
async function assertDurableDeclarations(db: Awaited<ReturnType<typeof createTestDatabase>>, miraId: string, context: TranscriptContext, prepared?: AgentTool[]) {
  const records = await db.admin.query('SELECT envelope FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId]);
  const stored = decodeRecords(records.rows.map(row => row.envelope)).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  const current = getCurrentTools(context.messages);
  assert.deepEqual(getCurrentTools(stored), current, 'real PostgreSQL commits exact declarations before the provider request');
  if (prepared) assert.deepEqual(current, prepared.map(toToolDeclaration), 'declarations match the actual executable registry');
  else assert.deepEqual(current.filter(tool => tool.name !== 'generated_echo').map(tool => tool.name).sort(), [...builtinNames].sort());
}

// Uses the existing isolated localhost mira_test harness. No model credentials,
// provider networking or external effects; CI runs this against real PostgreSQL.
test('real PostgreSQL generated extension activates in one Wake and restores saved disabled version, config and rollback history', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const files = await fixture(); const miraId = 'generated-lifecycle';
  const store = new ArtifactStore(files.artifactsDirectory);
  const options = { connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), spoolDirectory: path.join(files.root, 'spool'), workingDirectory: files.root };
  let requests = 0; let first!: ArtifactManifest; let originalRevision = ''; let oldDescription = '';
  try {
    const second = await store.stage(files.sources.two, 'entry.mjs');
    const initial = await runDemo({ ...options, extensions: await readExtensionConfiguration(files.configurationFile),
      events: [{ event: event('install'), wake: { id: 'generated-install', reason: 'Stage, activate and use a synthetic generated extension' } }],
      streamFn: async (_model, context) => {
        requests++; await assertDurableDeclarations(db, miraId, context);
        const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'generated_echo');
        if (requests === 1) {
          assert.equal(declaration, undefined);
          return streamOf(calls(request('stage-one', 'extension_stage', { sourceRoot: files.sources.one, entryRelative: 'entry.mjs' })));
        }
        if (requests === 2) {
          first = toolResult<ArtifactManifest>(context, 'stage-one');
          assert.match(first.digest, /^[a-f0-9]{64}$/); assert.notEqual(first.digest, second.digest);
          assert.deepEqual(await files.lifecycle(), []);
          return streamOf(calls(request('install-one', 'extension_manage', { id: 'generated', action: 'install', digest: first.digest, config: files.config('original') })));
        }
        if (requests === 3) {
          assert.equal(declaration, undefined); assert.deepEqual(await files.lifecycle(), [], 'disabled install is import-free');
          const saved = (await readExtensionConfiguration(files.configurationFile)).entries[0]!;
          assert.equal(saved.enabled, false); originalRevision = saved.generated!.revision;
          assert.equal(toolResult<{ status: string }>(context, 'install-one').status, 'applied');
          return streamOf(calls(request('activate-one', 'extension_manage', { id: 'generated', action: 'activate' })));
        }
        if (requests === 4) {
          assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.one); assert.match(declaration.description, new RegExp(first.digest));
          return streamOf(calls(
            request('same-wake-effect', 'generated_echo', { count: '7' }),
            request('update-two', 'extension_manage', { id: 'generated', action: 'update', digest: second.digest, config: files.config('updated') }),
            request('stale-after-update', 'generated_echo', { count: '8' }),
          ));
        }
        if (requests === 5) {
          assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.two); assert.match(declaration.description, new RegExp(second.digest));
          oldDescription = declaration.description;
          return streamOf(calls(
            request('updated-sibling', 'generated_echo', { text: 'second version' }),
            request('disable-two', 'extension_manage', { id: 'generated', action: 'disable' }),
            request('stale-after-disable', 'generated_echo', { text: 'must not execute' }),
          ));
        }
        assert.equal(requests, 6); assert.equal(declaration, undefined);
        return streamOf(assistant('Generated extension completed and saved disabled'));
      },
    });
    assert.equal(initial.completedRuns, 1); assert.equal(initial.modelCalls, 6);
    const reader = await db.acquire(miraId); const saved = await reader.load(); await reader.close();
    assertExactOutcomes(saved);
    assertStaleOutcomes(saved, ['stale-after-update', 'stale-after-disable']);
    assert.deepEqual(saved.executions.map(execution => execution.intent.callId), ['stage-one', 'install-one', 'activate-one', 'same-wake-effect', 'update-two', 'stale-after-update', 'updated-sibling', 'disable-two', 'stale-after-disable']);
    const raw = await db.admin.query<{ intent: ToolExecution['intent']; outcome: ToolExecution['outcome'] }>('SELECT intent, outcome FROM tool_executions WHERE mira_id = $1 ORDER BY context_version', [miraId]);
    assert.deepEqual(raw.rows, saved.executions);
    for (const execution of saved.executions) assert.equal('authorization' in execution.intent, false);
    const normalized = saved.executions.find(execution => execution.intent.callId === 'same-wake-effect')!;
    assert.deepEqual(normalized.intent.requestedArguments, { count: '7' }); assert.deepEqual(normalized.intent.arguments, { count: 7 });
    assert.deepEqual(await files.effects(), [
      { extensionId: 'generated', version: 'one', label: 'original', callId: 'same-wake-effect', serial: 1, arguments: { count: 7 } },
      { extensionId: 'generated', version: 'two', label: 'updated', callId: 'updated-sibling', serial: 1, arguments: { text: 'second version' } },
    ]);
    const desired = await readExtensionConfiguration(files.configurationFile); const current = desired.entries[0]!;
    assert.equal(current.enabled, false); assert.equal(current.generated!.digest, second.digest); assert.deepEqual(current.config, files.config('updated'));
    assert.deepEqual(current.generated!.history.map(revision => [revision.digest, revision.config]), [[first.digest, files.config('original')], [second.digest, files.config('updated')]]);
    const beforeQuiet = await files.lifecycle();
    const quiet = await runDemo({ ...options, extensions: desired, events: [], streamFn: () => { throw Error('Restart without Wake must not call provider'); } });
    assert.equal(quiet.modelCalls, 0); assert.equal(quiet.version, saved.version); assert.deepEqual(await files.lifecycle(), beforeQuiet, 'disabled restart does not import');
    assert.equal((await files.effects()).length, 2);

    let resumedRequests = 0;
    const continued = await runDemo({ ...options, extensions: await readExtensionConfiguration(files.configurationFile),
      events: [{ event: event('continue'), wake: { id: 'generated-continue', reason: 'Use saved current code, then explicitly restore original revision' } }],
      streamFn: async (_model, context) => {
        resumedRequests++; await assertDurableDeclarations(db, miraId, context);
        assert.match(JSON.stringify(context.messages), /Generated extension completed and saved disabled/);
        const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'generated_echo');
        if (resumedRequests === 1) {
          assert.equal(declaration, undefined);
          return streamOf(calls(request('reactivate-saved', 'extension_manage', { id: 'generated', action: 'activate' })));
        }
        if (resumedRequests === 2) {
          assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.two); assert.match(declaration.description, new RegExp(second.digest));
          assert.notEqual(declaration.description, oldDescription, 'restart gives current code a fresh activation identity');
          return streamOf(calls(
            request('saved-current-effect', 'generated_echo', { text: 'restored current config' }),
            request('rollback-original', 'extension_manage', { id: 'generated', action: 'rollback', revision: originalRevision }),
            request('stale-after-rollback', 'generated_echo', { text: 'must not use replaced code' }),
          ));
        }
        if (resumedRequests === 3) {
          assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.one); assert.match(declaration.description, new RegExp(first.digest));
          return streamOf(calls(
            request('rollback-effect', 'generated_echo', { count: '9' }),
            request('disable-original', 'extension_manage', { id: 'generated', action: 'disable' }),
            request('stale-after-original-disable', 'generated_echo', { count: '10' }),
          ));
        }
        assert.equal(resumedRequests, 4); assert.equal(declaration, undefined);
        return streamOf(assistant('Original generated revision and configuration restored'));
      },
    });
    assert.equal(continued.completedRuns, 1); assert.equal(continued.modelCalls, 4); assert.equal(continued.miraId, initial.miraId);
    const replacement = await db.acquire(miraId); const after = await replacement.load(); await replacement.close();
    assert.deepEqual(after.records.slice(0, saved.records.length), saved.records);
    assert.deepEqual(after.executions.slice(0, saved.executions.length), saved.executions); assertExactOutcomes(after);
    assertStaleOutcomes(after, ['stale-after-rollback', 'stale-after-original-disable']);
    assert.deepEqual((await files.effects()).slice(2), [
      { extensionId: 'generated', version: 'two', label: 'updated', callId: 'saved-current-effect', serial: 1, arguments: { text: 'restored current config' } },
      { extensionId: 'generated', version: 'one', label: 'original', callId: 'rollback-effect', serial: 1, arguments: { count: 9 } },
    ]);
    const restored = (await readExtensionConfiguration(files.configurationFile)).entries[0]!;
    assert.equal(restored.enabled, false); assert.equal(restored.generated!.digest, first.digest); assert.equal(restored.generated!.revision, originalRevision);
    assert.deepEqual(restored.config, files.config('original')); assert.deepEqual(restored.generated!.history, current.generated!.history);
    await store.verify(first); await store.verify(second);
    const runs = await db.admin.query('SELECT completed, input_record_id, final_record_id FROM wake_runs WHERE mira_id = $1', [miraId]);
    assert.equal(runs.rows.length, 2); assert.ok(runs.rows.every(run => run.completed && run.input_record_id && run.final_record_id));
  } finally { await db.close(); await rm(files.root, { recursive: true, force: true }); }
});

for (const applied of [false, true]) test(`real PostgreSQL ${applied ? 'applied' : 'failed'} awaited generated management outcome loss preserves uncertainty without replay`, { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const files = await fixture(); const miraId = `generated-unknown-${applied}`;
  let host: ExtensionHost | undefined;
  try {
    const writer = await db.acquire(miraId);
    host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(writer) });
    const original = host; await original.start();
    const first = await original.stage(files.sources.one, 'entry.mjs'); const second = await original.stage(files.sources.two, 'entry.mjs');
    await original.requestChange('generated', { action: 'install', digest: first.digest, config: files.config('original') }); await original.finish();
    await original.requestChange('generated', { action: 'activate' }); await original.finish();
    if (!applied) await rm(second.directory, { recursive: true, force: true });
    const management = extensionManagementTools(original); const args = { id: 'generated', action: 'update', digest: second.digest, config: files.config('updated') };
    let completed = 0; let faultCalls = 0;
    const faulty = overrideWriter(writer, { finishTool: async outcome => {
      faultCalls++; assert.equal(outcome.callId, 'unknown-update');
      const receipt = original.changeStatus().at(-1)!;
      assert.equal(receipt.action, 'update'); assert.equal(receipt.status, applied ? 'applied' : 'failed');
      assert.equal(receipt.persistence, applied ? 'saved' : 'not-attempted'); completed++;
      const payload = outcome.payload as { content: Array<{ text: string }> };
      const result = JSON.parse(payload.content[0]!.text);
      assert.equal(result.status, receipt.status);
      assert.equal(result.runtime.generated.digest, applied ? second.digest : first.digest);
      assert.equal(result.runtime.status, 'active');
      throw Error('synthetic loss after completed management before outcome commit');
    } });
    await assert.rejects(runtime(faulty, () => streamOf(calls(request('unknown-update', 'extension_manage', args))), {
      prepareTools: async () => [...management, ...extensionTools(await original.prepare())],
      // Both lifecycle success and failure have settled before the durable
      // outcome write. Recovery still cannot infer the missing tool result.
      finishTools: () => original.finish(),
    }).run(input('Update this synthetic generated extension')), /synthetic loss after completed management/);
    assert.equal(completed, 1); assert.equal(faultCalls, 1);
    const interrupted = await writer.load(); assert.equal(interrupted.executions.length, 1);
    assert.deepEqual(interrupted.executions[0]!.intent.arguments, args); assert.equal(interrupted.executions[0]!.outcome, null);
    const rows = await db.admin.query('SELECT intent, outcome FROM tool_executions WHERE mira_id = $1', [miraId]);
    assert.deepEqual(rows.rows, interrupted.executions);
    assert.deepEqual(await files.effects(), []);
    const savedConfig = await readFile(files.configurationFile, 'utf8');
    await original.close(); await writer.close();

    const replacement = await db.acquire(miraId);
    host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(replacement) });
    const restarted = host; await restarted.start();
    const expectedDigest = applied ? second.digest : first.digest; const expectedConfig = files.config(applied ? 'updated' : 'original');
    assert.equal(restarted.inspect()[0]!.generated!.digest, expectedDigest); assert.deepEqual(restarted.inspect()[0]!.config, expectedConfig);
    assert.equal(restarted.inspect()[0]!.generated!.history.length, applied ? 2 : 1);
    assert.deepEqual(restarted.changeStatus(), [], 'restart never replays a completed management operation from an unknown intent');
    const recovered = await runtime(replacement, () => { throw Error('Recovery must not call the provider'); }).recover();
    assert.deepEqual(recovered.snapshot.records.slice(0, interrupted.records.length), interrupted.records);
    assert.deepEqual(recovered.snapshot.executions, interrupted.executions);
    assert.equal(recovered.recovery.operations.length, 1); assert.equal(recovered.recovery.operations[0]!.status, 'outcome-unknown');
    assert.equal(recovered.recovery.operations[0]!.callId, 'unknown-update'); assert.deepEqual(recovered.recovery.operations[0]!.arguments, args);
    assert.match(JSON.stringify(recovered.messages), /may already have executed/);
    assert.deepEqual((await runtime(replacement).recover()).snapshot, recovered.snapshot, 'repeated recovery is idempotent');
    const recoveredRecords = await db.admin.query('SELECT envelope FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId]);
    assert.deepEqual(recoveredRecords.rows.map(row => row.envelope), recovered.snapshot.records, 'uncertainty is a durable recovery observation');
    let requests = 0; let prepared: AgentTool[] = []; const currentManagement = extensionManagementTools(restarted);
    await runtime(replacement, async (_model, context) => {
      requests++; await assertDurableDeclarations(db, miraId, context, prepared);
      assert.match(JSON.stringify(context.messages), /may already have executed/);
      const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'generated_echo');
      assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters[applied ? 'two' : 'one']); assert.match(declaration.description, new RegExp(expectedDigest));
      if (requests === 1) return streamOf(calls(request('inspect-current', 'extension_inspect', {})));
      if (requests === 2) {
        const inspected = toolResult<{ extensions: Array<{ generated: { digest: string }; config: Json }>; changes: unknown[] }>(context, 'inspect-current');
        assert.deepEqual(inspected.changes, []); assert.equal(inspected.extensions[0]!.generated.digest, expectedDigest); assert.deepEqual(inspected.extensions[0]!.config, expectedConfig);
        return streamOf(calls(request('new-effect', 'generated_echo', applied ? { text: 'after unknown outcome' } : { count: 5 })));
      }
      assert.equal(requests, 3); return streamOf(assistant('Inspected and used saved code without replaying the unknown update'));
    }, { prepareTools: async () => prepared = [...currentManagement, ...extensionTools(await restarted.prepare())], finishTools: () => restarted.finish() }).run(input('Inspect the current saved extension and continue'));
    const after = await replacement.load();
    assert.deepEqual(after.records.slice(0, recovered.snapshot.records.length), recovered.snapshot.records);
    assert.deepEqual(after.executions[0], interrupted.executions[0]);
    assert.deepEqual(after.executions.map(execution => execution.intent.callId), ['unknown-update', 'inspect-current', 'new-effect']);
    assert.ok(after.executions.slice(1).every(execution => execution.outcome));
    assert.deepEqual(restarted.changeStatus(), []); assert.equal(await readFile(files.configurationFile, 'utf8'), savedConfig);
    assert.deepEqual(await files.effects(), [{ extensionId: 'generated', version: applied ? 'two' : 'one', label: applied ? 'updated' : 'original', callId: 'new-effect', serial: 1, arguments: applied ? { text: 'after unknown outcome' } : { count: 5 } }]);
    assert.deepEqual((await files.lifecycle()).filter(item => item.phase === 'import').map(item => item.version), applied ? ['one', 'two', 'two'] : ['one', 'one']);
  } finally { await host?.close(); await db.close(); await rm(files.root, { recursive: true, force: true }); }
});
