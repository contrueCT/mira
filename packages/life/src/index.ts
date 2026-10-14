import type { ContextSnapshot, Json, RuntimeRecord } from '@mira/context';
export interface LifeEvent {
  /** External event identity/idempotency key, distinct from its History UUID. */
  id: string;
  type: string;
  source: 'user' | 'mira' | 'system' | 'extension' | 'external';
  occurredAt: string;
  payload: Json;
}
export interface WakeReceipt { id: string; reason: string }
/** Immutable execution facts linked to the original assistant call, not proof of permission. */
export interface ToolIntent {
  /** Original provider tool-call identity; never rewritten to a History UUID. */
  callId: string;
  assistantRecordId: string;
  toolName: string;
  /** Exact request before the runtime validates/coerces tool arguments. */
  requestedArguments: Json;
  /** Validated arguments approved for, and supplied to, execution. */
  arguments: Json;
  occurredAt: string;
}
export interface ToolOutcome {
  callId: string;
  occurredAt: string;
  payload: Json;
}
export interface ToolExecution { intent: ToolIntent; outcome: ToolOutcome | null }
export interface RecoverySnapshot extends ContextSnapshot { executions: ToolExecution[] }
/** One dedicated database connection owns this writer for its entire lifetime. */
export interface DurableWriter {
  readonly miraId: string;
  readonly epoch: string;
  readonly signal: AbortSignal;
  assertActive(): void;
  verifyActive(): Promise<void>;
  load(): Promise<RecoverySnapshot>;
  /** Cancellation is honored before COMMIT dispatch; after dispatch, reload to
   * establish publication outcome rather than assuming rollback. */
  append(expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number>;
  receive(event: LifeEvent, wake?: WakeReceipt): Promise<'inserted' | 'duplicate'>;
  beginTool(expectedVersion: number, intent: ToolIntent): Promise<void>;
  finishTool(outcome: ToolOutcome): Promise<void>;
  close(): Promise<void>;
}

export interface WakeRequest {
  /** Global History UUID of the event; event.id remains its external dedupe key. */
  eventId: string;
  event: LifeEvent;
  wake: WakeReceipt;
}
export interface WakeRun {
  id: string;
  claimedAt: string;
  status: 'running' | 'completed';
  requests: WakeRequest[];
  inputRecordId: string | null;
  finalRecordId: string | null;
}
/** Durable consumption uses the same fenced writer as context publication. */
export interface WakeWriter extends DurableWriter {
  /** Resume the active run, otherwise atomically claim all currently pending
   * requests. New receipts never join an already claimed run. */
  claimWakeBatch(): Promise<WakeRun | null>;
  loadWakeRun(runId: string): Promise<WakeRun>;
  /** Append and bind in one transaction; retries verify identical evidence. */
  appendWakeInput(runId: string, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number>;
  appendWakeFinal(runId: string, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number>;
  /** Requires persisted input and final reply; safely repeatable after a crash. */
  completeWakeRun(runId: string): Promise<void>;
}
export { WakeLoop, prepareWakeTurn, renderWakeBatch } from './loop.ts';
export { DurableOperationError } from './durable-errors.ts';
export type { DurableFailureCategory } from './durable-errors.ts';
export type { WakeLoopOptions } from './loop.ts';
export type { MemoryCheckpoint, MemoryCheckpointState, MemoryCheckpointWriter, MemorySnapshotReceipt } from './memory-lifecycle.ts';
export { HistoryError } from './history.ts';
export type { HistoryKind, HistorySearchMode, HistoryReference, HistoryMetadata, HistorySearchRequest, HistoryHit, HistorySearchResult, HistoryPageCursor, HistoryPageRequest, HistoryPageHit, HistoryPageResult, HistoryReadRequest, HistoryEvent, HistoryContext, HistoryTool, HistoryWake, HistoryEntry, HistoryReader, HistoryEventRun, HistoryRunPageRequest, HistoryRunPage, HistoryRunHeader, HistoryRunRequestsPage, RunHistoryReader } from './history.ts';
export type { DreamingRequest, DreamingRequestResult, DreamingWriter } from './dreaming.ts';
export type { LiveInputWriter, LiveWakeInput } from './live-input.ts';
