import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentTool, AgentToolCall } from '@earendil-works/pi-agent-core';
import { getCurrentTools, toToolDeclaration, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { ExtensionHost, readExtensionConfiguration, type ArtifactManifest, type ChangeStatus, type ExtensionStatus, type Json } from '@mira/extension-host';
import { decodeRecords } from '@mira/runtime-pi';
import { extensionManagementTools, extensionReceiver, extensionTools } from '@mira/server';
import { assistant, effectTool, input, MemoryWriter, model, result, runtime, streamOf } from '../recovery/fixtures.mts';

const parameters = {
  one: { type: 'object', properties: { count: { type: 'number', minimum: 1 } }, required: ['count'], additionalProperties: false },
  two: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
};
const request = (id: string, name: string, args: AgentToolCall['arguments']) => ({ type: 'toolCall' as const, id, name, arguments: args });
const calls = (...content: AssistantMessage['content']): AssistantMessage => ({ ...assistant(), stopReason: 'toolUse', content });
type Witness = { extensionId: string; version: string; label: string; callId: string; serial: number; arguments: Json };

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-generated-runtime-'));
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
function assertStale(context: TranscriptContext, callId: string, activation: string): void {
  const message = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === callId);
  assert.ok(message?.role === 'toolResult' && message.isError && message.content[0]?.type === 'text');
  assert.match(message.content[0].text, /was not executed.*stale/);
  assert.deepEqual(message.details, { status: 'stale', executed: false, extensionId: 'generated', activation, toolName: 'generated_echo' });
}
function assertDeclarations(writer: MemoryWriter, context: TranscriptContext, prepared: AgentTool[]) {
  const expected = prepared.map(toToolDeclaration);
  assert.deepEqual(getCurrentTools(context.messages), expected, 'provider and actual dispatcher use exactly the same snapshot');
  const stored = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  assert.deepEqual(getCurrentTools(stored), expected, 'declarations are durable before the provider request');
}

