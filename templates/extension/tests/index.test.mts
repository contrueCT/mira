import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext, ExtensionTool } from '@mira/extension-sdk';
import extension, { greet } from '../src/index.ts';

const unexpected = (): never => { throw new Error('The greeting uses no other host capabilities'); };
// Derive the host input type instead of casting another extension's config.
type HostConfig = Parameters<typeof extension.apply>[1];
async function registeredTool(config: HostConfig = null): Promise<ExtensionTool> {
  const tools: ExtensionTool[] = [];
  const context: ExtensionContext = {
    privateDirectory: null, registerSettings: unexpected, credentials: {get: unexpected, has: unexpected, set: unexpected, delete: unexpected},
    schedules: { create: unexpected, get: unexpected, list: unexpected, replace: unexpected, cancel: unexpected },
    id: 'local-template-test', registerToolset: unexpected, registerTool: tool => { tools.push(tool); }, registerContextProvider: unexpected,
    emitEvent: unexpected, requestWake: unexpected, provideService: unexpected,
    service: unexpected, onCleanup: unexpected, onEvent: unexpected,
    publish: unexpected, interval: unexpected,
  };
  await extension.apply({ mira: context }, config);
  assert.equal(tools.length, 1);
  return tools[0]!;
}

test('greeting is ordinary TypeScript', () => {
  assert.equal(greet('Mira'), 'Hello, Mira!');
});

test('the public SDK registers an executable tool', async () => {
  const tool = await registeredTool();
  assert.equal(tool.name, 'hello_world');
  assert.deepEqual(await tool.execute({ name: 'Mira' }, {
    callId: 'synthetic-call', signal: new AbortController().signal,
  }), { text: 'Hello, Mira!' });
});

test('the tool rejects malformed arguments', async () => {
  const tool = await registeredTool();
  await assert.rejects(tool.execute({ name: 42 }, {
    callId: 'synthetic-invalid-call', signal: new AbortController().signal,
  }), /name must be a string/);
});
