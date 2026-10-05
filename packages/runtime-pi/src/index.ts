import { isDeepStrictEqual } from 'node:util';
import { Agent, type AgentEvent, type AgentMessage, type AgentTool, type AgentToolCall, type StreamFn } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, type Api, type Model, type ToolResultMessage } from '@earendil-works/pi-ai';
import { buildSessionProjection, convertToLlm, type SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Json } from '@mira/context';
import type { DurableWriter, RecoverySnapshot, ToolExecution, WakeWriter } from '@mira/life';
import type { CognitionRuntime, CognitionTurn } from '@mira/cognition';
import { observationEntry, sameOperation, sanitizeEntries, validateObservation, withRecoveryAdvisory, type RecoveryOperation } from './observations.ts';
import { compactSnapshot, type CompactionOptions } from './compactor.ts';
import { decodeRecords, encodeEntry, jsonValue, messageEntry, validateMessage } from './records.ts';
export { decodeRecords, encodeEntry, jsonValue, messageEntry, PI_RUNTIME_VERSION } from './records.ts';
export type { CompactionOptions } from './compactor.ts';
export type { RecoveryOperation } from './observations.ts';

export type AuthorizationDecision = { allowed: true; evidence: Json } | { allowed: false; reason: string };
export interface PiRuntimeOptions {
  writer: DurableWriter;
  model: Model<Api>;
  /** Required injection. This adapter never discovers credentials or chooses a live stream. */
  streamFn: StreamFn;
  /** Required even for a synthetic tool; authorization precedes intent and execution. */
  authorize: (call: AgentToolCall, args: Json, signal: AbortSignal, context: AuthorizationContext) => Promise<AuthorizationDecision>;
  tools?: AgentTool[];
  /** Complete registry, prepared before the first request and after each settled
   * tool batch that naturally continues. Replaces tools when provided. The source
   * must retain current tool resources until this next preparation boundary. */
  prepareTools?: (signal: AbortSignal) => Promise<AgentTool[]>;
  /** Release the final prepared registry on every exit, including cancellation
   * or failed preparation. Cleanup never schedules an extra model request. */
  finishTools?: () => Promise<void>;
  /** Loaded only for a genuinely empty durable context, never ordinary recovery or compaction. */
  initialContext?: (signal: AbortSignal) => Promise<string>;
}
export interface AuthorizationContext {
  priorOperations: RecoveryOperation[];
  /** Narrative is evidence for policy review, never permission by itself. */
  assistantNarrative: string;
}
export interface RecoveredContext {
  snapshot: RecoverySnapshot; entries: SessionEntry[]; messages: AgentMessage[];
  projectionEntries: SessionEntry[];
  recovery: { status: 'complete' | 'observed-incomplete'; operations: RecoveryOperation[] };
}
class ToolInterruptionError extends Error { override name = 'ToolInterruptionError'; }

export class RecoveryBlockedError extends Error {
  override name = 'RecoveryBlockedError';
}

/** A runtime instance is discarded after any failed operation. PostgreSQL, not
 * Agent memory, remains authoritative. Tool effects are strictly sequential. */
export class PiDurableRuntime implements CognitionRuntime {
  private readonly options: PiRuntimeOptions;
  private stopped: Error | undefined;
  private busy = false;
  private agent: Agent | undefined;
  private readonly controller = new AbortController();
  private readonly deferredReasons = new Map<string, string>();

