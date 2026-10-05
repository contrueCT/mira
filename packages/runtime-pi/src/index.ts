import { isDeepStrictEqual } from 'node:util';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolCall, type StreamFn } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, type Api, type Model, type ToolResultMessage } from '@earendil-works/pi-ai';
import { buildSessionProjection, convertToLlm, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Json } from '@mira/context';
import type { DurableWriter, RecoverySnapshot, ToolExecution } from '@mira/life';
import { compactSnapshot, type CompactionOptions } from './compactor.ts';
import { decodeRecords, encodeEntry, jsonValue, messageEntry, validateMessage } from './records.ts';
export { decodeRecords, encodeEntry, jsonValue, messageEntry, PI_RUNTIME_VERSION } from './records.ts';
export type { CompactionOptions } from './compactor.ts';

export type AuthorizationDecision = { allowed: true; evidence: Json } | { allowed: false; reason: string };
export interface PiRuntimeOptions {
  writer: DurableWriter;
  model: Model<Api>;
  /** Required injection. This adapter never discovers credentials or chooses a live stream. */
  streamFn: StreamFn;
  /** Required even for a synthetic tool; authorization precedes intent and execution. */
  authorize: (call: AgentToolCall, args: Json, signal: AbortSignal) => Promise<AuthorizationDecision>;
  tools?: AgentTool[];
}
export interface RecoveredContext { snapshot: RecoverySnapshot; entries: SessionEntry[]; messages: AgentMessage[] }

export class RecoveryBlockedError extends Error {
  override name = 'RecoveryBlockedError';
}

/** A runtime instance is discarded after any failed operation. PostgreSQL, not
 * Agent memory, remains authoritative. Tool effects are strictly sequential. */
export class PiDurableRuntime {
  private readonly options: PiRuntimeOptions;
  private stopped: Error | undefined;
  private busy = false;
  private agent: Agent | undefined;
  private readonly controller = new AbortController();

  constructor(options: PiRuntimeOptions) {
    if (typeof options.authorize !== 'function' || typeof options.streamFn !== 'function') throw new Error('Authorization and injected streamFn are required');
    const names = new Set<string>();
    for (const tool of options.tools ?? []) {
      if (names.has(tool.name)) throw new Error(`Duplicate registered tool: ${tool.name}`);
      if (tool.prepareArguments) throw new Error('Tool prepareArguments is not supported before the authorization boundary');
      names.add(tool.name);
    }
    this.options = options;
    if (options.writer.signal.aborted) this.stop(options.writer.signal.reason ?? new Error('Writer lost'));
  }

  private stop(error: unknown): Error {
    this.stopped ??= error instanceof Error ? error : new Error(String(error));
    this.controller.abort(this.stopped);
    this.agent?.abort();
    return this.stopped;
  }

  private gate(): void {
    if (this.stopped) throw this.stopped;
    this.controller.signal.throwIfAborted();
    this.options.writer.assertActive();
  }

  private async verified(): Promise<void> {
    this.gate();
    await this.options.writer.verifyActive();
    this.gate();
  }

  private async exclusive<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.gate();
    if (this.busy) throw new Error('Runtime operation already active');
    this.busy = true;
    const abort = () => this.stop(signal?.reason ?? new Error('Runtime aborted'));
    const lost = () => this.stop(this.options.writer.signal.reason ?? new Error('Writer lost'));
    this.options.writer.signal.addEventListener('abort', lost, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    try {
      if (signal?.aborted) abort();
      this.gate();
      return await action();
    } catch (error) {
      throw this.stop(error);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.options.writer.signal.removeEventListener('abort', lost);
      this.busy = false;
      this.agent = undefined;
    }
  }

  /** Recover exact structured history; materialize only known saved outcomes.
   * Unknown outcomes and unexecuted incomplete batches require reconciliation. */
  recover(): Promise<RecoveredContext> { return this.exclusive(() => this.recoverInternal()); }

