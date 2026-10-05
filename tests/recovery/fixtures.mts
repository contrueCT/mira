import { createAssistantMessageEventStream, type AssistantMessageEventStream, Type, type AssistantMessage, type Model, type Api } from '@earendil-works/pi-ai';
import type { StreamFn, AgentTool } from '@earendil-works/pi-agent-core';
export const model: Model<Api> = { id: 'offline', name: 'offline', api: 'openai-responses', provider: 'offline', baseUrl: 'http://127.0.0.1:1/never', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 512 };
export function assistant(text = 'synthetic answer'): AssistantMessage { return { role: 'assistant', content: [{ type: 'text', text, textSignature: 'synthetic-signature' }], api: model.api, provider: model.provider, model: model.id, responseId: 'synthetic-response', usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: 1000 }; }
export function toolCalls(...ids: string[]): AssistantMessage { return { ...assistant(), stopReason: 'toolUse', content: ids.map(id => ({ type: 'toolCall', id, name: 'effect', arguments: {}, thoughtSignature: 'synthetic-tool-signature' })) }; }
export function streamOf(message: AssistantMessage): AssistantMessageEventStream { const stream = createAssistantMessageEventStream(); queueMicrotask(() => { if (message.stopReason === 'pending')
    throw Error('pending fixture unsupported'); if (message.stopReason === 'error' || message.stopReason === 'aborted')
    stream.push({ type: 'error', reason: message.stopReason, error: message });
else
    stream.push({ type: 'done', reason: message.stopReason, message }); }); return stream; }
export function scripted(messages: AssistantMessage[], inspect?: StreamFn): StreamFn { let i = 0; return (m, c, o) => { inspect?.(m, c, o); const message = messages[i++]; if (!message)
    return streamOf({ ...assistant(), stopReason: 'error', errorMessage: 'unexpected extra fake request' }); return streamOf(message); }; }
export function effectTool(execute: AgentTool['execute']): AgentTool { return { name: 'effect', label: 'effect', description: 'synthetic local counter only', parameters: Type.Object({}), execute, replay: 'never' }; }
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
export const result = { content: [{ type: 'text' as const, text: 'synthetic effect done' }], details: { receipt: 'synthetic' } };

import { assertRecord, type RuntimeRecord } from '@mira/context';
import type { DurableWriter, LifeEvent, RecoverySnapshot, ToolIntent, ToolOutcome, WakeReceipt } from '@mira/life';
import { encodeEntry, jsonValue, messageEntry, PiDurableRuntime, type PiRuntimeOptions } from '@mira/runtime-pi';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

/** Offline fault-injection fixture only. Never a production persistence fallback. */
export class MemoryWriter implements DurableWriter {
  readonly miraId = 'synthetic-mira';
  readonly epoch = '1';
  readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  state: RecoverySnapshot = { miraId: this.miraId, version: 0, records: [], executions: [] };
  beforeAppend?: (record: RuntimeRecord) => Promise<void>;
  beforeIntent?: (intent: ToolIntent) => Promise<void>;
  beforeOutcome?: (outcome: ToolOutcome) => Promise<void>;
  private readonly intentVersions = new Map<string, number>();
  assertActive() { this.signal.throwIfAborted(); }
  async verifyActive() { this.assertActive(); }
  async load() { this.assertActive(); return structuredClone(this.state); }
  async append(expected: number, record: RuntimeRecord, signal?: AbortSignal) {
    this.assertActive(); signal?.throwIfAborted(); await this.beforeAppend?.(record); this.assertActive(); signal?.throwIfAborted();
    assertRecord(record);
    if (expected !== this.state.version) throw Error('Context version conflict');
    if (record.parentId !== (this.state.records.at(-1)?.id ?? null)) throw Error('Parent conflict');
    this.state.records.push(structuredClone(record));
    return ++this.state.version;
  }
  async receive(_event: LifeEvent, _wake?: WakeReceipt): Promise<'inserted'> { throw new Error('Not implemented by runtime test fixture'); }
  async beginTool(expected: number, intent: ToolIntent) {
    this.assertActive(); await this.beforeIntent?.(intent); this.assertActive();
    if (expected !== this.state.version) throw Error('Context version conflict');
    if (this.state.executions.some(e => e.intent.callId === intent.callId)) throw Error('Duplicate call ID');
    this.state.executions.push({ intent: structuredClone(intent), outcome: null });
    this.intentVersions.set(intent.callId, expected);
  }
  async finishTool(outcome: ToolOutcome) {
    this.assertActive(); await this.beforeOutcome?.(outcome); this.assertActive();
    const execution = this.state.executions.find(e => e.intent.callId === outcome.callId);
    if (!execution || execution.outcome) throw Error('Invalid outcome');
    if (this.intentVersions.get(outcome.callId) !== this.state.version) throw Error('Context version advanced beyond tool intent; late outcome rejected');
    execution.outcome = structuredClone(outcome);
  }
  async close() { this.controller.abort(Error('Writer closed')); }
}

