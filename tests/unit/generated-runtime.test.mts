import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { AgentTool, AgentToolCall } from '@earendil-works/pi-agent-core';
import { getCurrentTools, toToolDeclaration, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { ExtensionHost, readExtensionConfiguration, type ArtifactManifest, type Json } from '@mira/extension-host';
import { decodeRecords } from '@mira/runtime-pi';
import { extensionManagementTools, extensionReceiver, extensionTools } from '@mira/server';
import { assistant, effectTool, input, MemoryWriter, result, runtime, streamOf } from '../recovery/fixtures.mts';

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
  context.registerTool({ name: 'generated.echo', description: 'Synthetic generated echo ' + version, parameters,
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
function assertDeclarations(writer: MemoryWriter, context: TranscriptContext, prepared: AgentTool[]) {
  const expected = prepared.map(toToolDeclaration);
  assert.deepEqual(getCurrentTools(context.messages), expected, 'provider and actual dispatcher use exactly the same snapshot');
  const stored = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  assert.deepEqual(getCurrentTools(stored), expected, 'declarations are durable before the provider request');
}

test('generated tools stage, install disabled, activate, update and roll back with coherent declarations and dispatch in one turn', { timeout: 20_000 }, async () => {
  const files = await fixture(); const writer = new MemoryWriter(); const builtin = effectTool(async () => result);
  const host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(writer) });
  let prepared: AgentTool[] = []; let requests = 0; let first!: ArtifactManifest; let originalRevision = ''; let originalActivation = '';
  const evidence = { source: 'synthetic-user', intent: 'stage and exercise generated extension lifecycle' };
  try {
    await host.start(); const second = await host.stage(files.sources.two, 'entry.mjs');
    assert.deepEqual(await files.lifecycle(), [], 'staging never imports generated code');
    const management = extensionManagementTools(host);
    const completed = await runtime(writer, async (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.ok(prepared.some(tool => tool.name === builtin.name));
      const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'generated.echo');
      if (requests === 1) {
        assert.equal(declaration, undefined);
        return streamOf(calls(request('stage-one', 'extension.stage', { sourceRoot: files.sources.one, entryRelative: 'entry.mjs' })));
      }
      if (requests === 2) {
        first = toolResult<ArtifactManifest>(context, 'stage-one');
        assert.match(first.digest, /^[a-f0-9]{64}$/); assert.notEqual(first.digest, second.digest);
        assert.deepEqual(await files.lifecycle(), []);
        return streamOf(calls(request('install-one', 'extension.manage', { id: 'generated', action: 'install', digest: first.digest, config: files.config('original') })));
      }
      if (requests === 3) {
        assert.equal(declaration, undefined); assert.equal(host.inspect()[0]!.status, 'disabled');
        assert.equal(toolResult<{ status: string }>(context, 'install-one').status, 'accepted');
        assert.equal(host.changeStatus()[0]!.persistence, 'saved'); assert.deepEqual(await files.lifecycle(), []);
        originalRevision = host.inspect()[0]!.generated!.revision;
        return streamOf(calls(request('activate-one', 'extension.manage', { id: 'generated', action: 'activate' })));
      }
      if (requests === 4 || requests === 5 || requests === 7) {
        assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.one);
        assert.match(declaration.description, new RegExp(first.digest));
        assert.equal(host.inspect()[0]!.generated!.digest, first.digest);
        assert.deepEqual(host.inspect()[0]!.config, files.config('original'));
      }
      if (requests === 4) {
        originalActivation = host.inspect()[0]!.activation!;
        return streamOf(calls(request('first-effect', 'generated.echo', { count: '1' })));
      }
      if (requests === 5) return streamOf(calls(
        request('update-two', 'extension.manage', { id: 'generated', action: 'update', digest: second.digest, config: files.config('updated') }),
        request('old-sibling', 'generated.echo', { count: '2' }),
      ));
      if (requests === 6) {
        assert.ok(declaration); assert.deepEqual(declaration.parameters, parameters.two);
        assert.match(declaration.description, new RegExp(second.digest));
        assert.notEqual(host.inspect()[0]!.activation, originalActivation);
        assert.equal(host.inspect()[0]!.generated!.history.find(item => item.id === originalRevision)!.digest, first.digest);
        return streamOf(calls(
          request('rollback-one', 'extension.manage', { id: 'generated', action: 'rollback', revision: originalRevision }),
          request('new-sibling', 'generated.echo', { text: 'replacement' }),
        ));
      }
      if (requests === 7) {
        assert.notEqual(host.inspect()[0]!.activation, originalActivation);
        return streamOf(calls(request('disable-restored', 'extension.manage', { id: 'generated', action: 'disable' }), request('restored-sibling', 'generated.echo', { count: 3 })));
      }
      assert.equal(requests, 8); assert.equal(declaration, undefined); assert.equal(host.inspect()[0]!.status, 'disabled');
      return streamOf(assistant('Generated lifecycle completed in the same turn'));
    }, {
      prepareTools: async () => prepared = [builtin, ...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
      authorize: async (request, args) => {
        assert.equal(writer.state.executions.some(execution => execution.intent.callId === request.id), false);
        if (request.id === 'old-sibling') assert.deepEqual(args, { count: 2 });
        return { allowed: true, evidence };
      },
    }).run(input('Stage, install, activate, update, roll back and disable the synthetic extension'));
    assert.equal(requests, 8);
    assert.deepEqual(await files.effects(), [
      { extensionId: 'generated', version: 'one', label: 'original', callId: 'first-effect', serial: 1, arguments: { count: 1 } },
      { extensionId: 'generated', version: 'one', label: 'original', callId: 'old-sibling', serial: 2, arguments: { count: 2 } },
      { extensionId: 'generated', version: 'two', label: 'updated', callId: 'new-sibling', serial: 1, arguments: { text: 'replacement' } },
      { extensionId: 'generated', version: 'one', label: 'original', callId: 'restored-sibling', serial: 1, arguments: { count: 3 } },
    ]);
    assert.deepEqual((await files.lifecycle()).filter(item => item.phase === 'import').map(item => item.version), ['one', 'two', 'one']);
    assert.deepEqual(host.changeStatus().map(receipt => [receipt.action, receipt.status, receipt.persistence]),
      ['install', 'activate', 'update', 'rollback', 'disable'].map(action => [action, 'applied', 'saved']));
    for (const execution of writer.state.executions) {
      assert.deepEqual(execution.intent.authorization, evidence); assert.ok(execution.outcome);
      const message = completed.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
      assert.ok(message?.role === 'toolResult'); assert.deepEqual(execution.outcome.payload, message);
      assert.equal(execution.outcome.occurredAt, new Date(message.timestamp).toISOString());
      if (execution.intent.toolName === 'extension.manage') assert.equal(JSON.parse((message.content[0] as { text: string }).text).status, 'accepted');
    }
    assert.deepEqual(writer.state.executions.find(execution => execution.intent.callId === 'old-sibling')!.intent.requestedArguments, { count: '2' });
    const deltas = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
    assert.equal(deltas.length, 5);
    assert.deepEqual(deltas.slice(1).map(message => message.toolsAdded?.find(tool => tool.name === 'generated.echo')?.parameters ?? null), [parameters.one, parameters.two, parameters.one, null]);
    assert.deepEqual(deltas.slice(2).map(message => message.toolsRemoved), [[{ name: 'generated.echo' }], [{ name: 'generated.echo' }], [{ name: 'generated.echo' }]]);
  } finally { await host.close(); await writer.close(); await rm(files.root, { recursive: true, force: true }); }
});

