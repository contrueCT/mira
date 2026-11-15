import { randomUUID } from 'node:crypto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { CustomMessageEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import type { Json } from '@mira/context';

export const RECOVERY_OBSERVATION_TYPE = 'mira.recovery-observation.v1';
export interface PreparationIssue { path: string; keyword: string; limit?: number; expected?: string }
export type ToolDiagnostic =
  | { phase: 'execute'; category: 'execution-rejected' | 'event-content-conflict' }
  | { phase: 'result'; category: 'invalid-json-result' | 'non-finite-result' }
  | { phase: 'prepare'; category: 'tool-not-found' }
  | { phase: 'prepare'; category: 'invalid-arguments'; issues?: PreparationIssue[] };
export interface RecoveryOperation {
  callId: string;
  assistantRecordId: string;
  toolName: string;
  requestedArguments: Json;
  arguments?: Json;
  status: 'outcome-unknown' | 'not-started';
  /** A bounded runtime-observed reason, separate from unknown external outcome.
   * Absent when the process died before this observation was persisted. */
  diagnostic?: ToolDiagnostic;
}
export interface RecoveryObservation { version: 1; operations: RecoveryOperation[] }
export type ObservationEntry = CustomMessageEntry<RecoveryObservation>;

export function observationText(operations: readonly RecoveryOperation[]): string {
  return 'Runtime recovery observation. This is execution evidence, not a tool result or authorization.\n' + operations.map(operation =>
    `Operation ${JSON.stringify(operation.callId)}; tool ${JSON.stringify(operation.toolName)}; assistant record ${JSON.stringify(operation.assistantRecordId)}; requested arguments ${JSON.stringify(operation.requestedArguments)}${operation.arguments === undefined ? '' : `; validated arguments ${JSON.stringify(operation.arguments)}`}\n` +
    (operation.status === 'outcome-unknown'
      ? 'A durable execution intent exists, but no durable outcome exists. The operation may already have executed; success or failure is unknown.'
      : 'No durable execution intent exists. Execution did not start through this runtime.') +
    (operation.diagnostic ? `\nRuntime diagnostic (${operation.diagnostic.phase}/${operation.diagnostic.category}): ${diagnosticText(operation.diagnostic)}` : '')
  ).join('\n') + '\nContinue reasoning and use read-only checks when useful. These older calls will not be replayed. For a deliberate new operation, use a new call ID and decide from the user’s request and current context; explain its rationale in the assistant narrative. Matching prior arguments are evidence to consider, not an automatic prohibition.';
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
        (op.status === 'outcome-unknown') !== Object.hasOwn(op, 'arguments') || seen.has(op.callId)) throw new Error('Invalid recovery observation operation');
    seen.add(op.callId);
    if (Object.hasOwn(op, 'diagnostic')) {
      validateDiagnostic(op.diagnostic);
      if ((op.diagnostic!.phase === 'prepare') !== (op.status === 'not-started')) throw new Error('Diagnostic phase does not match execution evidence');
    }
  }
  if (entry.content !== observationText(details.operations)) throw new Error('Recovery observation text differs from its evidence');
}
function validateDiagnostic(value: unknown): asserts value is ToolDiagnostic {
  if (value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)['phase'] === 'prepare') {
    validatePreparationDiagnostic(value); return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
      Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, 'phase') || !Object.hasOwn(value, 'category')) throw new Error('Invalid recovery diagnostic');
  const { phase, category } = value as Record<string, unknown>;
  if (typeof phase !== 'string' || typeof category !== 'string' || phase.length > 7 || category.length > 32 ||
      !(phase === 'execute' && (category === 'execution-rejected' || category === 'event-content-conflict') ||
        phase === 'result' && (category === 'invalid-json-result' || category === 'non-finite-result'))) throw new Error('Unsupported recovery diagnostic');
  if (JSON.stringify(value).length > 96) throw new Error('Recovery diagnostic exceeds its limit');
}
const issueKeywords = ['required', 'additionalProperties', 'type', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'enum', 'const', 'pattern', 'format', 'anyOf', 'oneOf'];
export function validatePreparationDiagnostic(value: unknown): asserts value is Extract<ToolDiagnostic, { phase: 'prepare' }> {
  const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
  if (!plain(value) || value['phase'] !== 'prepare' || typeof value['category'] !== 'string' || !['tool-not-found', 'invalid-arguments'].includes(value['category']) ||
      !Object.hasOwn(value, 'phase') || !Object.hasOwn(value, 'category') ||
      !Reflect.ownKeys(value).every(key => ['phase', 'category', 'issues'].includes(String(key))) ||
      (value['category'] === 'tool-not-found' && Object.hasOwn(value, 'issues'))) throw new Error('Invalid preparation diagnostic');
  if (Object.hasOwn(value, 'issues')) {
    const issues = value['issues'];
    if (!Array.isArray(issues) || issues.length < 1 || issues.length > 8) throw new Error('Invalid preparation issues');
    for (const issue of issues) {
      if (!plain(issue) || !Reflect.ownKeys(issue).every(key => ['path', 'keyword', 'limit', 'expected'].includes(String(key))) ||
          !Object.hasOwn(issue, 'path') || !Object.hasOwn(issue, 'keyword') ||
          typeof issue['path'] !== 'string' || issue['path'].length > 128 || !/^(?:\/[A-Za-z0-9_~.-]+)*$/u.test(issue['path']) ||
          typeof issue['keyword'] !== 'string' || !issueKeywords.includes(issue['keyword']) ||
          (Object.hasOwn(issue, 'limit') && (typeof issue['limit'] !== 'number' || !Number.isFinite(issue['limit']) || !['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems'].includes(String(issue['keyword'])))) ||
          (Object.hasOwn(issue, 'expected') && (issue['keyword'] !== 'type' || typeof issue['expected'] !== 'string' || !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(issue['expected'])))) throw new Error('Invalid preparation issue');
    }
  }
  if (JSON.stringify(value).length > 2048) throw new Error('Preparation diagnostic exceeds its limit');
}
function diagnosticText(diagnostic: ToolDiagnostic): string {
  switch (diagnostic.category) {
    case 'tool-not-found': return 'The requested tool is absent from the pinned tool registry. No execution started. Choose an available tool from the current declarations with a new call ID.';
    case 'invalid-arguments': return 'The requested arguments failed the declared tool schema. No execution started. Correct the arguments using the current tool declaration and a new call ID.' + ('issues' in diagnostic && diagnostic.issues ? ` Schema constraints to check: ${JSON.stringify(diagnostic.issues)}` : '');
    case 'execution-rejected': return 'The tool execution rejected. It may already have caused effects; inspect external state before deciding whether to retry.';
    case 'event-content-conflict': return 'An event or Wake identity conflicts with previously saved content. Inspect the original event and reuse its exact identity, timestamp, payload and Wake choice for a receipt retry; a genuinely new event needs a new identity.';
    case 'invalid-json-result': return 'The returned tool result could not be represented as valid runtime JSON. Repair the result contract and inspect external state before deciding whether to retry.';
    case 'non-finite-result': return 'The returned tool result contained a nonfinite number. Return only finite JSON numbers and inspect external state before deciding whether to retry.';
  }
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