export const allow: PiRuntimeOptions['authorize'] = async () => ({ allowed: true, evidence: { user: 'synthetic-test', scope: 'synthetic-counter' } });
export const input = (text = 'synthetic request'): AgentMessage => ({ role: 'user', content: text, timestamp: 1000 });
export function runtime(writer: DurableWriter, streamFn: StreamFn = scripted([assistant()]), overrides: Partial<PiRuntimeOptions> = {}) {
  return new PiDurableRuntime({ writer, model, streamFn, authorize: allow, ...overrides });
}
export async function seed(writer: DurableWriter, messages: AgentMessage[]) {
  let state = await writer.load();
  const pending = new Map<string, ToolIntent>();
  for (const message of messages) {
    const entry = messageEntry(message, state.records.at(-1)?.id ?? null);
    const record = encodeEntry(entry);
    if (message.role === 'toolResult') {
      const intent = pending.get(message.toolCallId);
      if (!intent || intent.toolName !== message.toolName) throw Error('Seed result has no matching assistant request');
      // Match the production sequence for every sibling: begin at the current
      // version, commit exact outcome, then append its transcript result.
      await writer.beginTool(state.version, intent);
      await writer.finishTool({ callId: message.toolCallId, occurredAt: new Date(message.timestamp).toISOString(), payload: jsonValue(message) });
      pending.delete(message.toolCallId);
    }
    state.version = await writer.append(state.version, record);
    state.records.push(record);
    if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') {
      pending.set(block.id, { callId: block.id, assistantRecordId: entry.id, toolName: block.name, requestedArguments: jsonValue(block.arguments), arguments: jsonValue(block.arguments), authorization: { synthetic: true }, occurredAt: entry.timestamp });
    }
  }
}
export function compactionMessages(prefix = 'first'): AgentMessage[] {
  return [
    { role: 'system', content: `Synthetic ${prefix} system`, timestamp: 1000 },
    input('Older discussion '.repeat(100)), assistant('Earlier response '.repeat(100)),
    input('Latest question'),
    toolCalls(`${prefix}-a`, `${prefix}-b`),
    { role: 'toolResult', toolCallId: `${prefix}-a`, toolName: 'effect', content: [{ type: 'text', text: 'record-A '.repeat(80) }], isError: false, timestamp: 1001 },
    { role: 'toolResult', toolCallId: `${prefix}-b`, toolName: 'effect', content: [{ type: 'text', text: 'record-B '.repeat(80) }], isError: false, timestamp: 1002 },
  ];
}

export function overrideWriter(writer: DurableWriter, overrides: Partial<DurableWriter>): DurableWriter {
  return {
    miraId: writer.miraId, epoch: writer.epoch, signal: writer.signal,
    assertActive: writer.assertActive.bind(writer), verifyActive: writer.verifyActive.bind(writer),
    load: writer.load.bind(writer), append: writer.append.bind(writer), receive: writer.receive.bind(writer),
    beginTool: writer.beginTool.bind(writer), finishTool: writer.finishTool.bind(writer), close: writer.close.bind(writer),
    ...overrides,
  };
}
