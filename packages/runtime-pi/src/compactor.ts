import { randomUUID } from 'node:crypto';
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { InMemoryCredentialStore, type Api, type Model } from '@earendil-works/pi-ai';
import {
  AgentSession, convertToLlm, createExtensionRuntime, CURRENT_SESSION_VERSION,
  ModelRuntime, SessionManager, SettingsManager,
  type CompactionEntry, type ResourceLoader, type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { validateMessage } from './records.ts';
import { observationText, type RecoveryOperation } from './observations.ts';

export interface CompactionOptions {
  signal?: AbortSignal;
  keepRecentTokens?: number;
  reserveTokens?: number;
  instructions?: string;
}

function emptyResources(): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}

/** Disposable SDK owns full preparation. No filesystem history, credential
 * discovery, built-in tools, extensions, copied private compaction APIs or model
 * network are used. Only the supplied stream can produce a summary. */
export async function compactSnapshot(
  miraId: string, entries: SessionEntry[], model: Model<Api>, streamFn: StreamFn,
  options: CompactionOptions = {}, recoveryOperations: RecoveryOperation[] = [],
): Promise<CompactionEntry> {
  options.signal?.throwIfAborted();
  const cwd = process.cwd();
  const manager = SessionManager.inMemory(cwd, undefined, [
    { type: 'session', version: CURRENT_SESSION_VERSION, id: miraId, timestamp: new Date().toISOString(), cwd },
    ...structuredClone(entries),
  ]);
  if (manager.getSessionFile() !== undefined) throw new Error('Compactor must remain in memory');
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // ModelRuntime has no public authContext injection. AgentSession still asks it
  // for auth even with an injected stream. A disposable unregistered provider
  // selects the public unknown-provider path, which returns before any credential,
  // environment or file resolver. Never register it (registration refreshes auth).
  const isolatedProvider = `mira-injected-compaction-${randomUUID()}`;
  if (modelRuntime.getProvider(isolatedProvider)) throw new Error('Compaction provider isolation collision');
  const isolatedModel = { ...model, provider: isolatedProvider };
  const checkedSummaryStream: StreamFn = async (selected, context, requestOptions) => {
    if (selected.provider !== isolatedProvider) throw new Error('Compaction escaped its isolated provider');
    if (requestOptions?.apiKey !== undefined || requestOptions?.headers !== undefined || requestOptions?.env !== undefined) throw new Error('Compaction unexpectedly resolved request auth');
    // The caller sees the original model in full, never the SDK-only identity.
    const summaryContext = recoveryOperations.length ? { ...context, messages: [...context.messages, { role: 'user' as const, content: `Preserve these exact outstanding execution facts in the summary.\n${observationText(recoveryOperations)}`, timestamp: Date.now() }] } : context;
    const stream = await streamFn(model, summaryContext, requestOptions);
    // The public stream result is a cached promise. Checking it does not consume
    // events or copy SDK preparation. Guard each split-turn response separately;
    // otherwise SDK boilerplate can conceal an empty summary and discard history.
    const response = await stream.result();
    options.signal?.throwIfAborted();
    if (response.role !== 'assistant') throw new Error('Compaction completion must have assistant role');
    validateMessage(response);
    if (response.stopReason !== 'stop') throw new Error(`Compaction summary is incomplete: ${response.stopReason}`);
    if (!response.content.some(block => block.type === 'text' && block.text.trim().length > 0)) throw new Error('Compaction summary contains no nonempty text');
    return stream;
  };
  const agent = new Agent({ streamFn: checkedSummaryStream, convertToLlm, initialState: { model: isolatedModel, tools: [], messages: manager.buildSessionContext().messages } });
  const session = new AgentSession({
    agent, sessionManager: manager, modelRuntime, cwd,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: options.reserveTokens ?? 512, keepRecentTokens: options.keepRecentTokens ?? 1024 }, retry: { enabled: false } }),
    resourceLoader: emptyResources(), initialActiveToolNames: [], baseToolsOverride: {},
  });
  const abort = () => session.abortCompaction();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    await session.compact(options.instructions);
    options.signal?.throwIfAborted();
    const candidate = manager.getEntries().at(-1);
    if (!candidate || candidate.type !== 'compaction' || manager.getEntries().length !== entries.length + 1) throw new Error('SDK did not produce one checkpoint');
    if (JSON.stringify(candidate).includes(isolatedProvider)) throw new Error('Compaction checkpoint contains disposable provider identity');
    return structuredClone(candidate);
  } finally {
    options.signal?.removeEventListener('abort', abort);
    session.dispose();
  }
}