test('accepted generated update with a lost durable outcome is not replayed after restoring current saved code and config', { timeout: 20_000 }, async () => {
  const files = await fixture(); const writer = new MemoryWriter(); let host: ExtensionHost | undefined;
  try {
    host = new ExtensionHost({ ...await readExtensionConfiguration(files.configurationFile), receive: extensionReceiver(writer) });
    await host.start(); const first = await host.stage(files.sources.one, 'entry.mjs'); const second = await host.stage(files.sources.two, 'entry.mjs');
    host.requestChange('generated', { action: 'install', digest: first.digest, config: files.config('original') }); await host.finish();
    host.requestChange('generated', { action: 'activate' }); await host.finish();
    const original = host; const management = extensionManagementTools(original); let lost = 0;
    writer.beforeOutcome = async outcome => {
      assert.equal(outcome.callId, 'lost-update');
      assert.equal(original.changeStatus().at(-1)!.status, 'accepted');
      assert.equal(original.inspect()[0]!.generated!.digest, first.digest);
      lost++; throw Error('synthetic accepted receipt write loss');
    };
    await assert.rejects(runtime(writer, () => streamOf(calls(request('lost-update', 'extension.manage', { id: 'generated', action: 'update', digest: second.digest, config: files.config('updated') }))), {
      prepareTools: async () => [...management, ...extensionTools(await original.prepare())], finishTools: () => original.finish(),
    }).run(input('Update the generated synthetic extension')), /synthetic accepted receipt write loss/);
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
        const current = getCurrentTools(context.messages).find(tool => tool.name === 'generated.echo');
        assert.deepEqual(current?.parameters, parameters.two); assert.match(current!.description, new RegExp(second.digest));
        return streamOf(requests === 1 ? calls(request('new-effect', 'generated.echo', { text: 'after recovery' })) : assistant('Current generated version verified without replay'));
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
