import { randomUUID } from 'node:crypto';
import { assertJson, assertRecord, type Json, type RuntimeRecord } from '@mira/context';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { validatePromptState } from './system-prompt.ts';
import { validateObservation } from './observations.ts';
import type { SessionEntry, SessionMessageEntry } from '@earendil-works/pi-coding-agent';

export const PI_RUNTIME_VERSION = '1.0.2';

/** Pi's optional undefined properties have no JSON representation. Every defined
 * JSON field, including provider opaque fields, survives without a field whitelist. */
export function jsonValue(value: unknown): Json {
  const clean = (item: unknown, ancestors: Set<object>): Json => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null || ancestors.has(item)) throw new Error('Non-JSON runtime value');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Non-plain runtime value');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('Non-JSON symbol key');
    if (Array.isArray(item) && Object.keys(item).length !== item.length) throw new Error('Non-JSON sparse or extended array');
    const next = new Set(ancestors).add(item);
    if (Array.isArray(item)) return Array.from(item, child => clean(child, next));
    const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
    for (const [key, child] of Object.entries(item)) if (child !== undefined) result[key] = clean(child, next);
    return result;
  };
  return JSON.parse(JSON.stringify(clean(value, new Set()))) as Json;
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
    assertJson(record.payload);
    const entry = structuredClone(record.payload) as unknown as SessionEntry;
    if (!entry || typeof entry !== 'object' || !['message', 'compaction', 'custom_message'].includes(entry.type)) throw new Error('Unsupported Pi entry');
    if (seen.has(record.id) || record.parentId !== parentId || entry.id !== record.id || entry.parentId !== record.parentId || entry.timestamp !== record.occurredAt) throw new Error('Broken Pi record chain');
    if ((entry.type === 'compaction' ? 'checkpoint' : 'message') !== record.kind) throw new Error('Pi record kind mismatch');
    if (entry.type === 'message') {
      validateMessage(entry.message);
    } else if (entry.type === 'custom_message') {
      validateObservation(entry);
    } else if (entry.type === 'compaction') {
      if (typeof entry.summary !== 'string' || entry.summary.trim().length === 0 || typeof entry.firstKeptEntryId !== 'string' || !Number.isFinite(entry.tokensBefore)) throw new Error('Invalid Pi checkpoint');
      if (entry.systemMessage !== undefined) { validateMessage(entry.systemMessage); if (entry.systemMessage.role !== 'system') throw new Error('Invalid checkpoint system message'); }
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
/** Validate required provider-facing structure without dropping unknown JSON fields. */
export function validateMessage(value: unknown): asserts value is AgentMessage {
  if (!object(value) || typeof value['role'] !== 'string' || !['system', 'user', 'assistant', 'toolResult'].includes(value['role']) || typeof value['timestamp'] !== 'number' || !Number.isFinite(value['timestamp'])) throw new Error('Unsupported Pi message');
  const role = value['role'];
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
    if (value['miraPromptState'] !== undefined) validatePromptState(value['miraPromptState']);
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
