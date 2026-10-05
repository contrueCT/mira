import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { ExtensionTool, Json } from '@mira/extension-sdk';

export const fixtureParameters: ExtensionTool['parameters'] = {
  type: 'object', properties: { count: { type: 'number', minimum: 1 }, label: { type: 'string', enum: ['synthetic'] } },
  required: ['count', 'label'], additionalProperties: false,
};

/** Real trusted local module loaded by Cordis. Files are synthetic effect/receipt
 * witnesses, never production state or an alternative durable runtime writer. */
export async function createExtensionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-runtime-'));
  const modulePath = path.join(root, 'fixture.mjs');
  const effectsPath = path.join(root, 'effects.jsonl');
  const receiptsPath = path.join(root, 'receipts.jsonl');
  await writeFile(effectsPath, ''); await writeFile(receiptsPath, '');
  await writeFile(modulePath, `
import { appendFile } from 'node:fs/promises';
import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
export default defineExtension({
  name: 'synthetic-runtime-fixture',
  async apply(context, config) {
    for (const item of config.startup ?? []) {
      const receipt = item.wake
        ? await context.requestWake({ ...item.wake, event: item.event })
        : await context.emitEvent(item.event);
      await appendFile(config.receiptsPath, JSON.stringify({ extensionId: context.id, eventId: item.event.id, receipt }) + '\\n');
    }
    context.registerTool({
      name: config.toolName ?? 'fixture.echo',
      description: 'Synthetic echo revision ' + (config.revision ?? 1),
      parameters: config.parameters ?? ${JSON.stringify(fixtureParameters)},
      async execute(args, execution) {
        execution.signal.throwIfAborted();
        const witness = { extensionId: context.id, revision: config.revision ?? 1, callId: execution.callId, arguments: args };
        await appendFile(config.effectsPath, JSON.stringify(witness) + '\\n');
        for (const item of config.wakeOnExecute ?? []) await context.requestWake({ ...item.wake, event: item.event });
        return { text: 'Synthetic extension result ' + JSON.stringify(witness), details: witness };
      },
    });
  },
});
`);
  return {
    root, modulePath, effectsPath, receiptsPath,
    config: { effectsPath, receiptsPath } satisfies Json,
    async effects(): Promise<Array<{ extensionId: string; revision: number; callId: string; arguments: Json }>> {
      return (await readFile(effectsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async receipts(): Promise<Array<{ extensionId: string; eventId: string; receipt: 'inserted' | 'duplicate' }>> {
      return (await readFile(receiptsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
  };
}
