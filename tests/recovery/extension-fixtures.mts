import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import type { ExtensionTool, Json } from '@mira/extension-sdk';

export const fixtureParameters: ExtensionTool['parameters'] = {
  type: 'object', properties: { count: { type: 'number', minimum: 1 }, label: { type: 'string', enum: ['synthetic'] } },
  required: ['count', 'label'], additionalProperties: false,
};

export interface LifecycleWitness {
  phase: 'apply' | 'execute' | 'cleanup';
  extensionId: string;
  revision: number;
  moduleId: string;
  activation: number;
  saved: Json;
  callId?: string;
  listeners?: number[];
}
export interface EffectWitness { extensionId: string; revision: number; callId: string; arguments: Json }

/** Real trusted local module loaded by Cordis. Files are synthetic effect/receipt
 * witnesses, never production state or an alternative durable runtime writer. */
export async function createExtensionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-runtime-'));
  const modulePath = path.join(root, 'fixture.mjs');
  const effectsPath = path.join(root, 'effects.jsonl');
  const receiptsPath = path.join(root, 'receipts.jsonl');
  const lifecyclePath = path.join(root, 'lifecycle.jsonl');
  await writeFile(effectsPath, ''); await writeFile(receiptsPath, ''); await writeFile(lifecyclePath, '');
  await writeFile(modulePath, `
import { randomUUID } from 'node:crypto';
import { appendFile, readFile } from 'node:fs/promises';
import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
const moduleId = randomUUID();
let activations = 0;
let listeners = [];
export const observers = { beforeEffect: undefined };
export default defineExtension({
  name: 'synthetic-runtime-fixture',
  async apply(context, config) {
    const activation = ++activations;
    let retired = false;
    const lifecycle = async (phase, extra = {}) => {
      if (!config.lifecyclePath) return;
      const saved = config.configurationFile
        ? JSON.parse(await readFile(config.configurationFile, 'utf8')).entries.find(entry => entry.id === context.id) ?? null
        : null;
      await appendFile(config.lifecyclePath, JSON.stringify({ phase, extensionId: context.id, revision: config.revision ?? 1, moduleId, activation, saved, ...extra }) + '\\n');
    };
    if (config.lifecyclePath) {
      await lifecycle('apply');
      context.onEvent('fixture.probe.' + context.id, () => listeners.push(activation));
      context.onCleanup(async () => { retired = true; await lifecycle('cleanup'); });
    }
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
        if (retired) throw Error('Synthetic tool executed after its resources were retired');
        const witness = { extensionId: context.id, revision: config.revision ?? 1, callId: execution.callId, arguments: args };
        await observers.beforeEffect?.(witness);
        if (config.lifecyclePath) {
          listeners = [];
          context.publish('fixture.probe.' + context.id, null);
          await lifecycle('execute', { callId: execution.callId, listeners });
        }
        await appendFile(config.effectsPath, JSON.stringify(witness) + '\\n');
        for (const item of config.wakeOnExecute ?? []) await context.requestWake({ ...item.wake, event: item.event });
        return { text: 'Synthetic extension result ' + JSON.stringify(witness), details: witness };
      },
    });
  },
});
`);
  return {
    root, modulePath, effectsPath, receiptsPath, lifecyclePath,
    config: { effectsPath, receiptsPath } satisfies Json,
    async effects(): Promise<EffectWitness[]> {
      return (await readFile(effectsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async receipts(): Promise<Array<{ extensionId: string; eventId: string; receipt: 'inserted' | 'duplicate' }>> {
      return (await readFile(receiptsPath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async lifecycle(): Promise<LifecycleWitness[]> {
      return (await readFile(lifecyclePath, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    async observeEffects(beforeEffect: (effect: EffectWitness) => Promise<void>): Promise<void> {
      const module = await import(pathToFileURL(modulePath).href) as { observers: { beforeEffect?: typeof beforeEffect } };
      module.observers.beforeEffect = beforeEffect;
    },
  };
}
