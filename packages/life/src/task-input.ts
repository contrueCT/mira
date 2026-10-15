import type { RuntimeRecord } from '@mira/context';
import type { DurableWriter, ToolIntent } from './index.ts';

/** Task-local parent instructions; these are neither user messages nor main Wakes. */
export interface TaskLiveInput {
  callId: string;
  instruction: string;
  createdAt: string;
  inputRecordId: string | null;
}
export interface TaskTurnState {
  id: string;
  callId: string;
  createdAt: string;
  status: 'queued' | 'running' | 'completed' | 'interrupted' | 'cancelled' | 'failed';
  inputRecordId: string | null;
  finalRecordId: string | null;
}
/** Implemented by the child transcript owner. Admission uses the parent owner;
 * both sides atomically lock the same task boundary before publishing evidence. */
export interface TaskInputWriter extends DurableWriter {
  loadTaskTurn(turnId: string): Promise<TaskTurnState>;
  appendTaskInput(turnId: string, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number>;
  loadTaskInputs(turnId: string): Promise<TaskLiveInput[]>;
  appendTaskLiveInput(turnId: string, callId: string, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number>;
  tryBeginTaskTool(turnId: string, expectedVersion: number, intent: ToolIntent): Promise<boolean>;
  tryAppendTaskFinal(turnId: string, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number | null>;
}