  private async recoverInternal(): Promise<RecoveredContext> {
    await this.verified();
    const snapshot = await this.options.writer.load();
    this.gate();
    const entries = decodeRecords(snapshot.records);
    const executions = new Map<string, ToolExecution>();
    for (const execution of snapshot.executions) {
      if (executions.has(execution.intent.callId)) throw new RecoveryBlockedError('Duplicate execution record');
      executions.set(execution.intent.callId, execution);
    }
    const calls = new Map<string, { call: AgentToolCall; recordId: string }>();
    const results = new Map<string, ToolResultMessage>();
    const unresolved: string[] = [];
    for (const [position, entry] of entries.entries()) {
      if (entry.type === 'compaction') {
        if (unresolved.length) throw new RecoveryBlockedError('Checkpoint intersects incomplete tool calls');
        const firstKept = entries.slice(0, position).find(e => e.id === entry.firstKeptEntryId);
        if (!firstKept || firstKept.type !== 'message' || firstKept.message.role === 'toolResult') throw new RecoveryBlockedError('Checkpoint tail is missing or splits a tool pair');
        const precedingSystem = getCurrentSystemMessage(buildSessionProjection(entries.slice(0, position)).messages);
        // Pi publishes the public replayed system state with checkpoint time.
        // Derive it through the same public API rather than maintaining a second
        // implementation of section/tool updates or silently losing foundation.
        const expectedSystem = precedingSystem ? { ...precedingSystem, timestamp: Date.parse(entry.timestamp) } : undefined;
        if (!isDeepStrictEqual(entry.systemMessage, expectedSystem)) throw new RecoveryBlockedError('Checkpoint system state differs from preceding context');
        validateProjection(buildSessionProjection(entries.slice(0, position + 1)).messages);
        continue;
      }
      if (entry.type !== 'message') throw new RecoveryBlockedError('Unsupported entry');
      const message = entry.message;
      if (message.role === 'toolResult') {
        const requested = calls.get(message.toolCallId);
        if (!requested || results.has(message.toolCallId) || unresolved[0] !== message.toolCallId || requested.call.name !== message.toolName) throw new RecoveryBlockedError('Invalid tool result structure');
        results.set(message.toolCallId, message);
        unresolved.shift();
      } else {
        if (unresolved.length) throw new RecoveryBlockedError('Incomplete assistant tool-call batch');
        if (message.role === 'assistant') {
          for (const block of message.content) if (block.type === 'toolCall') {
            if (calls.has(block.id)) throw new RecoveryBlockedError(`Duplicate tool-call ID: ${block.id}`);
            calls.set(block.id, { call: block, recordId: entry.id });
            unresolved.push(block.id);
          }
        }
      }
    }
    for (const [id, execution] of executions) {
      const requested = calls.get(id);
      if (!requested || execution.intent.assistantRecordId !== requested.recordId || execution.intent.toolName !== requested.call.name || !isDeepStrictEqual(jsonValue(execution.intent.requestedArguments), jsonValue(requested.call.arguments))) throw new RecoveryBlockedError(`Execution does not match assistant record: ${id}`);
      if (!execution.outcome) throw new RecoveryBlockedError(`Tool outcome unknown; reconciliation required: ${id}`);
      validateMessage(execution.outcome.payload);
      const saved = execution.outcome.payload as unknown as ToolResultMessage;
      if (saved.role !== 'toolResult' || saved.toolCallId !== id || saved.toolName !== requested.call.name || !Number.isFinite(saved.timestamp) || !Array.isArray(saved.content) || typeof saved.isError !== 'boolean') throw new RecoveryBlockedError(`Invalid saved outcome: ${id}`);
      if (results.has(id) && !isDeepStrictEqual(jsonValue(results.get(id)), jsonValue(saved))) throw new RecoveryBlockedError(`Outcome/transcript mismatch: ${id}`);
    }
    for (const id of results.keys()) if (!executions.get(id)?.outcome) throw new RecoveryBlockedError(`Tool result has no execution evidence: ${id}`);
    // Preflight the entire tail before publishing any repair. No partial recovery
    // is reported as safe when a later sibling has no proven outcome.
    for (const id of unresolved) if (!executions.get(id)?.outcome) throw new RecoveryBlockedError(`Incomplete tool call; reconciliation required: ${id}`);
    for (const id of unresolved) {
      const outcome = executions.get(id)!.outcome!;
      const entry = messageEntry(outcome.payload as unknown as ToolResultMessage, entries.at(-1)?.id ?? null);
      snapshot.version = await this.options.writer.append(snapshot.version, encodeEntry(entry));
      snapshot.records.push(encodeEntry(entry));
      entries.push(entry);
    }
    const messages = buildSessionProjection(entries).messages;
    validateProjection(messages);
    return { snapshot, entries, messages };
  }

