import type { ContextSnapshot, Json, RuntimeRecord } from '@mira/context';
export interface LifeEvent {
  id: string;
  type: string;
  source: 'user' | 'mira' | 'system' | 'extension' | 'external';
  occurredAt: string;
  payload: Json;
}
export interface WakeReceipt { id: string; reason: string }
export interface ToolIntent {
  callId: string;
  assistantRecordId: string;
  toolName: string;
  /** Exact request before the runtime validates/coerces tool arguments. */
  requestedArguments: Json;
  /** Validated arguments approved for, and supplied to, execution. */
  arguments: Json;
  authorization: Json;
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
