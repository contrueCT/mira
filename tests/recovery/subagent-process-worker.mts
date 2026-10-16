import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { PostgresPersistence } from '@mira/persistence';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { SubagentManager, createSubagentTools } from '../../apps/server/src/subagents.ts';
import { testDatabaseUrl } from '../integration/database.mts';
import { assistant, streamOf, model, input, effectTool, result } from './fixtures.mts';
const [schema, marker] = process.argv.slice(2);
const temporaryRoot = await realpath('/tmp');
if (!schema || !/^mira_test_[a-f0-9]+$/.test(schema) || !marker
  || path.dirname(path.dirname(marker)) !== temporaryRoot
  || !path.basename(path.dirname(marker)).startsWith('mira-subagent-kill-')
  || path.basename(marker) !== 'effect.txt') throw Error('Explicit isolated fixture required');
const persistence = new PostgresPersistence({ connectionString: testDatabaseUrl(), schema });
const writer = await persistence.acquire('killed-parent');
const manager = new SubagentManager({ writer, acquire: id => persistence.acquire(id), tools: () => [effectTool(async () => {
  await writeFile(marker, 'effect dispatched once');
  process.send?.({ phase: 'effect-started' });
  await new Promise(() => {});
  return result;
})], writeOverflowInput: async () => { throw Error('unused'); }, onCompletion: () => {}, onFailure: () => {} });
const stream: StreamFn = (_m, context) => {
  const system = getCurrentSystemMessage(context.messages);
  if (system && getSystemMessageText(system).includes('task-scoped worker')) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'killed-effect', name: 'effect', arguments: {} }] });
  if (context.messages.at(-1)?.role === 'toolResult') return streamOf(assistant('parent available'));
  return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'killed-spawn', name: 'subagent_spawn', arguments: { task: 'Perform isolated test work' } }] });
};
const transport = { model, streamFn: stream };
await new PiDurableRuntime({ writer, ...transport, tools: createSubagentTools(manager, transport) }).run(input('delegate fixture'));
