import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionTool } from '@mira/extension-sdk';
import { createFakeHost } from '@mira/extension-sdk/testing';
import extension, { greet } from '../src/index.ts';

// Derive the host input type instead of casting another extension's config.
type HostConfig = Parameters<typeof extension.apply>[1];
async function registeredTool(config: HostConfig = null): Promise<ExtensionTool> {
  const host = createFakeHost({ id: 'local-template-test' });
  await extension.apply({ mira: host.extensionContext() }, config);
  assert.equal(host.tools().length, 1);
  assert.deepEqual(host.events(), []);
  assert.deepEqual(host.wakes(), []);
  assert.deepEqual(host.receipts(), []);
  return host.tools()[0]!;
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
