import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import type { AgentTool, AgentToolCall } from '@earendil-works/pi-agent-core';
import { getCurrentTools, toToolDeclaration, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { ExtensionHost } from '@mira/extension-host';
import { extensionManagementTools, extensionReceiver, extensionTools } from '@mira/server';
import { decodeRecords } from '@mira/runtime-pi';
import { assistant, effectTool, input, MemoryWriter, result, runtime, streamOf } from '../recovery/fixtures.mts';
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

test('real extension host enables a configured module within one runtime turn and persists exact authorization and outcomes', { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter();
  const builtIn = effectTool(async () => result);
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, enabled: false, config: fixture.config }],
    reservedToolNames: [builtIn.name, 'extension.manage', 'extension.inspect'], receive: extensionReceiver(writer) });
  const evidence = { source: 'synthetic user request', purpose: 'enable manual and execute its test tool' };
  const authorized: Array<{ id: string; args: unknown }> = [];
  let prepared: AgentTool[] = []; let requests = 0;
  try {
    await host.start(); assert.equal(host.inspect()[0]!.status, 'disabled');
    const management = extensionManagementTools(host);
    const instance = runtime(writer, (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.ok(prepared.some(tool => tool.name === builtIn.name), 'builtin survives each registry update');
      const extension = getCurrentTools(context.messages).find(tool => tool.name === 'fixture.echo');
      if (requests === 1) {
        assert.equal(extension, undefined);
        return streamOf(call('enable-manual', 'extension.manage', { id: 'manual', action: 'enable' }));
      }
      assert.ok(extension); assert.deepEqual(extension.parameters, fixtureParameters);
      assert.match(extension.description, /Extension "manual", activation /);
      assert.equal(host.inspect()[0]!.status, 'active');
      assert.equal(host.changeStatus()[0]!.status, 'applied');
      if (requests === 2) return streamOf(call('echo-manual', 'fixture.echo', { count: '7', label: 'synthetic' }));
      assert.equal(requests, 3);
      assert.match(JSON.stringify(context.messages), /Synthetic extension result/);
      return streamOf(assistant('Completed the configured extension in the same turn'));
    }, {
      tools: [builtIn],
      prepareTools: async () => prepared = [builtIn, ...management, ...extensionTools(await host.prepare())],
      finishTools: () => host.finish(),
      authorize: async (request, args) => {
        assert.equal(writer.state.executions.some(execution => execution.intent.callId === request.id), false);
        if (request.name === 'fixture.echo') assert.deepEqual(await fixture.effects(), [], 'authorization precedes the effect');
        authorized.push({ id: request.id, args }); return { allowed: true, evidence };
      },
    });
    const recovered = await instance.run(input('Enable the configured manual extension and use it'));
    assert.equal(requests, 3);
    assert.deepEqual(authorized, [
      { id: 'enable-manual', args: { id: 'manual', action: 'enable' } },
      { id: 'echo-manual', args: { count: 7, label: 'synthetic' } },
    ]);
    assert.deepEqual(await fixture.effects(), [{ extensionId: 'manual', revision: 1, callId: 'echo-manual', arguments: { count: 7, label: 'synthetic' } }]);
    assert.deepEqual(writer.state.executions.map(execution => execution.intent.authorization), [evidence, evidence]);
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
    assert.equal(JSON.parse(receipt.content[0].text).status, 'accepted', 'historical accepted receipt is not retroactively rewritten as applied');
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
    await runtime(writer, () => streamOf(++requests === 1 ? call('original-effect', 'fixture.echo', { count: 3, label: 'synthetic' }) : assistant('Original completed result')), {
      prepareTools: async () => [builtIn, ...tools, ...extensionTools(await first.prepare())], finishTools: () => first.finish(),
    }).run(input('Run the synthetic extension'));
    const saved = structuredClone(writer.state); const oldActivation = first.inspect()[0]!.activation;
    await first.close();
    const second = await start(); const newActivation = second.inspect()[0]!.activation;
    assert.notEqual(newActivation, oldActivation);
    const restored = await runtime(writer, () => { throw Error('recover must not call the model'); }).recover();
    assert.deepEqual(restored.snapshot, saved);
    assert.equal((await fixture.effects()).length, 1);
    assert.match(getCurrentTools(restored.messages).find(tool => tool.name === 'fixture.echo')!.description, new RegExp(oldActivation!));
    let prepared: AgentTool[] = []; const management = extensionManagementTools(second); let newRequests = 0;
    await runtime(writer, (_model, context) => {
      newRequests++; assertDeclarations(writer, context, prepared);
      const current = getCurrentTools(context.messages).find(tool => tool.name === 'fixture.echo'); assert.ok(current);
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
    assert.deepEqual(deltas[0]!.toolsRemoved, [{ name: 'fixture.echo' }]);
    assert.deepEqual(deltas[0]!.toolsAdded, prepared.filter(tool => tool.name === 'fixture.echo').map(toToolDeclaration));
  } finally { await host?.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

test('real host configuration and disable preserve every sibling executable until the batch settles', { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter(); const builtin = effectTool(async () => result);
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, config: fixture.config }], receive: extensionReceiver(writer) });
  const changedParameters = { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false };
  let prepared: AgentTool[] = []; let requests = 0;
  try {
    await host.start(); const management = extensionManagementTools(host); const originalActivation = host.inspect()[0]!.activation;
    await runtime(writer, (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      assert.ok(prepared.some(tool => tool.name === builtin.name));
      const declaration = getCurrentTools(context.messages).find(tool => tool.name === 'fixture.echo');
      if (requests === 1) {
        assert.deepEqual(declaration?.parameters, fixtureParameters);
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'configure-manual', name: 'extension.manage', arguments: { id: 'manual', action: 'configure', config: { ...fixture.config, revision: 2, parameters: changedParameters } } },
          { type: 'toolCall', id: 'old-sibling', name: 'fixture.echo', arguments: { count: '2', label: 'synthetic' } },
        ] });
      }
      if (requests === 2) {
        assert.ok(declaration); assert.deepEqual(declaration.parameters, changedParameters);
        assert.notEqual(host.inspect()[0]!.activation, originalActivation);
        assert.match(declaration.description, /revision 2/);
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'disable-manual', name: 'extension.manage', arguments: { id: 'manual', action: 'disable' } },
          { type: 'toolCall', id: 'new-sibling', name: 'fixture.echo', arguments: { text: 'replacement' } },
        ] });
      }
      assert.equal(requests, 3); assert.equal(declaration, undefined);
      assert.equal(host.inspect()[0]!.status, 'disabled');
      return streamOf(assistant('Both complete batches settled before replacement and removal'));
    }, {
      prepareTools: async () => prepared = [builtin, ...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
    }).run(input('Reconfigure then disable the synthetic extension'));
    assert.deepEqual(await fixture.effects(), [
      { extensionId: 'manual', revision: 1, callId: 'old-sibling', arguments: { count: 2, label: 'synthetic' } },
      { extensionId: 'manual', revision: 2, callId: 'new-sibling', arguments: { text: 'replacement' } },
    ]);
    assert.deepEqual(host.changeStatus().map(receipt => [receipt.action, receipt.status]), [['configure', 'applied'], ['disable', 'applied']]);
    assert.deepEqual(writer.state.executions.map(execution => execution.intent.callId), ['configure-manual', 'old-sibling', 'disable-manual', 'new-sibling']);
    assert.ok(writer.state.executions.every(execution => execution.outcome));
    const changes = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
    assert.equal(changes.length, 3);
    assert.deepEqual(changes[1]!.toolsRemoved, [{ name: 'fixture.echo' }]);
    assert.deepEqual(changes[1]!.toolsAdded?.[0]?.parameters, changedParameters);
    assert.deepEqual(changes[2]!.toolsRemoved, [{ name: 'fixture.echo' }]);
    assert.deepEqual(getCurrentTools((await runtime(writer).recover()).messages).map(tool => tool.name), [builtin.name, 'extension.inspect', 'extension.manage']);
  } finally { await host.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});

