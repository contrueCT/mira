import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import type { AgentTool, AgentToolCall } from '@earendil-works/pi-agent-core';
import { getCurrentSystemPrompt, getCurrentTools, toToolDeclaration, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { ExtensionHost, readExtensionConfiguration } from '@mira/extension-host';
import { extensionManagementTools, extensionReceiver, extensionTools } from '@mira/server';
import { decodeRecords } from '@mira/runtime-pi';
import { assistant, deferred, effectTool, input, MemoryWriter, result, runtime, streamOf } from '../recovery/fixtures.mts';
import { createExtensionFixture, fixtureParameters } from '../recovery/extension-fixtures.mts';

const call = (id: string, name: string, args: AgentToolCall['arguments']): AssistantMessage => ({
  ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }],
});

function assertDeclarations(writer: MemoryWriter, context: TranscriptContext, prepared: AgentTool[]): void {
  const expected = prepared.map(toToolDeclaration);
  assert.deepEqual(getCurrentTools(context.messages), expected, 'provider declares the exact executable registry');
  const persisted = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  assert.deepEqual(getCurrentTools(persisted), expected, 'declarations are durable before the request');
}
function assertStale(context: TranscriptContext, callId: string, activation: string): void {
  const message = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === callId);
  assert.ok(message?.role === 'toolResult' && message.isError && message.content[0]?.type === 'text');
  assert.match(message.content[0].text, /was not executed.*stale/);
  assert.deepEqual(message.details, { status: 'stale', executed: false, extensionId: 'manual', activation, toolName: 'fixture_echo' });
}