test('awaited generated management installs, activates, inspects and invokes within one user turn', { timeout: 20_000 }, async () => {
  const files = await fixture(); const writer = new MemoryWriter();
  const host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(writer) });
  const statuses = { install: 'disabled', activate: 'active', disable: 'disabled' } as const;
  const receipts = new Map<string, ChangeStatus>(); const completedManagement: string[] = [];
  let prepared: AgentTool[] = []; let requests = 0;
  writer.beforeOutcome = async outcome => {
    if (!outcome.callId.startsWith('manage-')) return;
    const action = outcome.callId.slice('manage-'.length) as keyof typeof statuses;
    const extension = host.inspect()[0]!;
    assert.equal(extension.status, statuses[action], 'management settles before its durable result is written');
    const saved = await readExtensionConfiguration(files.configurationFile);
    assert.deepEqual(saved.entries, [{ id: extension.id, path: extension.path, enabled: extension.enabled,
      config: extension.config, generated: extension.generated }], 'management saves the real desired configuration before returning');
    assert.deepEqual(await files.lifecycle(), action === 'install' ? [] : [
      { phase: 'import', version: 'one' }, { phase: 'apply', version: 'one', label: 'batch-flow' },
    ], 'install stays import-free and activation executes the prebuilt module exactly once');
    completedManagement.push(action);
  };
  try {
    await host.start();
    const release = await host.stage(files.sources.one, 'entry.mjs');
    assert.deepEqual(await files.lifecycle(), [], 'prebuilt staged code has not been imported');
    const management = extensionManagementTools(host);
    const user = input('Install and activate the staged synthetic extension, verify it, use it, then disable and verify it');
    const completed = await runtime(writer, async (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.deepEqual(context.messages.filter(message => message.role === 'user'), [user], 'all follow-up batches use the original user input');
      for (const [callId, receipt] of receipts) {
        assert.deepEqual(toolResult<ChangeStatus>(context, callId), receipt, 'later changes cannot rewrite a prior management outcome');
      }
      const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'generated_echo');
      if (requests === 1) {
        assert.equal(declaration, undefined);
        return streamOf(calls(
          request('manage-install', 'extension_manage', { id: 'generated', action: 'install', digest: release.digest, config: files.config('batch-flow') }),
          request('inspect-install', 'extension_inspect', {}),
          request('manage-activate', 'extension_manage', { id: 'generated', action: 'activate' }),
          request('inspect-activate', 'extension_inspect', {}),
        ));
      }
      const actions = requests === 2 ? ['install', 'activate'] as const : ['install', 'activate', 'disable'] as const;
      for (const [index, action] of actions.entries()) {
        const receipt = toolResult<ChangeStatus>(context, `manage-${action}`);
        assert.equal(receipt.status, 'applied'); assert.equal(receipt.persistence, 'saved');
        assert.equal(receipt.extensionId, 'generated'); assert.equal(receipt.action, action);
        receipts.set(`manage-${action}`, structuredClone(receipt));
        const inspected = toolResult<{ extensions: ExtensionStatus[]; changes: ChangeStatus[]; releases: ArtifactManifest[]; diagnostics: string[] }>(context, `inspect-${action}`);
        assert.deepEqual(inspected.changes, actions.slice(0, index + 1).map(previous => receipts.get(`manage-${previous}`)));
        assert.equal(inspected.extensions.length, 1);
        const extension = inspected.extensions[0]!;
        assert.deepEqual(receipt.runtime, extension, 'management returns its own exact post-operation runtime snapshot');
        assert.equal(extension.id, 'generated'); assert.equal(extension.status, statuses[action]);
        assert.equal(extension.enabled, action === 'activate');
        assert.deepEqual(extension.tools, action === 'activate' ? ['generated_echo'] : []);
        assert.equal(extension.generated?.digest, release.digest); assert.deepEqual(extension.config, files.config('batch-flow'));
        assert.equal(extension.diagnostic, null); assert.deepEqual(inspected.diagnostics, []);
        assert.deepEqual(inspected.releases, [release]);
      }
      if (requests === 2) {
        assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.one);
        assert.match(declaration.description, new RegExp(release.digest));
        return streamOf(calls(
          request('invoke-generated', 'generated_echo', { count: '4' }),
          request('manage-disable', 'extension_manage', { id: 'generated', action: 'disable' }),
          request('inspect-disable', 'extension_inspect', {}),
        ));
      }
      assert.equal(requests, 3); assert.equal(declaration, undefined);
      assert.match(JSON.stringify(context.messages), /Generated result/);
      return streamOf(assistant('Installation, activation, use and disable completed in the same turn'));
    }, {
      // This lifecycle scenario retains its full multi-tool transcript; token
      // pressure and compaction are covered by the dedicated runtime tests.
      model: { ...model, contextWindow: 32768 },
      prepareTools: async () => prepared = [...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
    }).run(user);
    assert.equal(requests, 3); assert.deepEqual(completedManagement, ['install', 'activate', 'disable']);
    assert.deepEqual(completed.messages.filter(message => message.role === 'user'), [user]);
    assert.deepEqual(writer.state.executions.map(execution => execution.intent.callId), [
      'manage-install', 'inspect-install', 'manage-activate', 'inspect-activate', 'invoke-generated', 'manage-disable', 'inspect-disable',
    ]);
    for (const execution of writer.state.executions) {
      const message = completed.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
      assert.ok(message?.role === 'toolResult' && execution.outcome);
      assert.deepEqual(execution.outcome.payload, message, 'every result retains its exact durable outcome');
      if (execution.intent.toolName === 'extension_manage') {
        assert.ok(message.content[0]?.type === 'text');
        assert.deepEqual(JSON.parse(message.content[0].text), receipts.get(execution.intent.callId));
      }
    }
    assert.deepEqual(await files.effects(), [{ extensionId: 'generated', version: 'one', label: 'batch-flow', callId: 'invoke-generated', serial: 1, arguments: { count: 4 } }]);
    assert.deepEqual(completed.recovery.operations, []);
  } finally { await host.close(); await writer.close(); await rm(files.root, { recursive: true, force: true }); }
});

