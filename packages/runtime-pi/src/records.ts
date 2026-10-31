import { randomUUID } from 'node:crypto';
import { assertRecord, type Json, type RuntimeRecord } from '@mira/context';
import type { AgentMessage, AgentToolResult } from '@earendil-works/pi-agent-core';
import type { SystemMessage } from '@earendil-works/pi-ai';
import { validateWakeInputArtifact, type WakeInputArtifact } from '@mira/cognition';
import { messageAttachments } from './attachments.ts';
import { checkpointReplyIndex, messageReplySources, messageReplies, replyPublication } from './replies.ts';
import { validateObservation } from './observations.ts';
import { RUNTIME_STATUS_FIELD, validRuntimeStatus } from './foreground.ts';
import { validateMiraPromptSnapshot } from './system-prompt.ts';
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';

export const PI_RUNTIME_VERSION = '1.0.2';
/** Only the validator mints these tags; result diagnostics never parse an
 * arbitrary tool exception's message to guess what failed. */
export class RuntimeJsonError extends Error {
  readonly #category: 'invalid-json-result' | 'non-finite-result';
  constructor(message: string, category: 'invalid-json-result' | 'non-finite-result' = 'invalid-json-result') {
    super(message); this.name = 'RuntimeJsonError'; this.#category = category;
  }
  static categoryOf(error: unknown): 'invalid-json-result' | 'non-finite-result' | undefined {
    return typeof error === 'object' && error !== null && #category in error ? error.#category : undefined;
  }
}

/** Pi's optional undefined properties have no JSON representation. Every defined
 * JSON field, including provider opaque fields, survives without a field whitelist. */
export function jsonValue(value: unknown): Json {
  const clean = (item: unknown, ancestors: Set<object>): Json => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new RuntimeJsonError('Non-JSON nonfinite runtime number', 'non-finite-result');
      return item;
    }
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw new RuntimeJsonError('Non-JSON runtime value');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new RuntimeJsonError('Non-plain runtime value');
    if (Object.getOwnPropertySymbols(item).length) throw new RuntimeJsonError('Non-JSON symbol key');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new RuntimeJsonError('Non-JSON sparse or extended array');
    const next = new Set(ancestors).add(item);
    if (Array.isArray(item)) return Array.from(item, child => clean(child, next));
    const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const [key, child] of Object.entries(item)) if (child !== undefined) result[key] = clean(child, next);
    return result;
  };
  return JSON.parse(JSON.stringify(clean(value, new Set()))) as Json;
}

/** Snapshot a tool's supported fields before Pi reads isError or constructs a
 * synthetic error. Read each root field once, including non-enumerable SDK
 * fields, then return ordinary JSON so Pi cannot reread mutable accessors. */
export function normalizeToolResult(value: unknown): AgentToolResult {
  if (!object(value)) {
    // Preserve the specific non-finite category even for an invalid root number.
    jsonValue(value);
    throw new RuntimeJsonError('Invalid Pi tool result object');
  }
  const prototype = Object.getPrototypeOf(value);
  if ((prototype !== Object.prototype && prototype !== null) || Object.getOwnPropertySymbols(value).length)
    throw new RuntimeJsonError('Non-plain or symbol-keyed Pi tool result');
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const keys = new Set([...Object.keys(value), 'content', 'details', 'structuredContent', 'usage', 'isError', 'terminate']);
  for (const key of keys) snapshot[key] = value[key];
  const result = jsonValue(snapshot) as Record<string, Json>;
  // Pi 1.0.2 supports ordinary untyped results with absent/null content.
  result['content'] ??= [];
  for (const key of ['isError', 'terminate']) if (result[key] !== undefined && typeof result[key] !== 'boolean')
    throw new RuntimeJsonError('Invalid Pi tool result boolean');
  validateMessage({ role: 'toolResult', toolCallId: 'validation', toolName: 'validation', timestamp: 0,
    content: result['content'], usage: result['usage'], isError: result['isError'] ?? false });
  return result as unknown as AgentToolResult;
}

export function encodeEntry(entry: SessionEntry): RuntimeRecord {
  const payload = jsonValue(entry);
  const record: RuntimeRecord = {
    formatVersion: 1, runtime: 'pi', runtimeVersion: PI_RUNTIME_VERSION,
    id: entry.id, parentId: entry.parentId,
    kind: entry.type === 'compaction' ? 'checkpoint' : 'message',
    occurredAt: entry.timestamp, payload,
  };
  decodeRecords([record], entry.parentId);
  return record;
}

/** v1 supports the original linear message/checkpoint stream and the explicitly
 * versioned mira.recovery-observation.v1 custom-message extension. Unknown
 * entry kinds or runtime/envelope versions require an explicit migration. */