  constructor(options: PiRuntimeOptions) {
    if (typeof options.authorize !== 'function' || typeof options.streamFn !== 'function') throw new Error('Authorization and injected streamFn are required');
    validateTools(options.tools ?? []);
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

  /** Repair known outcomes exactly; record valid incomplete operations as facts.
   * Corrupt evidence still fails closed before any repair or model request. */
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
    const operations: RecoveryOperation[] = [];
    const operationFor = (id: string): RecoveryOperation => {
      const requested = calls.get(id)!;
      const execution = executions.get(id);
      if (execution?.outcome) throw new RecoveryBlockedError(`Recovery observation hides a known outcome: ${id}`);
      return { callId: id, assistantRecordId: requested.recordId, toolName: requested.call.name,
        requestedArguments: jsonValue(requested.call.arguments),
        ...(execution ? { arguments: jsonValue(execution.intent.arguments) } : {}),
        status: execution ? 'outcome-unknown' : 'not-started',
        ...(!execution && this.deferredReasons.has(id) ? { reason: this.deferredReasons.get(id)! } : {}) };
    };
    for (const [position, entry] of entries.entries()) {
      if (entry.type === 'custom_message') {
        validateObservation(entry);
        if (unresolved.length !== entry.details!.operations.length || unresolved.some((id, index) => {
          const operation = entry.details!.operations[index]!;
          const expected = operationFor(id);
          if (operation.reason !== undefined && expected.status === 'not-started') expected.reason = operation.reason;
          return (index > 0 && operation.status !== 'not-started') || !sameOperation(expected, operation);
        })) throw new RecoveryBlockedError('Recovery observation does not close the exact incomplete batch');
        operations.push(...structuredClone(entry.details!.operations));
        unresolved.length = 0;
        continue;
      }
      if (entry.type === 'compaction') {
        if (unresolved.length) throw new RecoveryBlockedError('Checkpoint intersects incomplete tool calls');
        const firstKept = entries.slice(0, position).find(e => e.id === entry.firstKeptEntryId);
        if (!firstKept || (firstKept.type !== 'message' && firstKept.type !== 'custom_message') || (firstKept.type === 'message' && firstKept.message.role === 'toolResult')) throw new RecoveryBlockedError('Checkpoint tail is missing or splits a tool pair');
        const precedingSystem = getCurrentSystemMessage(buildSessionProjection(sanitizeEntries(entries.slice(0, position), operations)).messages);
        const expectedSystem = precedingSystem ? { ...precedingSystem, timestamp: Date.parse(entry.timestamp) } : undefined;
        if (!isDeepStrictEqual(entry.systemMessage, expectedSystem)) throw new RecoveryBlockedError('Checkpoint system state differs from preceding context');
        validateProjection(buildSessionProjection(sanitizeEntries(entries.slice(0, position + 1), operations)).messages);
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
        if (unresolved.length) throw new RecoveryBlockedError('Incomplete assistant tool-call batch without recovery observation');
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
      if (!execution.outcome) continue;
      validateMessage(execution.outcome.payload);
      const saved = execution.outcome.payload as unknown as ToolResultMessage;
      if (execution.outcome.callId !== id || saved.role !== 'toolResult' || saved.toolCallId !== id || saved.toolName !== requested.call.name || !Number.isFinite(saved.timestamp) || !Array.isArray(saved.content) || typeof saved.isError !== 'boolean') throw new RecoveryBlockedError(`Invalid saved outcome: ${id}`);
      if (results.has(id) && !isDeepStrictEqual(jsonValue(results.get(id)), jsonValue(saved))) throw new RecoveryBlockedError(`Outcome/transcript mismatch: ${id}`);
    }
    for (const id of results.keys()) if (!executions.get(id)?.outcome) throw new RecoveryBlockedError(`Tool result has no execution evidence: ${id}`);
    // Sequential execution permits a prefix of saved outcomes, then at most one
    // outcome-unknown intent, then calls that never reached durable intent.
    let gap = false;
    for (const id of unresolved) {
      const execution = executions.get(id);
      if (gap && execution) throw new RecoveryBlockedError('Nonsequential execution evidence after incomplete operation');
      if (!execution?.outcome) gap = true;
    }
    const append = async (entry: SessionEntry): Promise<void> => {
      const record = encodeEntry(entry);
      snapshot.version = await this.options.writer.append(snapshot.version, record);
      this.gate(); snapshot.records.push(record); entries.push(entry);
    };
    const incomplete: RecoveryOperation[] = [];
    for (const id of unresolved) {
      const outcome = executions.get(id)?.outcome;
      if (outcome) await append(messageEntry(outcome.payload as unknown as ToolResultMessage, entries.at(-1)?.id ?? null));
      else incomplete.push(operationFor(id));
    }
    if (incomplete.length) {
      await append(observationEntry(incomplete, entries.at(-1)?.id ?? null));
      operations.push(...incomplete);
      for (const operation of incomplete) this.deferredReasons.delete(operation.callId);
    }
    const projectionEntries = sanitizeEntries(entries, operations);
    const projection = buildSessionProjection(projectionEntries);
    const observedAssistantIds = new Set(operations.map(operation => operation.assistantRecordId));
    // Pi's public converter preserves empty assistants, and injected streams need
    // not use a provider translator that drops them. Omit only shells emptied by
    // recovery from provider messages; retain every source entry and provenance ID.
    const providerMessages = projection.entries.flatMap(projected => projected.messages.filter(message =>
      !(message.role === 'assistant' && message.content.length === 0 && observedAssistantIds.has(projected.sourceEntry.id))));
    const messages = withRecoveryAdvisory(providerMessages, operations, Date.parse(entries.at(-1)?.timestamp ?? new Date(0).toISOString()));
    validateProjection(messages);
    return { snapshot, entries, projectionEntries, messages,
      recovery: { status: operations.length ? 'observed-incomplete' : 'complete', operations } };
  }

  private async initializeEmpty(current: RecoveredContext): Promise<RecoveredContext> {
    if (current.snapshot.records.length || !this.options.initialContext) return current;
    if (current.snapshot.version !== 0) throw new RecoveryBlockedError('Empty context has a nonzero version');
    const text = await this.options.initialContext(this.controller.signal);
    await this.verified();
    if (typeof text !== 'string' || !text.trim()) throw new Error('Initial context must be nonempty text');
    const entry = messageEntry({ role: 'system', content: [{ type: 'text', text }], timestamp: Date.now() }, null);
    await this.options.writer.append(0, encodeEntry(entry), this.controller.signal);
    return this.recoverInternal();
  }

  /** External input is limited to system/user messages. Assistant/tool history
   * can only be emitted by the guarded Pi execution path. */
  appendMessage(message: AgentMessage): Promise<RecoveredContext> {
    return this.exclusive(async () => {
      if (message.role !== 'user' && message.role !== 'system') throw new Error('Only user/system input may be appended');
      const current = await this.initializeEmpty(await this.recoverInternal());
      const entry = messageEntry(message, current.entries.at(-1)?.id ?? null);
      await this.options.writer.append(current.snapshot.version, encodeEntry(entry));
      return this.recoverInternal();
    });
  }

  private wakeWriter(): WakeWriter {
    const writer = this.options.writer as WakeWriter;
    if (typeof writer.loadWakeRun !== 'function' || typeof writer.appendWakeInput !== 'function' || typeof writer.appendWakeFinal !== 'function') throw new Error('A WakeWriter is required for durable cognition turns');
    return writer;
  }

  continueTurn(turn: CognitionTurn, signal?: AbortSignal): Promise<void> {
    return this.exclusive(async () => {
      const writer = this.wakeWriter();
      const run = await writer.loadWakeRun(turn.id);
      let current = await this.initializeEmpty(await this.recoverInternal());
      const linkedInput = run.inputRecordId ? current.entries.find(entry => entry.id === run.inputRecordId) : undefined;
      if (run.inputRecordId && (linkedInput?.type !== 'message' || linkedInput.message.role !== 'user')) throw new RecoveryBlockedError('Wake input link is not a persisted user message');
      if (Date.parse(turn.occurredAt) !== Date.parse(run.claimedAt)) throw new RecoveryBlockedError('Wake input timestamp differs from its durable batch');
      if (linkedInput?.type === 'message' && linkedInput.message.role === 'user' && turn.input !== '' && (linkedInput.message.content !== turn.input || linkedInput.message.timestamp !== Date.parse(turn.occurredAt))) throw new RecoveryBlockedError('Wake input differs from its durable input; restore the original input configuration');
      if (run.finalRecordId) {
        const final = current.entries.find(entry => entry.id === run.finalRecordId);
        if (!linkedInput || final?.type !== 'message' || final.message.role !== 'assistant' || final.message.stopReason !== 'stop' || final.message.content.some(block => block.type === 'toolCall') || current.entries.indexOf(final) <= current.entries.indexOf(linkedInput)) throw new RecoveryBlockedError('Wake final link is not a successful terminal assistant message');
        return;
      }
      if (run.status !== 'running') throw new RecoveryBlockedError('Completed Wake has no final reply');
      if (!run.inputRecordId) {
        const message: AgentMessage = { role: 'user', content: turn.input, timestamp: Date.parse(turn.occurredAt) };
        const entry = messageEntry(message, current.entries.at(-1)?.id ?? null);
        await writer.appendWakeInput(turn.id, current.snapshot.version, encodeEntry(entry), this.controller.signal);
        current = await this.recoverInternal();
      }
      await this.runInternal(undefined, turn);
      const completed = await writer.loadWakeRun(turn.id);
      if (!completed.finalRecordId) throw new Error('Wake did not produce a successful terminal assistant reply');
    }, signal);
  }

  run(input?: AgentMessage, signal?: AbortSignal): Promise<RecoveredContext> {
    return this.exclusive(() => this.runInternal(input), signal);
  }

  private async runInternal(input?: AgentMessage, turn?: CognitionTurn): Promise<RecoveredContext> {
    while (true) {
      try { return await this.runAttempt(input, turn); }
      catch (error) {
        if (!(error instanceof ToolInterruptionError)) throw error;
        await this.verified();
        // The interrupted Agent is discarded. Only new model-selected calls can
        // execute; recoverInternal records the unresolved facts before that model.
        input = undefined;
      }
    }
  }

  private async runAttempt(input?: AgentMessage, turn?: CognitionTurn): Promise<RecoveredContext> {
      if (input && input.role !== 'user' && input.role !== 'system') throw new Error('Only user/system input may be prompted');
      const current = await this.initializeEmpty(await this.recoverInternal());
      let version = current.snapshot.version;
      let parentId = current.entries.at(-1)?.id ?? null;
      const executions = new Map(current.snapshot.executions.map(e => [e.intent.callId, e]));
      const issued = new Map<string, { call: AgentToolCall; recordId: string }>();
      for (const entry of current.entries) if (entry.type === 'message' && entry.message.role === 'assistant') {
        for (const block of entry.message.content) if (block.type === 'toolCall') issued.set(block.id, { call: block, recordId: entry.id });
      }
      const outcomes = new Map<string, ToolResultMessage>();
      const issuedNarrative = new Map<string, string>();
      let awaitingModelCompletion = false;
      let interruption: ToolInterruptionError | undefined;
      const attemptGate = (): void => { this.gate(); if (interruption) throw interruption; };
      const fail = (error: unknown): Error => interruption && !this.stopped ? interruption : this.stop(error);
      const continuedMessages = (state: RecoveredContext): AgentMessage[] => {
        const messages = structuredClone(state.messages);
        if (turn && messages.at(-1)?.role === 'assistant') messages.push({ role: 'user',
          content: 'Continue the current persisted Wake. Its preceding assistant response did not complete this Wake.', timestamp: Date.parse(turn.occurredAt) });
        return messages;
      };
      const wrapTools = (registry: AgentTool[]): AgentTool[] => {
        validateTools(registry);
        // Pin each executable definition for the whole request and its tool batch.
        // Later snapshots may replace/remove a name, but never alter its dispatch.
        return registry.map(source => {
          const tool = { ...source,
            name: source.name, label: source.label, description: source.description,
            execute: source.execute.bind(source),
            parameters: structuredClone(source.parameters),
            ...(source.outputSchema === undefined ? {} : { outputSchema: structuredClone(source.outputSchema) }),
            ...(source.constrainedSampling === undefined ? {} : { constrainedSampling: structuredClone(source.constrainedSampling) }),
          };
          return {
            ...tool,
            replay: 'never' as const, executionMode: 'sequential' as const,
            execute: async (id: string, args: unknown, toolSignal?: AbortSignal, update?: Parameters<AgentTool['execute']>[3]) => {
              try {
                attemptGate();
                await this.verified();
                attemptGate();
                const execution = executions.get(id);
                if (!execution || execution.outcome || outcomes.has(id)) throw new Error(`Tool has no fresh authorized intent: ${id}`);
                if (!isDeepStrictEqual(jsonValue(args), execution.intent.arguments)) throw new Error('Tool execution arguments differ from authorized intent');
                toolSignal?.throwIfAborted();
                // A throw may happen after a remote effect. Never manufacture a
                // definitive failure from it: leave durable intent unresolved.
                let result: Awaited<ReturnType<AgentTool['execute']>>;
                try { result = await tool.execute(id, args as never, toolSignal, update); }
                catch (error) {
                  // Writer loss/cancellation remains fatal. A tool throw alone proves
                  // neither failure nor success, so stop this attempt without asking
                  // Pi to publish its synthetic error result.
                  this.gate();
                  interruption = new ToolInterruptionError(error instanceof Error ? error.message : String(error));
                  this.agent?.abort();
                  throw interruption;
                }
                attemptGate();
                return result;
              } catch (error) { throw fail(error); }
            },
          } satisfies AgentTool;
        });
      };
      const staticTools = this.options.prepareTools ? undefined : wrapTools(this.options.tools ?? []);
      const prepareTools = async (): Promise<AgentTool[]> => {
        attemptGate();
        if (!this.options.prepareTools) return staticTools!;
        const registry = await this.options.prepareTools(this.controller.signal);
        await this.verified();
        attemptGate();
        return wrapTools(registry);
      };
      const refreshMessages = async (): Promise<AgentMessage[]> => {
        const state = await this.recoverInternal();
        if (state.snapshot.version !== version) throw new Error('Context changed during run');
        return continuedMessages(state);
      };
      const agent = new Agent({
        toolExecution: 'sequential', convertToLlm,
        initialState: { model: this.options.model, tools: [], messages: continuedMessages(current) },
        streamFn: async (model, context, options) => {
          try {
            attemptGate();
            await this.verified();
            awaitingModelCompletion = true;
            return await this.options.streamFn(model, context, options);
          } catch (error) { throw fail(error); }
        },
        prepareNextTurnWithContext: async (_context, signal) => {
          try {
            attemptGate();
            signal?.throwIfAborted();
            // Pi calls this only after the entire prior batch and its awaited
            // subscribers settle, before the next tool-state declaration delta.
            const tools = await prepareTools();
            const messages = await refreshMessages();
            signal?.throwIfAborted();
            return { context: { messages, tools } };
          } catch (error) { throw fail(error); }
        },
        prepareRequest: async ({ context }) => {
          try {
            attemptGate();
            // Declaration events have already been durably appended. Refresh
            // their messages, but keep exactly the registry Pi just declared.
            return { context: { messages: await refreshMessages(), tools: context.tools ?? [] } };
          } catch (error) { throw fail(error); }
        },
        beforeToolCall: async context => {
          try {
            attemptGate();
            await this.verified();
            const id = context.toolCall.id;
            if (executions.has(id)) throw new Error(`Duplicate tool-call ID: ${id}`);
            const issuedCall = issued.get(id);
            if (!issuedCall || !isDeepStrictEqual(jsonValue(context.toolCall), jsonValue(issuedCall.call))) throw new Error('Tool call differs from durably recorded assistant request');
            const args = jsonValue(context.args);
            const assistantEntry = current.entries.find(entry => entry.id === issuedCall.recordId);
            const narrative = assistantEntry?.type === 'message' && assistantEntry.message.role === 'assistant'
              ? assistantEntry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') : issuedNarrative.get(issuedCall.recordId) ?? '';
            const decision = await this.options.authorize(structuredClone(context.toolCall), args, this.controller.signal,
              { priorOperations: structuredClone(current.recovery.operations), assistantNarrative: narrative });
            attemptGate();
            if (!decision.allowed) {
              if (typeof decision.reason !== 'string' || !decision.reason.trim()) throw new Error('Deferred tool decision must include its reason');
              this.deferredReasons.set(id, decision.reason);
              interruption = new ToolInterruptionError(`Agent/application deferred operation: ${decision.reason}`);
              this.agent?.abort();
              throw interruption;
            }
            if (!isDeepStrictEqual(jsonValue(context.toolCall), jsonValue(issuedCall.call))) throw new Error('Tool call changed during authorization');
            const intent = { callId: id, assistantRecordId: issuedCall.recordId, toolName: context.toolCall.name, requestedArguments: jsonValue(context.toolCall.arguments), arguments: args, authorization: jsonValue(decision.evidence), occurredAt: new Date().toISOString() };
            await this.options.writer.beginTool(version, intent);
            attemptGate();
            executions.set(id, { intent, outcome: null });
          } catch (error) { throw fail(error); }
        },
        afterToolCall: async context => {
          try {
            attemptGate();
            const saved = jsonValue({ role: 'toolResult', toolCallId: context.toolCall.id, toolName: context.toolCall.name,
              content: context.result.content ?? [], details: context.result.details, usage: context.result.usage,
              isError: context.isError, timestamp: Date.now() }) as unknown as ToolResultMessage;
            const outcome = { callId: saved.toolCallId, occurredAt: new Date(saved.timestamp).toISOString(), payload: jsonValue(saved) };
            await this.options.writer.finishTool(outcome);
            attemptGate();
            const execution = executions.get(saved.toolCallId);
            if (!execution) throw new Error('Outcome without authorized intent');
            execution.outcome = outcome;
            outcomes.set(saved.toolCallId, saved);
          } catch (error) { throw fail(error); }
        },
      });
      // Supplying tools in the constructor can insert a system declaration only
      // in memory, without message_end. Attach the registry through public state
      // after construction so Pi's normal loop emits its declaration/change
      // events, and our awaited subscriber durably saves them before projection.
      this.agent = agent;
      const unsubscribe = agent.subscribe(async (event: AgentEvent) => {
        try {
          attemptGate();
          if (event.type === 'tool_execution_end' && !outcomes.has(event.toolCallId)) throw new Error(`Tool did not produce a durable outcome: ${event.toolCallId}`);
          if (event.type !== 'message_end') return;
          const message = event.message;
          // Input and tool-declaration message_end events precede streamFn. Once
          // a model request starts, its completion must actually be assistant;
          // generic transcript validation also accepts legitimate user/system
          // messages and cannot enforce this model-boundary invariant alone.
          if (awaitingModelCompletion) {
            if (message.role !== 'assistant') throw new Error('Model completion must have assistant role');
            awaitingModelCompletion = false;
          }
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
          const terminal = turn && message.role === 'assistant' && message.stopReason === 'stop' && !message.content.some(block => block.type === 'toolCall');
          version = terminal
            ? await this.wakeWriter().appendWakeFinal(turn.id, version, encodeEntry(entry), this.controller.signal)
            : await this.options.writer.append(version, encodeEntry(entry));
          attemptGate();
          parentId = entry.id;
          if (message.role === 'assistant') {
            if (entry.message.role !== 'assistant') throw new Error('Persisted assistant entry mismatch');
            issuedNarrative.set(entry.id, entry.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
            for (const block of entry.message.content) if (block.type === 'toolCall') issued.set(block.id, { call: structuredClone(block), recordId: entry.id });
            if (message.stopReason === 'error' || message.stopReason === 'aborted') throw new Error(message.errorMessage ?? `Model ${message.stopReason}`);
          }
        } catch (error) { throw fail(error); }
      });
      try {
        // prepareNextTurnWithContext does not run for the first request in Pi
        // 1.0.2. Prepare its snapshot once before entering the public loop.
        agent.state.tools = await prepareTools();
        if (input) await agent.prompt(structuredClone(input));
        else await agent.continue();
        attemptGate();
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        return await this.recoverInternal();
      } finally {
        unsubscribe(); this.agent = undefined;
        await this.options.finishTools?.();
      }
  }

  compact(options: CompactionOptions = {}): Promise<RecoveredContext> {
    return this.exclusive(async () => {
      const before = await this.recoverInternal();
      const checkpoint = await compactSnapshot(this.options.writer.miraId, before.projectionEntries, this.options.model,
        async (model, context, streamOptions) => {
          await this.verified();
          return this.options.streamFn(model, context, streamOptions);
        }, { ...options, signal: this.controller.signal }, before.recovery.operations);
      await this.verified();
      options.signal?.throwIfAborted();
      await this.options.writer.append(before.snapshot.version, encodeEntry(checkpoint), this.controller.signal);
      return this.recoverInternal();
    }, options.signal);
  }
}

function validateTools(tools: AgentTool[]): void {
  const names = new Set<string>();
  for (const tool of tools) {
    if (names.has(tool.name)) throw new Error(`Duplicate registered tool: ${tool.name}`);
    if (tool.prepareArguments) throw new Error('Tool prepareArguments is not supported before the authorization boundary');
    names.add(tool.name);
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
    if (message.role === 'custom') {
      if (pending.length) throw new RecoveryBlockedError('Recovery observation splits projected tool batch');
      validateObservation({ type: 'custom_message', id: 'projection', parentId: null, timestamp: new Date(message.timestamp).toISOString(), customType: message.customType, content: message.content, display: message.display, details: message.details });
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

export { createHistoryTools } from './history-tools.ts';