  /** External input is limited to system/user messages. Assistant/tool history
   * can only be emitted by the guarded Pi execution path. */
  appendMessage(message: AgentMessage): Promise<RecoveredContext> {
    return this.exclusive(async () => {
      if (message.role !== 'user' && message.role !== 'system') throw new Error('Only user/system input may be appended');
      const current = await this.recoverInternal();
      const entry = messageEntry(message, current.entries.at(-1)?.id ?? null);
      await this.options.writer.append(current.snapshot.version, encodeEntry(entry));
      return this.recoverInternal();
    });
  }

  run(input?: AgentMessage, signal?: AbortSignal): Promise<RecoveredContext> {
    return this.exclusive(async () => {
      if (input && input.role !== 'user' && input.role !== 'system') throw new Error('Only user/system input may be prompted');
      const current = await this.recoverInternal();
      let version = current.snapshot.version;
      let parentId = current.entries.at(-1)?.id ?? null;
      const executions = new Map(current.snapshot.executions.map(e => [e.intent.callId, e]));
      const issued = new Map<string, { call: AgentToolCall; recordId: string }>();
      for (const entry of current.entries) if (entry.type === 'message' && entry.message.role === 'assistant') {
        for (const block of entry.message.content) if (block.type === 'toolCall') issued.set(block.id, { call: block, recordId: entry.id });
      }
      const outcomes = new Map<string, ToolResultMessage>();
      const tools = (this.options.tools ?? []).map(tool => ({
        ...tool,
        replay: 'never' as const, executionMode: 'sequential' as const,
        execute: async (id: string, args: unknown, toolSignal?: AbortSignal, update?: Parameters<AgentTool['execute']>[3]) => {
          try {
            await this.verified();
            const execution = executions.get(id);
            if (!execution || execution.outcome || outcomes.has(id)) throw new Error(`Tool has no fresh authorized intent: ${id}`);
            if (!isDeepStrictEqual(jsonValue(args), execution.intent.arguments)) throw new Error('Tool execution arguments differ from authorized intent');
            toolSignal?.throwIfAborted();
            // A throw may happen after a remote effect. Never manufacture a
            // definitive failure from it: leave durable intent unresolved.
            const result = await tool.execute(id, args as never, toolSignal, update);
            this.gate();
            return result;
          } catch (error) { throw this.stop(error); }
        },
      } satisfies AgentTool));
      const agent = new Agent({
        toolExecution: 'sequential', convertToLlm,
        initialState: { model: this.options.model, tools: [], messages: structuredClone(current.messages) },
        streamFn: async (model, context, options) => {
          try {
            await this.verified();
            return await this.options.streamFn(model, context, options);
          } catch (error) { throw this.stop(error); }
        },
        prepareRequest: async () => {
          try {
            const state = await this.recoverInternal();
            if (state.snapshot.version !== version) throw new Error('Context changed during run');
            return { context: { messages: structuredClone(state.messages), tools } };
          } catch (error) { throw this.stop(error); }
        },
        beforeToolCall: async context => {
          try {
            await this.verified();
            const id = context.toolCall.id;
            if (executions.has(id)) throw new Error(`Duplicate tool-call ID: ${id}`);
            const issuedCall = issued.get(id);
            if (!issuedCall || !isDeepStrictEqual(jsonValue(context.toolCall), jsonValue(issuedCall.call))) throw new Error('Tool call differs from durably recorded assistant request');
            const args = jsonValue(context.args);
            const decision = await this.options.authorize(structuredClone(context.toolCall), args, this.controller.signal);
            this.gate();
            if (!decision.allowed) throw new Error(`Tool authorization denied: ${decision.reason}`);
            if (!isDeepStrictEqual(jsonValue(context.toolCall), jsonValue(issuedCall.call))) throw new Error('Tool call changed during authorization');
            const intent = { callId: id, assistantRecordId: issuedCall.recordId, toolName: context.toolCall.name, requestedArguments: jsonValue(context.toolCall.arguments), arguments: args, authorization: jsonValue(decision.evidence), occurredAt: new Date().toISOString() };
            await this.options.writer.beginTool(version, intent);
            this.gate();
            executions.set(id, { intent, outcome: null });
          } catch (error) { throw this.stop(error); }
        },
        afterToolCall: async context => {
          try {
            this.gate();
            const saved = jsonValue({ role: 'toolResult', toolCallId: context.toolCall.id, toolName: context.toolCall.name,
              content: context.result.content ?? [], details: context.result.details, usage: context.result.usage,
              isError: context.isError, timestamp: Date.now() }) as unknown as ToolResultMessage;
            const outcome = { callId: saved.toolCallId, occurredAt: new Date(saved.timestamp).toISOString(), payload: jsonValue(saved) };
            await this.options.writer.finishTool(outcome);
            this.gate();
            const execution = executions.get(saved.toolCallId);
            if (!execution) throw new Error('Outcome without authorized intent');
            execution.outcome = outcome;
            outcomes.set(saved.toolCallId, saved);
          } catch (error) { throw this.stop(error); }
        },
      });
      // Supplying tools in the constructor can insert a system declaration only
      // in memory, without message_end. Attach the registry through public state
      // after construction so Pi's normal loop emits its declaration/change
      // events, and our awaited subscriber durably saves them before projection.
      agent.state.tools = tools;
      this.agent = agent;
      const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
        try {
          this.gate();
          if (event.type === 'tool_execution_end' && !outcomes.has(event.toolCallId)) throw new Error(`Tool did not produce a durable outcome: ${event.toolCallId}`);
          if (event.type !== 'message_end') return;
          const message = event.message;
          if (message.role === 'toolResult') {
            const saved = outcomes.get(message.toolCallId);
            if (!saved) throw new Error('Tool result without saved outcome');
            // Pi constructs this object after afterToolCall, with a fresh wall
            // clock timestamp. Canonicalize to the exact previously saved JSON.
            for (const key of Object.keys(message)) delete (message as unknown as Record<string, unknown>)[key];
            Object.assign(message, structuredClone(saved));
          }
          const entry = messageEntry(message, parentId);
          if (message.role === 'assistant') {
            const batch = new Set<string>();
            for (const block of message.content) if (block.type === 'toolCall') {
              if (issued.has(block.id) || batch.has(block.id)) throw new Error(`Duplicate tool-call ID: ${block.id}`);
              batch.add(block.id);
            }
          }
          version = await this.options.writer.append(version, encodeEntry(entry));
          this.gate();
          parentId = entry.id;
          if (message.role === 'assistant') {
            if (entry.message.role !== 'assistant') throw new Error('Persisted assistant entry mismatch');
            for (const block of entry.message.content) if (block.type === 'toolCall') issued.set(block.id, { call: structuredClone(block), recordId: entry.id });
            if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Model ${message.stopReason}`);
          }
        } catch (error) { throw this.stop(error); }
      });
      try {
        if (input) await agent.prompt(structuredClone(input));
        else await agent.continue();
        this.gate();
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        return await this.recoverInternal();
      } finally { unsubscribe(); }
    }, signal);
  }

  compact(options: CompactionOptions = {}): Promise<RecoveredContext> {
    return this.exclusive(async () => {
      const before = await this.recoverInternal();
      const checkpoint = await compactSnapshot(this.options.writer.miraId, before.entries, this.options.model,
        async (model, context, streamOptions) => {
          await this.verified();
          return this.options.streamFn(model, context, streamOptions);
        }, { ...options, signal: this.controller.signal });
      await this.verified();
      options.signal?.throwIfAborted();
      await this.options.writer.append(before.snapshot.version, encodeEntry(checkpoint), this.controller.signal);
      return this.recoverInternal();
    }, options.signal);
  }
}

/** Projection is derived by Pi, but corrupt imported checkpoints must never
 * smuggle orphan results or malformed saved system state into a provider. */
function validateProjection(messages: AgentMessage[]): void {
  const pending: Array<{ id: string; name: string }> = [];
  const calls = new Set<string>();
  for (const message of messages) {
    if (message.role === 'compactionSummary') {
      if (pending.length) throw new RecoveryBlockedError('Projection summary splits tool batch');
      continue;
    }
    validateMessage(message);
    if (message.role === 'toolResult') {
      const first = pending.shift();
      if (!first || first.id !== message.toolCallId || first.name !== message.toolName) throw new RecoveryBlockedError('Projection contains orphan or reordered tool result');
    } else {
      if (pending.length) throw new RecoveryBlockedError('Projection contains incomplete tool batch');
      if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') {
        if (calls.has(block.id)) throw new RecoveryBlockedError('Projection contains duplicate tool call');
        calls.add(block.id); pending.push({ id: block.id, name: block.name });
      }
    }
  }
  if (pending.length) throw new RecoveryBlockedError('Projection has incomplete tool calls');
}