test('failed generated activation returns saved desired state and a known durable failure before the next request', { timeout: 20_000 }, async () => {
  const files = await fixture(); const writer = new MemoryWriter();
  await writeFile(path.join(files.sources.one, 'entry.mjs'), 'throw new Error("synthetic generated import failure");');
  const host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(writer) });
  let prepared: AgentTool[] = []; let requests = 0;
  try {
    await host.start(); const release = await host.stage(files.sources.one, 'entry.mjs'); const management = extensionManagementTools(host);
    const completed = await runtime(writer, async (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.equal(getCurrentTools(context.messages).some(tool => tool.name === 'generated_echo'), false);
      if (requests === 1) return streamOf(calls(
        request('install-broken', 'extension_manage', { id: 'generated', action: 'install', digest: release.digest, config: files.config('broken') }),
        request('activate-broken', 'extension_manage', { id: 'generated', action: 'activate' }),
        request('inspect-broken', 'extension_inspect', {}),
      ));
      assert.equal(requests, 2);
      const installed = toolResult<ChangeStatus>(context, 'install-broken');
      assert.equal(installed.status, 'applied'); assert.equal(installed.runtime?.status, 'disabled');
      const failed = toolResult<ChangeStatus>(context, 'activate-broken');
      assert.equal(failed.status, 'failed'); assert.equal(failed.persistence, 'saved'); assert.ok(failed.error);
      assert.ok(failed.runtime); assert.equal(failed.runtime.status, 'import-failed'); assert.equal(failed.runtime.enabled, true);
      assert.deepEqual(failed.runtime.tools, []);
      const inspected = toolResult<{ extensions: ExtensionStatus[]; changes: ChangeStatus[] }>(context, 'inspect-broken');
      assert.deepEqual(inspected.extensions, [failed.runtime]); assert.deepEqual(inspected.changes, [installed, failed]);
      const saved = await readExtensionConfiguration(files.configurationFile);
      assert.equal(saved.entries[0]!.enabled, true); assert.equal(saved.entries[0]!.generated!.digest, release.digest);
      return streamOf(assistant('Activation failed; the saved desired state is still enabled'));
    }, {
      prepareTools: async () => prepared = [...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
    }).run(input('Install and activate the synthetic extension and inspect its actual outcome'));
    assert.equal(requests, 2); assert.deepEqual(completed.recovery.operations, []);
    assert.deepEqual(await files.effects(), []);
    for (const execution of writer.state.executions) {
      const message = completed.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
      assert.ok(message?.role === 'toolResult' && execution.outcome); assert.deepEqual(execution.outcome.payload, message);
    }
  } finally { await host.close(); await writer.close(); await rm(files.root, { recursive: true, force: true }); }
});

