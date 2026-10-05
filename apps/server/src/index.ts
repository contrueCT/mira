import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createAssistantMessageEventStream, type AssistantMessage, type Api, type Model } from '@earendil-works/pi-ai';
import type { AgentTool, StreamFn } from '@earendil-works/pi-agent-core';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { WakeLoop, type LifeEvent } from '@mira/life';
import { migrate, PostgresPersistence } from '@mira/persistence';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { writeWakeInput } from '@mira/workspace';

/** Ordinary text-file reading, scoped to the composition's explicit workspace.
 * This is a demo security boundary, not a per-operation approval interface. */
export function createReadFileTool(directory: string): AgentTool {
  const resolveFile = async (requested: string): Promise<string> => {
    const root = await realpath(directory);
    const file = await realpath(path.resolve(root, requested));
    const relative = path.relative(root, file);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw Error('File is outside the configured workspace');
    return file;
  };
  // Reuse Pi's ordinary read tool, including its existing output limits. No
  // unread-message API, special chunk reader or bespoke pagination is added.
  return createReadTool(directory, { operations: {
    access: async requested => { await resolveFile(requested); },
    readFile: async requested => {
      const file = await resolveFile(requested);
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await handle.stat()).isFile()) throw Error('Only regular text files can be read');
        return await handle.readFile();
      } finally { await handle.close(); }
    },
  } });
}

export const demoModel: Model<Api> = {
  id: 'synthetic-demo', name: 'Synthetic demo', api: 'openai-responses', provider: 'mira-synthetic',
  baseUrl: 'http://127.0.0.1:1/never-used', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_000_000, maxTokens: 512,
};
function answer(content: AssistantMessage['content'], stopReason: 'stop' | 'toolUse'): AssistantMessage {
  return { role: 'assistant', content, stopReason, api: demoModel.api, provider: demoModel.provider, model: demoModel.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() };
}
export interface DemoOptions {
  connectionString: string;
  schema: string;
  miraId: string;
  sourceDirectory: string;
  spoolDirectory: string;
  events: Array<{ event: LifeEvent; wake?: { id: string; reason: string } }>;
  maxInlineBytes?: number;
  /** Tests may inject deterministic streams; this demo never loads credentials. */
  streamFn?: StreamFn;
}
export async function runDemo(options: DemoOptions): Promise<{ completedRuns: number; modelCalls: number; miraId: string; version: number }> {
  await migrate({ connectionString: options.connectionString, schema: options.schema, direction: 'up' });
  const writer = await new PostgresPersistence({ connectionString: options.connectionString, schema: options.schema }).acquire(options.miraId);
  let modelCalls = 0;
  const stream: StreamFn = (model, context, streamOptions) => {
    modelCalls++;
    if (options.streamFn) return options.streamFn(model, context, streamOptions);
    const result = createAssistantMessageEventStream();
    queueMicrotask(() => {
      const message = answer([{ type: 'text', text: 'Synthetic provider completed this wake. No real model was called.' }], 'stop');
      result.push({ type: 'done', reason: 'stop', message });
    });
    return result;
  };
  try {
    for (const { event, wake } of options.events) await writer.receive(event, wake);
    const loop = new WakeLoop({
      writer,
      writeOverflowInput: (runId, content) => writeWakeInput({ rootDirectory: options.spoolDirectory, sourceDirectory: options.sourceDirectory, runId, content }),
      ...(options.maxInlineBytes === undefined ? {} : { maxInlineBytes: options.maxInlineBytes }),
      createRuntime: () => new PiDurableRuntime({ writer, model: demoModel, streamFn: stream,
        tools: [createReadFileTool(options.spoolDirectory)],
        // Synthetic local demo only. A product composition supplies interpretation
        // of natural-language user intent; it must never infer authority from files.
        authorize: async () => ({ allowed: true, evidence: { source: 'synthetic-demo', intent: 'read files in the configured synthetic workspace' } }),
      }),
    });
    const completedRuns = await loop.drain();
    return { completedRuns, modelCalls, miraId: writer.miraId, version: (await writer.load()).version };
  } finally { await writer.close(); }
}
