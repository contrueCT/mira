import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { ExtensionHost } from '@mira/extension-host';
import { extensionTools } from '@mira/server';
import { toolName } from '../../packages/mcp-plugin/src/client.ts';
import { assistant, input, MemoryWriter, runtime, streamOf } from '../recovery/fixtures.mts';
for (const remoteTool of ['known_error', 'unknown_after_effect']) test(`real MCP ${remoteTool} preserves durable known/unknown boundary without replay`, { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-runtime-')));
  const marker = path.join(root, 'effects'); const configurationFile = path.join(root, 'extensions.json');
  const entries = [{ id: 'mcp', path: path.resolve('packages/mcp-plugin/src/index.ts'), config: { command: process.execPath, argsJson: JSON.stringify([path.resolve('tests/fixtures/mcp/server.mts'), 'legacy', marker]) } }];
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
  const writer = new MemoryWriter();
  let requests = 0;
  try {
    await host.start();
    const instance = runtime(writer, (_model, context) => {
      if (++requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'mcp-effect', name: toolName('mcp', remoteTool), arguments: {} }] });
      if (remoteTool === 'known_error') {
        const result = context.messages.find(message => message.role === 'toolResult');
        assert.ok(result?.role === 'toolResult'); assert.equal(result.isError, true);
      }
      return streamOf(assistant('Synthetic result inspected, no repeat.'));
    }, { prepareTools: async () => extensionTools(await host.prepare()), finishTools: () => host.finish() });
    await instance.run(input('Perform one synthetic MCP operation'));
    const state = await writer.load();
    assert.equal(state.executions.length, 1);
    assert.equal(Boolean(state.executions[0]!.outcome), remoteTool === 'known_error');
    const before = await readFile(marker, 'utf8');
    const recovered = await runtime(writer, () => { throw Error('Recovery must not call providers'); }).recover();
    assert.equal(recovered.recovery.operations.length, remoteTool === 'known_error' ? 0 : 1);
    assert.equal(await readFile(marker, 'utf8'), before);
    if (remoteTool === 'unknown_after_effect') assert.equal(before.split('\n').filter(line => line === 'effect').length, 1);
  } finally { await host.close(); await writer.close(); await rm(root, { recursive: true, force: true }); }
});

test('generic extension result adapter preserves boolean isError and rejects an invalid flag', async () => {
  for (const flag of [false, true, 'true', null]) {
    const tools = extensionTools([{ extensionId: 'generic', activation: 'a', tool: { name: 'generic_result', description: 'Generic result', parameters: { type: 'object' }, execute: async () => ({ text: 'known', isError: flag as boolean }) } }]);
    if (typeof flag !== 'boolean') await assert.rejects(tools[0]!.execute('invalid', {}, new AbortController().signal));
    else assert.equal((await tools[0]!.execute('valid', {}, new AbortController().signal) as { isError?: boolean }).isError === true, flag);
  }
});