test('generated tools stage, install disabled, activate, update and roll back with coherent declarations and dispatch in one turn', { timeout: 20_000 }, async () => {
  const files = await fixture(); const writer = new MemoryWriter(); const builtin = effectTool(async () => result);
  const host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(writer) });
  let prepared: AgentTool[] = []; let requests = 0; let first!: ArtifactManifest; let originalRevision = ''; let originalActivation = ''; let updatedActivation = ''; let restoredActivation = '';
  writer.beforeIntent = async intent => {
    assert.equal(writer.state.executions.some(execution => execution.intent.callId === intent.callId), false);
    if (intent.callId === 'old-sibling') assert.deepEqual(intent.arguments, { count: 2 });
  };
  try {
    await host.start(); const second = await host.stage(files.sources.two, 'entry.mjs');
    assert.deepEqual(await files.lifecycle(), [], 'staging never imports generated code');
    const management = extensionManagementTools(host);
    const completed = await runtime(writer, async (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.ok(prepared.some(tool => tool.name === builtin.name));
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
        assert.equal(declaration, undefined); assert.equal(host.inspect()[0]!.status, 'disabled');
        assert.equal(toolResult<{ status: string }>(context, 'install-one').status, 'applied');
        assert.equal(host.changeStatus()[0]!.persistence, 'saved'); assert.deepEqual(await files.lifecycle(), []);
        originalRevision = host.inspect()[0]!.generated!.revision;
        return streamOf(calls(request('activate-one', 'extension_manage', { id: 'generated', action: 'activate' })));
      }
      if (requests === 4 || requests === 5 || requests === 7) {
        assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.one);
        assert.match(declaration.description, new RegExp(first.digest));
        assert.equal(host.inspect()[0]!.generated!.digest, first.digest);
        assert.deepEqual(host.inspect()[0]!.config, files.config('original'));
      }
      if (requests === 4) {
        originalActivation = host.inspect()[0]!.activation!;
        return streamOf(calls(request('first-effect', 'generated_echo', { count: '1' })));
      }
      if (requests === 5) return streamOf(calls(
        request('update-two', 'extension_manage', { id: 'generated', action: 'update', digest: second.digest, config: files.config('updated') }),
        request('old-sibling', 'generated_echo', { count: '2' }),
      ));
      if (requests === 6) {
        assertStale(context, 'old-sibling', originalActivation);
        assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.two);
        assert.match(declaration.description, new RegExp(second.digest));
        assert.notEqual(host.inspect()[0]!.activation, originalActivation);
        updatedActivation = host.inspect()[0]!.activation!;
        assert.equal(host.inspect()[0]!.generated!.history.find(item => item.id === originalRevision)!.digest, first.digest);
        return streamOf(calls(
          request('updated-effect', 'generated_echo', { text: 'current update' }),
          request('rollback-one', 'extension_manage', { id: 'generated', action: 'rollback', revision: originalRevision }),
          request('new-sibling', 'generated_echo', { text: 'replacement' }),
        ));
      }
      if (requests === 7) {
        assertStale(context, 'new-sibling', updatedActivation);
        assert.notEqual(host.inspect()[0]!.activation, originalActivation);
        restoredActivation = host.inspect()[0]!.activation!;
        return streamOf(calls(request('restored-effect', 'generated_echo', { count: 3 }), request('disable-restored', 'extension_manage', { id: 'generated', action: 'disable' }), request('restored-sibling', 'generated_echo', { count: 3 })));
      }
      assert.equal(requests, 8); assert.equal(declaration, undefined); assert.equal(host.inspect()[0]!.status, 'disabled');
      assertStale(context, 'restored-sibling', restoredActivation);
      return streamOf(assistant('Generated lifecycle completed in the same turn'));
    }, {
      prepareTools: async () => prepared = [builtin, ...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
    }).run(input('Stage, install, activate, update, roll back and disable the synthetic extension'));
    assert.equal(requests, 8);
    assert.deepEqual(completed.recovery.operations, [], 'stale calls have definite saved outcomes, never unknown effects');
    assert.deepEqual(await files.effects(), [
      { extensionId: 'generated', version: 'one', label: 'original', callId: 'first-effect', serial: 1, arguments: { count: 1 } },
      { extensionId: 'generated', version: 'two', label: 'updated', callId: 'updated-effect', serial: 1, arguments: { text: 'current update' } },
      { extensionId: 'generated', version: 'one', label: 'original', callId: 'restored-effect', serial: 1, arguments: { count: 3 } },
    ]);
    assert.deepEqual((await files.lifecycle()).filter(item => item.phase === 'import').map(item => item.version), ['one', 'two', 'one']);
    assert.deepEqual(host.changeStatus().map(receipt => [receipt.action, receipt.status, receipt.persistence]),
      ['install', 'activate', 'update', 'rollback', 'disable'].map(action => [action, 'applied', 'saved']));
    for (const execution of writer.state.executions) {
      assert.equal('authorization' in execution.intent, false); assert.ok(execution.outcome);
      const message = completed.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
      assert.ok(message?.role === 'toolResult'); assert.deepEqual(execution.outcome.payload, message);
      assert.equal(execution.outcome.occurredAt, new Date(message.timestamp).toISOString());
      if (execution.intent.toolName === 'extension_manage') assert.equal(JSON.parse((message.content[0] as { text: string }).text).status, 'applied');
    }
    assert.deepEqual(writer.state.executions.find(execution => execution.intent.callId === 'old-sibling')!.intent.requestedArguments, { count: '2' });
    const deltas = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
    assert.equal(deltas.length, 5);
    assert.deepEqual(deltas.slice(1).map(message => message.toolsAdded?.find(tool => tool.name === 'generated_echo')?.parameters ?? null), [parameters.one, parameters.two, parameters.one, null]);
    assert.deepEqual(deltas.slice(2).map(message => message.toolsRemoved), [[{ name: 'generated_echo' }], [{ name: 'generated_echo' }], [{ name: 'generated_echo' }]]);
  } finally { await host.close(); await writer.close(); await rm(files.root, { recursive: true, force: true }); }
});