for (const managementCall of [true, false]) test(`real extension ${managementCall ? 'management' : 'execution'} deferral retains the natural-language reason without an intent or effect`, { timeout: 15_000 }, async () => {
  const fixture = await createExtensionFixture(); const writer = new MemoryWriter();
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, enabled: !managementCall, config: fixture.config }], receive: extensionReceiver(writer) });
  let requests = 0; let decisions = 0; let prepared: AgentTool[] = [];
  try {
    await host.start(); const management = extensionManagementTools(host);
    const recovered = await runtime(writer, (_model, context) => {
      requests++; assertDeclarations(writer, context, prepared);
      if (requests === 1) return streamOf(managementCall
        ? call('deferred-extension', 'extension.manage', { id: 'manual', action: 'enable' })
        : call('deferred-extension', 'fixture.echo', { count: '1', label: 'synthetic' }));
      assert.equal(requests, 2); assert.match(JSON.stringify(context.messages), /Need a destination from the user/);
      return streamOf(assistant('Which destination did you mean?'));
    }, {
      prepareTools: async () => prepared = [...management, ...extensionTools(await host.prepare())], finishTools: () => host.finish(),
      authorize: async (_request, args) => {
        decisions++;
        assert.deepEqual(args, managementCall ? { id: 'manual', action: 'enable' } : { count: 1, label: 'synthetic' });
        return { allowed: false, reason: 'Need a destination from the user' };
      },
    }).run(input('Synthetic request requires clarification'));
    assert.equal(decisions, 1); assert.deepEqual(writer.state.executions, []); assert.deepEqual(await fixture.effects(), []);
    assert.deepEqual(host.changeStatus(), []);
    assert.equal(host.inspect()[0]!.status, managementCall ? 'disabled' : 'active');
    assert.equal(recovered.recovery.operations[0]!.status, 'not-started');
    assert.equal(recovered.recovery.operations[0]!.reason, 'Need a destination from the user');
  } finally { await host.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
