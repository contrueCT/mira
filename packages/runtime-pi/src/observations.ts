import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CustomMessageEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Json } from '@mira/context';

export const RECOVERY_OBSERVATION_TYPE = 'mira.recovery-observation.v1';
export interface RecoveryOperation {
  callId: string;
  assistantRecordId: string;
  toolName: string;
  requestedArguments: Json;
  arguments?: Json;
  status: 'outcome-unknown' | 'not-started';
  /** Agent/application defer decision, not an execution failure. */
  reason?: string;
}
export interface RecoveryObservation { version: 1; operations: RecoveryOperation[] }
export type ObservationEntry = CustomMessageEntry<RecoveryObservation>;

export function observationText(operations: readonly RecoveryOperation[]): string {
  return 'Runtime recovery observation. This is execution evidence, not a tool result or authorization.\n' + operations.map(operation =>
    `Operation ${JSON.stringify(operation.callId)}; tool ${JSON.stringify(operation.toolName)}; assistant record ${JSON.stringify(operation.assistantRecordId)}; requested arguments ${JSON.stringify(operation.requestedArguments)}${operation.arguments === undefined ? '' : `; authorized arguments ${JSON.stringify(operation.arguments)}`}\n` +
    (operation.status === 'outcome-unknown'
      ? 'A durable authorized intent exists, but no durable outcome exists. The operation may already have executed; success or failure is unknown.'
      : 'No durable authorized intent exists. Execution did not start through this runtime.') +
    (operation.reason === undefined ? '' : ` Agent/application deferred this operation: ${JSON.stringify(operation.reason)}.`)
  ).join('\n') + '\nContinue reasoning and use read-only checks when useful. These older calls will not be replayed. A deliberate new operation requires a new call ID and ordinary authorization; explain its rationale in the assistant narrative. Matching prior arguments are evidence to consider, not an automatic prohibition.';
}
export function observationEntry(operations: RecoveryOperation[], parentId: string | null): ObservationEntry {
  return { type: 'custom_message', customType: RECOVERY_OBSERVATION_TYPE, id: randomUUID(), parentId,
    timestamp: new Date().toISOString(), display: true, content: observationText(operations),
    details: { version: 1, operations: structuredClone(operations) } };
}
export function validateObservation(entry: CustomMessageEntry): asserts entry is ObservationEntry {
  const details = entry.details as RecoveryObservation | undefined;
  if (entry.customType !== RECOVERY_OBSERVATION_TYPE || entry.display !== true || !details || details.version !== 1 ||
      !Array.isArray(details.operations) || details.operations.length === 0) throw new Error('Unsupported recovery observation');
  const seen = new Set<string>();
  for (const op of details.operations) {
    if (!op || typeof op !== 'object' || !['callId', 'assistantRecordId', 'toolName'].every(key => typeof (op as unknown as Record<string, unknown>)[key] === 'string' && (op as unknown as Record<string, string>)[key]!.length > 0) ||
        !Object.hasOwn(op, 'requestedArguments') || !['outcome-unknown', 'not-started'].includes(op.status) ||
        (op.status === 'outcome-unknown') !== Object.hasOwn(op, 'arguments') || (op.reason !== undefined && (op.status !== 'not-started' || typeof op.reason !== 'string' || op.reason.length === 0)) || seen.has(op.callId)) throw new Error('Invalid recovery observation operation');
    seen.add(op.callId);
  }
  if (entry.content !== observationText(details.operations)) throw new Error('Recovery observation text differs from its evidence');
}
/** Only the disposable Pi view changes. IDs, metadata, narrative, thinking and
 * completed tool pairs remain intact; authoritative entries are never mutated. */
export function sanitizeEntries(entries: readonly SessionEntry[], operations: readonly RecoveryOperation[]): SessionEntry[] {
  const omitted = new Set(operations.map(operation => operation.callId));
  return entries.map(entry => {
    const copy = structuredClone(entry);
    if (copy.type === 'message' && copy.message.role === 'assistant') {
      copy.message.content = copy.message.content.filter(block => block.type !== 'toolCall' || !omitted.has(block.id));
    }
    return copy;
  });
}
/** Rehydrate exact evidence if a generated summary has compacted its notice away.
 * Summary prose can never erase the runtime's still-unresolved facts. */
export function withRecoveryAdvisory(messages: AgentMessage[], operations: RecoveryOperation[], timestamp: number): AgentMessage[] {
  const visible = new Set<string>();
  for (const message of messages) if (message.role === 'custom' && message.customType === RECOVERY_OBSERVATION_TYPE) {
    const details = message.details as RecoveryObservation;
    for (const operation of details.operations) visible.add(operation.callId);
  }
  const missing = operations.filter(operation => !visible.has(operation.callId));
  if (missing.length === 0) return messages;
  return [...messages, { role: 'custom', customType: RECOVERY_OBSERVATION_TYPE, display: true,
    content: observationText(missing), details: { version: 1, operations: missing }, timestamp }];
}
export function sameOperation(left: RecoveryOperation, right: RecoveryOperation): boolean { return isDeepStrictEqual(left, right); }