test('applied generated update with a lost durable outcome is not replayed after restoring current saved code and config', { timeout: 20_000 }, async () => {
  const files = await fixture(); const writer = new MemoryWriter(); let host: ExtensionHost | undefined;
  try {
    host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(writer) });
    await host.start(); const first = await host.stage(files.sources.one, 'entry.mjs'); const second = await host.stage(files.sources.two, 'entry.mjs');
    await host.requestChange('generated', { action: 'install', digest: first.digest, config: files.config('original') }); await host.finish();
    await host.requestChange('generated', { action: 'activate' }); await host.finish();
    const original = host; const management = extensionManagementTools(original); let lost = 0;
    writer.beforeOutcome = async outcome => {
      assert.equal(outcome.callId, 'lost-update');
      assert.equal(original.changeStatus().at(-1)!.status, 'applied');
      assert.equal(original.inspect()[0]!.generated!.digest, second.digest);
      lost++; throw Error('synthetic applied receipt write loss');
    };
    await assert.rejects(runtime(writer, () => streamOf(calls(request('lost-update', 'extension_manage', { id: 'generated', action: 'update', digest: second.digest, config: files.config('updated') }))), {
      prepareTools: async () => [...management, ...extensionTools(await original.prepare())], finishTools: () => original.finish(),
    }).run(input('Update the generated synthetic extension')), /synthetic applied receipt write loss/);
    assert.equal(lost, 1); assert.equal(writer.state.executions[0]!.outcome, null);
    assert.equal(original.changeStatus().at(-1)!.persistence, 'saved');
    const savedConfig = await readFile(files.configurationFile, 'utf8');
    await original.close();
    const replacement = new MemoryWriter(); replacement.state = structuredClone(writer.state);
    host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(replacement) });
    const restarted = host; await restarted.start();
    assert.deepEqual(restarted.changeStatus(), []); assert.equal(restarted.inspect()[0]!.generated!.digest, second.digest);
    assert.deepEqual(restarted.inspect()[0]!.config, files.config('updated'));
    const recovered = await runtime(replacement, () => { throw Error('Recovery cannot invoke a provider'); }).recover();
    assert.equal(recovered.recovery.operations[0]!.status, 'outcome-unknown');
    assert.equal(recovered.recovery.operations[0]!.callId, 'lost-update');
    assert.match(JSON.stringify(recovered.messages), /may already have executed/);
    const before = structuredClone(replacement.state); let requests = 0; let prepared: AgentTool[] = [];
    const currentManagement = extensionManagementTools(restarted);
    try {
      await runtime(replacement, (_model, context) => {
        requests++; assertDeclarations(replacement, context, prepared);
        assert.match(JSON.stringify(context.messages), /may already have executed/);
        const current = getCurrentTools(context.messages).find(tool => tool.name === 'generated_echo');
        assert.deepEqual(current?.parameters, parameters.two); assert.match(current!.description, new RegExp(second.digest));
        return streamOf(requests === 1 ? calls(request('new-effect', 'generated_echo', { text: 'after recovery' })) : assistant('Current generated version verified without replay'));
      }, { prepareTools: async () => prepared = [...currentManagement, ...extensionTools(await restarted.prepare())], finishTools: () => restarted.finish() }).run(input('Check the saved generated version'));
      assert.equal(requests, 2); assert.deepEqual(restarted.changeStatus(), []);
      assert.equal(await readFile(files.configurationFile, 'utf8'), savedConfig);
      assert.deepEqual(replacement.state.records.slice(0, before.records.length), before.records);
      assert.deepEqual(replacement.state.executions[0], before.executions[0]);
      assert.deepEqual(replacement.state.executions.map(execution => execution.intent.callId), ['lost-update', 'new-effect']);
      assert.deepEqual(await files.effects(), [{ extensionId: 'generated', version: 'two', label: 'updated', callId: 'new-effect', serial: 1, arguments: { text: 'after recovery' } }]);
    } finally { await replacement.close(); }
  } finally { await host?.close(); await writer.close(); await rm(files.root, { recursive: true, force: true }); }
});
