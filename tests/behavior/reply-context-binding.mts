/** Test-only, fail-closed identity checks for an index's containing user record.
 * Never maps a context History UUID to a public event or rewrites tool output. */
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import type { ReplyReference } from '@mira/cognition';
import { renderWakeBatch, type HistoryEntry } from '@mira/life';
import { decodeRecords } from '@mira/runtime-pi';

export interface UserContextSource { historyId: string; messages: ReplyReference[]; replies: [] }
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
};
function source(value: unknown): UserContextSource {
  const item = object(value);
  assert.deepEqual(Object.keys(item).sort(), ['historyId', 'messages', 'replies']);
  assert.equal(typeof item['historyId'], 'string');
  assert.ok(Array.isArray(item['messages']) && item['messages'].length === 1, 'Only the captured single-source user shape is supported');
  assert.deepEqual(item['replies'], []);
  const message = object(item['messages'][0]);
  assert.deepEqual(Object.keys(message).sort(), ['messageId', 'role', 'text']);
  assert.equal(typeof message['messageId'], 'string'); assert.equal(message['role'], 'user'); assert.equal(typeof message['text'], 'string');
  return item as unknown as UserContextSource;
}
const descriptor = (item: UserContextSource) => ({ messages: item.messages, replies: item.replies });

export function uniqueUserContextSource(capturedSources: unknown[], actualSources: unknown[], captureId: string, remappedMessages: ReplyReference[]): UserContextSource {
  const before = capturedSources.map(source), after = actualSources.map(source);
  const originals = before.filter(item => item.historyId === captureId);
  assert.equal(originals.length, 1, 'Missing or ambiguous captured context History ID');
  const original = originals[0]!;
  assert.equal(before.filter(item => isDeepStrictEqual(descriptor(item), descriptor(original))).length, 1, 'Ambiguous captured context semantic source');
  const matches = after.filter(item => isDeepStrictEqual(descriptor(item), { messages: remappedMessages, replies: original.replies }));
  assert.equal(matches.length, 1, 'Missing or ambiguous actual context semantic source');
  const match = matches[0]!;
  assert.equal(after.filter(item => item.historyId === match.historyId).length, 1, 'Ambiguous actual context History ID');
  return match;
}

export function bindContextId(bindings: Map<string, string>, captureId: string, actualId: string): void {
  const prior = bindings.get(captureId);
  assert.ok(prior === undefined || prior === actualId, 'A captured context cannot change identity');
  assert.ok(![...bindings].some(([oldId, newId]) => oldId !== captureId && newId === actualId), 'Two captured contexts cannot alias one actual record');
  bindings.set(captureId, actualId);
}
export function requireContextId(bindings: Map<string, string>, captureId: string): string {
  const result = bindings.get(captureId); assert.ok(result, 'Unknown context History ID; an index read must verify it first'); return result;
}

/** Compare the full decoded user message to the exact production rendering of
 * the uniquely matched original event. Claim/record timestamps remain actual. */
export function verifyUserContextRecord(entry: HistoryEntry, expected: UserContextSource, userOccurredAt: string): void {
  assert.equal(entry.kind, 'context'); if (entry.kind !== 'context') return;
  assert.equal(entry.id, expected.historyId); assert.equal(entry.record.id, entry.id);
  assert.equal(entry.record.kind, 'message'); assert.equal(entry.record.runtime, 'pi'); assert.equal(entry.record.formatVersion, 1);
  const decoded = decodeRecords([entry.record], entry.record.parentId)[0];
  assert.ok(decoded?.type === 'message' && decoded.message.role === 'user');
  assert.equal(decoded.id, entry.id); assert.equal(decoded.parentId, entry.record.parentId); assert.equal(decoded.timestamp, entry.record.occurredAt);
  assert.equal(entry.occurredAt, entry.record.occurredAt);
  const message = object(decoded.message);
  assert.equal(typeof message['timestamp'], 'number'); assert.ok(Number.isFinite(message['timestamp']));
  const original = source(expected).messages[0]!;
  const input = renderWakeBatch({ id: entry.id, claimedAt: new Date(message['timestamp'] as number).toISOString(), status: 'running', inputRecordId: entry.id, finalRecordId: null,
    requests: [{ eventId: original.messageId, event: { id: original.messageId, type: 'web.message', source: 'user', occurredAt: userOccurredAt,
      payload: { text: original.text, messageFormatVersion: 1 } }, wake: { id: `web:${original.messageId}`, reason: 'User message from the local web interface' } }] });
  assert.deepEqual(message, { role: 'user', content: input, timestamp: message['timestamp'], miraReplySources: expected.messages }, 'Full user message must match its exact semantic source, with no additional content or metadata');
}
