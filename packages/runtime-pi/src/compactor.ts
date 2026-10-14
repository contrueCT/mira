import { randomUUID } from 'node:crypto';
import { Agent, type StreamFn } from '@earendil-works/pi-agent-core';
import { InMemoryCredentialStore, normalizeContext, type Api, type Model } from '@earendil-works/pi-ai';
import {
  AgentSession, convertToLlm, createExtensionRuntime, CURRENT_SESSION_VERSION,
  ModelRuntime, SessionManager, SettingsManager, createSyntheticSourceInfo,
  type CompactionEntry, type ResourceLoader, type SessionEntry, type Extension, type SessionBeforeCompactEvent, type SessionBeforeCompactResult,
} from '@earendil-works/pi-coding-agent';
import { compactionThinkingLevel } from './reasoning.ts';
import { estimateRequestTokens } from './budget.ts';
import { validateMessage } from './records.ts';
import { type RecoveryOperation } from './observations.ts';
import { compactionInput, MIRA_COMPACTION_MODES, MIRA_COMPACTION_PROMPT, TASK_COMPACTION_PROMPT, type CompactionReferences } from './compaction-prompt.ts';

export interface CompactionOptions {
  signal?: AbortSignal;
  keepRecentTokens?: number;
  reserveTokens?: number;
  instructions?: string;
}

function compactionResources(handler: (event: SessionBeforeCompactEvent) => Promise<SessionBeforeCompactResult>): ResourceLoader {
  const path = '<inline:mira-compaction>';
  const extension: Extension = { path, resolvedPath: path, sourceInfo: createSyntheticSourceInfo(path, { source: 'inline' }),
    handlers: new Map([['session_before_compact', [async (...args: unknown[]) => handler(args[0] as SessionBeforeCompactEvent)]]]),
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(),
  };
  const extensions = { extensions: [extension], errors: [], runtime: createExtensionRuntime() };
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
 * discovery, built-in tools, external extensions, copied private APIs or model
 * network are used. Only the supplied stream can produce a summary. */
export async function compactSnapshot(
  miraId: string, entries: SessionEntry[], model: Model<Api>, streamFn: StreamFn,
  options: CompactionOptions = {}, recoveryOperations: RecoveryOperation[] = [], references: CompactionReferences = { personaContext: null, memorySnapshot: null }, checkpointId: string = randomUUID(),
): Promise<CompactionEntry> {
  options.signal?.throwIfAborted();
  for (const value of [options.reserveTokens ?? 512, options.keepRecentTokens ?? 1024]) if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid compaction token setting');
  const cwd = process.cwd();
  const manager = SessionManager.inMemory(cwd, undefined, [
    { type: 'session', version: CURRENT_SESSION_VERSION, id: miraId, timestamp: new Date().toISOString(), cwd },
    ...structuredClone(entries),
  ]);
  if (manager.getSessionFile() !== undefined) throw new Error('Compactor must remain in memory');
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // The custom hook calls only our injected stream, bypassing SDK auth lookup.
  // Keep the disposable model unregistered as defense in depth; the Agent stream
  // below rejects any accidental stock fallback before it can reach transport.
  const isolatedProvider = `mira-injected-compaction-${randomUUID()}`;
  if (modelRuntime.getProvider(isolatedProvider)) throw new Error('Compaction provider isolation collision');
  const isolatedModel = { ...model, provider: isolatedProvider };
  let compactionFailure: unknown;
  // The public hook owns only summary text; Pi still owns preparation, boundary,
  // system preservation and checkpoint construction. Never invoke stock prompts.
  const summarize = async (event: SessionBeforeCompactEvent): Promise<SessionBeforeCompactResult> => {
    try {
      options.signal?.throwIfAborted();
      event.signal.throwIfAborted();
      const maxTokens = Math.min(options.reserveTokens ?? 512, model.maxTokens);
      const input = compactionInput(event, references, maxTokens, recoveryOperations);
      const systemPrompt = (references.scope === 'task' ? TASK_COMPACTION_PROMPT : MIRA_COMPACTION_PROMPT) + '\n' + MIRA_COMPACTION_MODES[input.mode] +
        (options.instructions ? `\n\nAdditional focus: ${options.instructions}` : '');
      const context = normalizeContext({ systemPrompt, messages: [{ role: 'user', content: JSON.stringify(input), timestamp: Date.now() }] });
      if (estimateRequestTokens(context.messages) + maxTokens > model.contextWindow) throw new Error('Compaction summary request exceeds model context budget');
      // The caller sees the original model, no SDK auth lookup/provider routing.
      const thinkingLevel = compactionThinkingLevel(model);
      const stream = await streamFn(model, context, { ...(thinkingLevel === 'off' ? {} : { reasoning: thinkingLevel }), signal: event.signal, maxTokens, cacheRetention: 'none' });
      const response = await stream.result();
      options.signal?.throwIfAborted();
      event.signal.throwIfAborted();
      if (response.role !== 'assistant') throw new Error('Compaction completion must have assistant role');
      validateMessage(response);
      if (response.stopReason !== 'stop') throw new Error(`Compaction summary is incomplete: ${response.stopReason}`);
      if (response.content.some(block => block.type === 'toolCall')) throw new Error('Compaction summary attempted a tool call');
      const summary = response.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (!summary.trim()) throw new Error('Compaction summary contains no nonempty text');
      return { compaction: { summary, firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore, usage: response.usage,
        details: { readFiles: [...event.preparation.fileOps.read].filter(file => !event.preparation.fileOps.written.has(file) && !event.preparation.fileOps.edited.has(file)).sort(),
          modifiedFiles: [...new Set([...event.preparation.fileOps.written, ...event.preparation.fileOps.edited])].sort() },
      } };
    } catch (error) {
      // Pi swallows extension throws and otherwise falls back to stock prompts.
      // Return cancellation and rethrow the original failure outside the SDK.
      compactionFailure = error;
      return { cancel: true };
    }
  };
  const agent = new Agent({ streamFn: () => { throw new Error('Unexpected default SDK compaction fallback'); }, convertToLlm,
    initialState: { model: isolatedModel, tools: [], messages: manager.buildSessionContext().messages } });
  const session = new AgentSession({
    agent, sessionManager: manager, modelRuntime, cwd,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: options.reserveTokens ?? 512, keepRecentTokens: options.keepRecentTokens ?? 1024 }, retry: { enabled: false } }),
    resourceLoader: compactionResources(summarize), initialActiveToolNames: [], baseToolsOverride: {},
  });
  const abort = () => session.abortCompaction();
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    options.signal?.throwIfAborted();
    try { await session.compact(); } catch (error) { throw compactionFailure ?? error; }
    if (compactionFailure) throw compactionFailure;
    options.signal?.throwIfAborted();
    const candidate = manager.getEntries().at(-1);
    if (!candidate || candidate.type !== 'compaction' || manager.getEntries().length !== entries.length + 1) throw new Error('SDK did not produce one checkpoint');
    if (JSON.stringify(candidate).includes(isolatedProvider)) throw new Error('Compaction checkpoint contains disposable provider identity');
    // Pi allocates short session-local IDs. Only this newly created candidate
    // receives the planned History UUID; all parent/first-kept references still address
    // the untouched durable entries supplied above. The manager is disposable.
    return { ...structuredClone(candidate), id: checkpointId };
  } finally {
    options.signal?.removeEventListener('abort', abort);
    session.dispose();
  }
}