export function decodeRecords(records: readonly RuntimeRecord[], initialParent: string | null = null): SessionEntry[] {
  const entries: SessionEntry[] = [];
  const seen = new Set<string>();
  let parentId = initialParent;
  for (const record of records) {
    assertRecord(record);
    if (record.runtime !== 'pi' || record.runtimeVersion !== PI_RUNTIME_VERSION) throw new Error('Unsupported Pi runtime version: migration required');
    const entry = structuredClone(record.payload) as unknown as SessionEntry;
    if (!entry || typeof entry !== 'object' || !['message', 'compaction', 'custom_message'].includes(entry.type)) throw new Error('Unsupported Pi entry');
    if (seen.has(record.id) || record.parentId !== parentId || entry.id !== record.id || entry.parentId !== record.parentId || entry.timestamp !== record.occurredAt) throw new Error('Broken Pi record chain');
    if ((entry.type === 'compaction' ? 'checkpoint' : 'message') !== record.kind) throw new Error('Pi record kind mismatch');
    checkpointAttachmentIndex(entry);
    checkpointReplyIndex(entry);
    if (entry.type !== 'compaction' && Object.hasOwn(entry, 'miraMemoryConfigured')) throw new Error('Invalid Memory configuration marker placement');
    if (entry.type === 'message') {
      validateMessage(entry.message);
    } else if (entry.type === 'custom_message') {
      validateObservation(entry);
    } else if (entry.type === 'compaction') {
      if (typeof entry.summary !== 'string' || entry.summary.trim().length === 0 || typeof entry.firstKeptEntryId !== 'string' || !Number.isFinite(entry.tokensBefore)) throw new Error('Invalid Pi checkpoint');
      if (entry.systemMessage !== undefined) {
        validateMessage(entry.systemMessage);
        if (entry.systemMessage.role !== 'system' || Object.hasOwn(entry.systemMessage, 'miraMemory') || Object.hasOwn(entry.systemMessage, 'miraPrompt') || Object.hasOwn(entry.systemMessage, 'miraMemoryConfigured')) throw new Error('Invalid checkpoint system message');
      }
      const checkpoint = entry as typeof entry & { miraMemory?: unknown; miraMemoryConfigured?: unknown; miraPrompt?: unknown };
      if ((Object.hasOwn(checkpoint, 'miraMemory') || Object.hasOwn(checkpoint, 'miraMemoryConfigured')) && (typeof checkpoint.miraMemory !== 'string' || typeof checkpoint.miraMemoryConfigured !== 'boolean' || (!checkpoint.miraMemoryConfigured && checkpoint.miraMemory !== ''))) throw new Error('Invalid checkpoint Memory snapshot');
      if (checkpoint.miraPrompt !== undefined) {
        if (typeof checkpoint.miraMemory !== 'string') throw new Error('Missing checkpoint Memory snapshot');
        validateMiraPromptSnapshot(checkpoint.miraPrompt, entry.systemMessage);
        if (checkpoint.miraPrompt.values.MEMORY_STATE !== checkpoint.miraMemory) throw new Error('Checkpoint prompt does not use current Memory snapshot');
      }
    }
    entries.push(entry);
    seen.add(record.id);
    parentId = record.id;
  }
  return entries;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function validateUsage(value: unknown): void {
  if (!object(value) || !object(value['cost'])) throw new Error('Invalid Pi usage');
  const cost = value['cost'];
  if (
      !['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].every(key => typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0) ||
      !['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(key => typeof cost[key] === 'number' && Number.isFinite(cost[key]) && cost[key] >= 0)) throw new Error('Invalid Pi usage');
}
/** Derived attachment index is an ordinary immutable file in the existing spool. */
export function checkpointAttachmentIndex(value: unknown): WakeInputArtifact | undefined {
  if (!object(value) || !Object.hasOwn(value, 'miraAttachmentIndex')) return undefined;
  if (value['type'] !== 'compaction') throw new Error('Attachment index requires a checkpoint');
  validateWakeInputArtifact(value['miraAttachmentIndex']);
  return value['miraAttachmentIndex'];
}
/** Optional typed pointer to the existing Wake spool, never inferred from text. */
export function messageOverflowInput(value: unknown): WakeInputArtifact | undefined {
  if (!object(value) || !Object.hasOwn(value, 'miraOverflowInput')) return undefined;
  if (value['role'] !== 'user') throw new Error('Wake overflow input requires a user message');
  validateWakeInputArtifact(value['miraOverflowInput']);
  return value['miraOverflowInput'];
}
/** Validate required provider-facing structure without dropping unknown JSON fields. */
export function validateMessage(value: unknown): asserts value is AgentMessage {
  if (!object(value) || typeof value['role'] !== 'string' || !['system', 'user', 'assistant', 'toolResult'].includes(value['role']) || typeof value['timestamp'] !== 'number' || !Number.isFinite(value['timestamp'])) throw new Error('Unsupported Pi message');
  const role = value['role'];
  if (Object.hasOwn(value, 'miraParentInstruction')) {
    const source = value['miraParentInstruction'];
    if (role !== 'user' || !object(source) || Object.keys(source).sort().join(',') !== 'callId,turnId'
      || typeof source['turnId'] !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(source['turnId'])
      || (!nonempty(source['callId']) || new TextEncoder().encode(source['callId']).byteLength > 32768))
      throw new Error('Invalid parent instruction provenance');
  }
  messageAttachments(value);
  messageReplySources(value);
  messageReplies(value);
  replyPublication(value);
  messageOverflowInput(value);
  if (Object.hasOwn(value, RUNTIME_STATUS_FIELD) && (role !== 'user' || !validRuntimeStatus(value[RUNTIME_STATUS_FIELD])
    || typeof value['content'] !== 'string' || !value['content'].endsWith(`\n\n${value[RUNTIME_STATUS_FIELD]}`))) throw new Error('Invalid runtime status placement');
  if (Object.hasOwn(value, 'miraNativeVideos')) throw new Error('Hydrated media must never be persisted');
  if (role !== 'system' && (Object.hasOwn(value, 'miraMemory') || Object.hasOwn(value, 'miraPrompt') || Object.hasOwn(value, 'miraMemoryConfigured'))) throw new Error('Invalid Mira metadata placement');
  const content = value['content'];
  if (typeof content !== 'string' || (role !== 'user' && role !== 'system')) {
    if (!Array.isArray(content)) throw new Error('Invalid Pi message content');
    for (const block of content) {
      if (!object(block)) throw new Error('Invalid Pi content block');
      const kind = block['type'];
      if (kind === 'text' && typeof block['text'] === 'string') continue;
      if (kind === 'image' && (role === 'user' || role === 'toolResult') && typeof block['data'] === 'string' && nonempty(block['mimeType'])) continue;
      if (kind === 'thinking' && role === 'assistant' && typeof block['thinking'] === 'string') continue;
      if (kind === 'toolCall' && role === 'assistant' && nonempty(block['id']) && nonempty(block['name']) && object(block['arguments'])) continue;
      throw new Error('Unsupported Pi content block');
    }
  }
  if (role === 'system') {
    if ((Object.hasOwn(value, 'miraMemory') || Object.hasOwn(value, 'miraMemoryConfigured')) && (typeof value['miraMemory'] !== 'string' || typeof value['miraMemoryConfigured'] !== 'boolean' || (!value['miraMemoryConfigured'] && value['miraMemory'] !== ''))) throw new Error('Invalid initial Memory snapshot');
    if (value['miraPrompt'] !== undefined) validateMiraPromptSnapshot(value['miraPrompt'], value as unknown as SystemMessage);
    if (value['sections'] !== undefined && (!object(value['sections']) || !Object.values(value['sections']).every(section => section === null || typeof section === 'string'))) throw new Error('Invalid system sections');
    if (value['toolsAdded'] !== undefined && (!Array.isArray(value['toolsAdded']) || !value['toolsAdded'].every(tool => object(tool) && nonempty(tool['name']) && typeof tool['description'] === 'string' && object(tool['parameters'])))) throw new Error('Invalid system tools');
    if (value['toolsRemoved'] !== undefined && (!Array.isArray(value['toolsRemoved']) || !value['toolsRemoved'].every(tool => object(tool) && nonempty(tool['name'])))) throw new Error('Invalid removed tools');
  }
  if (role === 'assistant') {
    if (!nonempty(value['api']) || !nonempty(value['provider']) || !nonempty(value['model']) || typeof value['stopReason'] !== 'string' || !['stop', 'length', 'toolUse', 'error', 'aborted'].includes(value['stopReason'])) throw new Error('Invalid completed assistant metadata');
    validateUsage(value['usage']);
  }
  if (role === 'toolResult') {
    if (!nonempty(value['toolCallId']) || !nonempty(value['toolName']) || typeof value['isError'] !== 'boolean') throw new Error('Invalid tool result');
    if (value['usage'] !== undefined) validateUsage(value['usage']);
  }
}

export function messageEntry(message: AgentMessage, parentId: string | null): SessionMessageEntry {
  return { type: 'message', id: randomUUID(), parentId, timestamp: new Date().toISOString(), message: jsonValue(message) as unknown as AgentMessage };
}