test('real extension host enables a configured module within one runtime turn and persists exact intent and outcomes', { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter();
  const builtIn = effectTool(async () => result);
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, enabled: false, config: fixture.config }],
    reservedToolNames: [builtIn.name, 'extension_manage', 'extension_inspect'], receive: extensionReceiver(writer) });
  writer.beforeIntent = async intent => {
    assert.equal(writer.state.executions.some(execution => execution.intent.callId === intent.callId), false);
    if (intent.toolName === 'fixture_echo') assert.deepEqual(await fixture.effects(), [], 'durable intent precedes the effect');
  };
  let prepared: AgentTool[] = []; let requests = 0;
  try {
    await host.start(); assert.equal(host.inspect()[0]!.status, 'disabled');
    const management = extensionManagementTools(host);
    const instance = runtime(writer, (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.ok(prepared.some(tool => tool.name === builtIn.name), 'builtin survives each registry update');
      const extension = getCurrentTools(context.messages).find(tool => tool.name === 'fixture_echo');
      if (requests === 1) {
        assert.equal(extension, undefined);
        return streamOf(call('enable-manual', 'extension_manage', { id: 'manual', action: 'enable' }));
      }
      assert.ok(extension); assert.deepEqual(extension.parameters, fixtureParameters);
      assert.match(extension.description, /Extension "manual", activation /);
      assert.equal(host.inspect()[0]!.status, 'active');
      assert.equal(host.changeStatus()[0]!.status, 'applied');
      if (requests === 2) return streamOf(call('echo-manual', 'fixture_echo', { count: '7', label: 'synthetic' }));
      assert.equal(requests, 3);
      assert.match(JSON.stringify(context.messages), /Synthetic extension result/);
      return streamOf(assistant('Completed the configured extension in the same turn'));
    }, {
      tools: [builtIn],
      prepareTools: async () => prepared = [builtIn, ...management, ...extensionTools(await host.prepare())],
      finishTools: () => host.finish(),
    });
    const recovered = await instance.run(input('Enable the configured manual extension and use it'));
    assert.equal(requests, 3);
    assert.deepEqual(writer.state.executions.map(execution => ({ id: execution.intent.callId, args: execution.intent.arguments })), [
      { id: 'enable-manual', args: { id: 'manual', action: 'enable' } },
      { id: 'echo-manual', args: { count: 7, label: 'synthetic' } },
    ]);
    assert.deepEqual(await fixture.effects(), [{ extensionId: 'manual', revision: 1, callId: 'echo-manual', arguments: { count: 7, label: 'synthetic' } }]);
    assert.ok(writer.state.executions.every(execution => !('authorization' in execution.intent)));
    assert.deepEqual(writer.state.executions[1]!.intent.requestedArguments, { count: '7', label: 'synthetic' });
    assert.deepEqual(writer.state.executions[1]!.intent.arguments, { count: 7, label: 'synthetic' });
    for (const execution of writer.state.executions) {
      assert.ok(execution.outcome);
      const message = recovered.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
      assert.ok(message?.role === 'toolResult');
      assert.deepEqual(execution.outcome.payload, message);
      assert.equal(execution.outcome.occurredAt, new Date(message.timestamp).toISOString());
    }
    const receipt = recovered.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'enable-manual');
    assert.ok(receipt?.role === 'toolResult' && receipt.content[0]?.type === 'text');
    assert.equal(JSON.parse(receipt.content[0].text).status, 'applied', 'management returns the final outcome after activation');
    assert.equal(JSON.parse(receipt.content[0].text).persistence, 'not-required');
    assert.deepEqual(JSON.parse(receipt.content[0].text).runtime, host.inspect()[0]);
    assert.ok(recovered.entries.every(entry => entry.type === 'message'));
  } finally { await host.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('extension restart restores history without replay and replaces same-schema activation declarations at the next request', { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter();
  const builtIn = effectTool(async () => result); let host: ExtensionHost | undefined;
  const start = async () => {
    host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, config: fixture.config }], receive: extensionReceiver(writer) });
    await host.start(); return host;
  };
  try {
    const first = await start(); const tools = extensionManagementTools(first); let requests = 0;
    await runtime(writer, () => streamOf(++requests === 1 ? call('original-effect', 'fixture_echo', { count: 3, label: 'synthetic' }) : assistant('Original completed result')), {
      prepareTools: async () => [builtIn, ...tools, ...extensionTools(await first.prepare())], finishTools: () => first.finish(),
    }).run(input('Run the synthetic extension'));
    const saved = structuredClone(writer.state); const oldActivation = first.inspect()[0]!.activation;
    await first.close();
    const second = await start(); const newActivation = second.inspect()[0]!.activation;
    assert.notEqual(newActivation, oldActivation);
    const restored = await runtime(writer, () => { throw Error('recover must not call the model'); }).recover();
    assert.deepEqual(restored.snapshot, saved);
    assert.equal((await fixture.effects()).length, 1);
    assert.match(getCurrentTools(restored.messages).find(tool => tool.name === 'fixture_echo')!.description, new RegExp(oldActivation!));
    let prepared: AgentTool[] = []; const management = extensionManagementTools(second); let newRequests = 0;
    await runtime(writer, (_model, context) => {
      newRequests++; assertDeclarations(writer, context, prepared);
      const current = getCurrentTools(context.messages).find(tool => tool.name === 'fixture_echo'); assert.ok(current);
      assert.deepEqual(current.parameters, fixtureParameters); assert.match(current.description, new RegExp(newActivation!));
      assert.doesNotMatch(current.description, new RegExp(oldActivation!));
      assert.match(JSON.stringify(context.messages), /Original completed result/);
      return streamOf(assistant('Prior operation remains complete'));
    }, { prepareTools: async () => prepared = [builtIn, ...management, ...extensionTools(await second.prepare())], finishTools: () => second.finish() }).run(input('Continue after process-style restart'));
    assert.equal(newRequests, 1); assert.deepEqual(writer.state.executions, saved.executions);
    assert.deepEqual(writer.state.records.slice(0, saved.records.length), saved.records);
    assert.equal((await fixture.effects()).length, 1, 'old execution is never replayed');
    const deltas = decodeRecords(writer.state.records.slice(saved.records.length), saved.records.at(-1)!.id)
      .flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
    assert.equal(deltas.length, 1);
    assert.deepEqual(deltas[0]!.toolsRemoved, [{ name: 'fixture_echo' }]);
    assert.deepEqual(deltas[0]!.toolsAdded, prepared.filter(tool => tool.name === 'fixture_echo').map(toToolDeclaration));
  } finally { await host?.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('awaited configuration and disable skip unstarted stale siblings and publish current declarations', { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter(); const builtin = effectTool(async () => result);
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, config: fixture.config }], receive: extensionReceiver(writer) });
  const changedParameters = { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
  let prepared: AgentTool[] = []; let requests = 0; let changedActivation = '';
  try {
    await host.start(); const management = extensionManagementTools(host); const originalActivation = host.inspect()[0]!.activation;
    const completed = await runtime(writer, (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.ok(prepared.some(tool => tool.name === builtin.name));
      const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'fixture_echo');
      const promptText = getCurrentSystemPrompt(context.messages);
      const guidance = promptText.split('<available_capabilities>')[1]!.split('</available_capabilities>')[0]!;
      assert.equal((JSON.stringify(context.messages).match(/You are Mira\./g) ?? []).length, 1);
      if (requests === 1) {
        assert.deepEqual(declaration?.parameters, fixtureParameters);
        assert.match(guidance, /fixture_echo/); assert.match(guidance, /revision 1/); assert.doesNotMatch(guidance, /revision 2/);
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'configure-manual', name: 'extension_manage', arguments: { id: 'manual', action: 'configure', config: { ...fixture.config, revision: 2, parameters: changedParameters } } },
          { type: 'toolCall', id: 'old-sibling', name: 'fixture_echo', arguments: { count: '2', label: 'synthetic' } },
        ] });
      }
      if (requests === 2) {
        assertStale(context, 'old-sibling', originalActivation!);
        assert.ok(declaration); assert.deepEqual(declaration.parameters, changedParameters);
        assert.notEqual(host.inspect()[0]!.activation, originalActivation);
        changedActivation = host.inspect()[0]!.activation!;
        assert.match(declaration.description, /revision 2/);
        assert.match(guidance, /revision 2/); assert.doesNotMatch(guidance, /revision 1/);
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'current-effect', name: 'fixture_echo', arguments: { text: 'current generation' } },
          { type: 'toolCall', id: 'disable-manual', name: 'extension_manage', arguments: { id: 'manual', action: 'disable' } },
          { type: 'toolCall', id: 'new-sibling', name: 'fixture_echo', arguments: { text: 'replacement' } },
        ] });
      }
      assert.equal(requests, 3); assert.equal(declaration, undefined);
      assertStale(context, 'new-sibling', changedActivation);
      assert.doesNotMatch(guidance, /fixture_echo|revision 2/);
      assert.equal(host.inspect()[0]!.status, 'disabled');
      return streamOf(assistant('Configuration and disable settled before unstarted stale siblings'));
    }, {
      miraPrompt: { environmentContext: 'Synthetic real Cordis test', authorizationContext: 'Synthetic test intent', now: () => new Date('2026-10-05T12:00:00Z') },
      prepareTools: async () => prepared = [builtin, ...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
    }).run(input('Reconfigure then disable the synthetic extension'));
    assert.deepEqual(await fixture.effects(), [
      { extensionId: 'manual', revision: 2, callId: 'current-effect', arguments: { text: 'current generation' } },
    ]);
    assert.deepEqual(host.changeStatus().map(receipt => [receipt.action, receipt.status]), [['configure', 'applied'], ['disable', 'applied']]);
    assert.deepEqual(writer.state.executions.map(execution => execution.intent.callId), ['configure-manual', 'old-sibling', 'current-effect', 'disable-manual', 'new-sibling']);
    assert.ok(writer.state.executions.every(execution => execution.outcome));
    assert.deepEqual(completed.recovery.operations, [], 'stale siblings have definite durable outcomes');
    for (const execution of writer.state.executions) {
      const message = completed.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
      assert.ok(message?.role === 'toolResult'); assert.deepEqual(execution.outcome!.payload, message);
      if (execution.intent.toolName === 'extension_manage') {
        assert.ok(message.content[0]?.type === 'text');
        assert.equal(JSON.parse(message.content[0].text).status, 'applied');
      }
    }
    const changes = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'system' && (entry.message.toolsAdded || entry.message.toolsRemoved) ? [entry.message] : []);
    assert.equal(changes.length, 3);
    assert.deepEqual(changes[1]!.toolsRemoved, [{ name: 'fixture_echo' }]);
    assert.deepEqual(changes[1]!.toolsAdded?.[0]?.parameters, changedParameters);
    assert.deepEqual(changes[2]!.toolsRemoved, [{ name: 'fixture_echo' }]);
    assert.deepEqual(getCurrentTools((await runtime(writer).recover()).messages).map(tool => tool.name), [builtin.name, 'extension_inspect', 'extension_stage', 'extension_manage']);
  } finally { await host.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

for (const action of ['reload', 'remove'] as const) test(`awaited ${action} never runs or redirects an unstarted same-schema sibling`, { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter();
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, config: fixture.config }], receive: extensionReceiver(writer) });
  let prepared: AgentTool[] = []; let requests = 0;
  try {
    await host.start(); const activation = host.inspect()[0]!.activation!; const management = extensionManagementTools(host);
    const completed = await runtime(writer, (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      if (requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'manage-manual', name: 'extension_manage', arguments: { id: 'manual', action } },
        { type: 'toolCall', id: 'stale-sibling', name: 'fixture_echo', arguments: { count: 1, label: 'synthetic' } },
      ] });
      assertStale(context, 'stale-sibling', activation);
      const receipt = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'manage-manual');
      assert.ok(receipt?.role === 'toolResult' && receipt.content[0]?.type === 'text');
      assert.equal(JSON.parse(receipt.content[0].text).status, 'applied');
      assert.deepEqual(JSON.parse(receipt.content[0].text).runtime, action === 'remove' ? null : host.inspect()[0]);
      const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'fixture_echo');
      if (action === 'reload') {
        assert.ok(declaration); assert.deepEqual(declaration.parameters, fixtureParameters);
        assert.notEqual(host.inspect()[0]!.activation, activation);
        assert.doesNotMatch(declaration.description, new RegExp(activation));
        if (requests === 2) return streamOf(call('fresh-effect', 'fixture_echo', { count: 2, label: 'synthetic' }));
        assert.equal(requests, 3);
      } else {
        assert.equal(requests, 2); assert.equal(declaration, undefined); assert.deepEqual(host.inspect(), []);
      }
      return streamOf(assistant('Lifecycle change and stale sibling outcome verified'));
    }, {
      prepareTools: async () => prepared = [...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
    }).run(input(`${action} the configured synthetic extension`));
    assert.deepEqual(await fixture.effects(), action === 'reload'
      ? [{ extensionId: 'manual', revision: 1, callId: 'fresh-effect', arguments: { count: 2, label: 'synthetic' } }] : []);
    assert.deepEqual(completed.recovery.operations, []);
    assert.deepEqual(writer.state.executions.map(execution => execution.intent.callId),
      action === 'reload' ? ['manage-manual', 'stale-sibling', 'fresh-effect'] : ['manage-manual', 'stale-sibling']);
    for (const execution of writer.state.executions) {
      const message = completed.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
      assert.ok(message?.role === 'toolResult' && execution.outcome); assert.deepEqual(execution.outcome.payload, message);
    }
  } finally { await host.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('abort during awaited management cleanup leaves a possibly completed change unknown and never replays it', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-cancel-')); const writer = new MemoryWriter();
  const modulePath = path.join(root, 'extension.mjs'); const configurationFile = path.join(root, 'extensions.json');
  const effectsPath = path.join(root, 'effects.txt'); const enteredCleanup = deferred(); const releaseCleanup = deferred();
  const controller = new AbortController(); let host: ExtensionHost | undefined; let work: Promise<unknown> | undefined;
  try {
    await writeFile(effectsPath, '');
    await writeFile(modulePath, `
import { appendFile } from 'node:fs/promises';
import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
export const cleanupGate = { wait: async () => {} };
export default defineExtension({ name: 'synthetic-cancel-cleanup', apply(context, config) {
  context.onCleanup(async () => { await cleanupGate.wait(); await appendFile(config.effectsPath, 'cleanup\\n'); });
  context.registerTool({ name: 'cancel_fixture', description: 'Synthetic cancellation witness', parameters: { type: 'object' },
    async execute() { await appendFile(config.effectsPath, 'effect\\n'); return { text: 'Synthetic effect' }; } });
} });
`);
    await writeFile(configurationFile, JSON.stringify({ entries: [{ id: 'manual', path: modulePath, config: { effectsPath } }] }));
    const module = await import(pathToFileURL(modulePath).href) as { cleanupGate: { wait(): Promise<void> } };
    module.cleanupGate.wait = async () => { enteredCleanup.resolve(); await releaseCleanup.promise; };
    host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive: extensionReceiver(writer) });
    const activeHost = host; await activeHost.start(); const management = extensionManagementTools(activeHost); let requests = 0;
    const instance = runtime(writer, () => {
      requests++; assert.equal(requests, 1);
      return streamOf(call('cancel-disable', 'extension_manage', { id: 'manual', action: 'disable' }));
    }, {
      prepareTools: async () => [...management, ...extensionTools(await activeHost.prepare())], finishTools: () => activeHost.finish(),
    });
    work = instance.run(input('Disable the configured synthetic extension'), controller.signal);
    const rejected = assert.rejects(work, /cancel during cleanup/);
    await enteredCleanup.promise;
    assert.equal(writer.state.executions[0]!.intent.callId, 'cancel-disable');
    assert.equal(writer.state.executions[0]!.outcome, null);
    assert.equal((await readExtensionConfiguration(configurationFile)).entries[0]!.enabled, false, 'desired state is already saved while cleanup waits');
    controller.abort(Error('cancel during cleanup')); releaseCleanup.resolve(); await rejected;
    assert.equal(requests, 1); assert.equal(writer.signal.aborted, false, 'caller cancellation does not lose the durable writer');
    assert.equal(activeHost.inspect()[0]!.status, 'disabled');
    assert.equal(activeHost.changeStatus()[0]!.status, 'applied'); assert.equal(activeHost.changeStatus()[0]!.persistence, 'saved');
    assert.equal(await readFile(effectsPath, 'utf8'), 'cleanup\n', 'the dispatched cleanup can finish after cancellation');
    assert.equal(writer.state.executions.length, 1); assert.equal(writer.state.executions[0]!.outcome, null);
    assert.equal(decodeRecords(writer.state.records).some(entry => entry.type === 'message' && entry.message.role === 'toolResult'), false,
      'post-effect cancellation prevents publishing a definitive management outcome');
    const savedConfig = await readFile(configurationFile, 'utf8'); const savedExecutions = structuredClone(writer.state.executions);
    const recovered = await runtime(writer, () => { throw Error('Recovery cannot invoke a provider'); }).recover();
    assert.equal(recovered.recovery.operations.length, 1);
    assert.equal(recovered.recovery.operations[0]!.callId, 'cancel-disable');
    assert.equal(recovered.recovery.operations[0]!.status, 'outcome-unknown');
    let continued = 0;
    await runtime(writer, (_model, context) => {
      continued++; assert.match(JSON.stringify(context.messages), /may already have executed/);
      assert.equal(getCurrentTools(context.messages).some(tool => tool.name === 'cancel_fixture'), false);
      return streamOf(assistant('Cancellation left the dispatched management outcome unknown'));
    }, {
      prepareTools: async () => [...management, ...extensionTools(await activeHost.prepare())], finishTools: () => activeHost.finish(),
    }).run(input('Continue after the cancellation'));
    assert.equal(continued, 1); assert.deepEqual(writer.state.executions, savedExecutions);
    assert.equal(activeHost.changeStatus().length, 1, 'continuation never reissues the cancelled management call');
    assert.equal(await readFile(configurationFile, 'utf8'), savedConfig); assert.equal(await readFile(effectsPath, 'utf8'), 'cleanup\n');
  } finally {
    releaseCleanup.resolve(); await work?.catch(() => {});
    await host?.close(); await writer.close(); await rm(root, { recursive: true, force: true });
  }
});

for (const managementCall of [true, false]) test(`the model asks before extension ${managementCall ? 'management' : 'execution'} without producing a tool call`, { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter();
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, enabled: !managementCall, config: fixture.config }], receive: extensionReceiver(writer) });
  let requests = 0; let prepared: AgentTool[] = [];
  try {
    await host.start(); const management = extensionManagementTools(host);
    const recovered = await runtime(writer, (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.equal(requests, 1);
      assert.ok(prepared.some(tool => tool.name === (managementCall ? 'extension_manage' : 'fixture_echo')));
      return streamOf(assistant('Which destination did you mean?'));
    }, {
      prepareTools: async () => prepared = [...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
    }).run(input('Synthetic request requires clarification'));
    assert.equal(requests, 1); assert.deepEqual(writer.state.executions, []); assert.deepEqual(await fixture.effects(), []);
    assert.deepEqual(host.changeStatus(), []);
    assert.equal(host.inspect()[0]!.status, managementCall ? 'disabled' : 'active');
    assert.deepEqual(recovered.recovery.operations, []);
    const clarification = recovered.messages.at(-1); assert.ok(clarification?.role === 'assistant');
    assert.deepEqual(clarification.content, assistant('Which destination did you mean?').content);
  } finally { await host.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
