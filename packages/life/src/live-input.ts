import type { RuntimeRecord } from '@mira/context';
import type { LifeEvent, ToolIntent, WakeReceipt, WakeRequest, WakeWriter } from './index.ts';

/** An ordered supplemental input. The original Wake batch remains immutable. */
export interface LiveWakeInput {
  request: WakeRequest;
  inputRecordId: string | null;
}
/** Optional capability for supplemental input at model-request / single-tool boundaries.
 * Public reception remains user-only; internal child terminal receipts preserve their source.
 * Durable reads and atomic gates are authoritative; notifications are hints only. */
export interface LiveInputWriter extends WakeWriter {
  receiveLiveInput(event: LifeEvent, wake: WakeReceipt): Promise<'inserted' | 'duplicate'>;
  loadLiveInputs(runId: string): Promise<LiveWakeInput[]>;
  appendLiveInput(runId: string, wakeId: string, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number>;
  tryBeginWakeTool(runId: string, expectedVersion: number, intent: ToolIntent): Promise<boolean>;
  tryAppendWakeFinal(runId: string, expectedVersion: number, record: RuntimeRecord, signal?: AbortSignal): Promise<number | null>;
  onLiveInput(listener: (runId: string) => void): () => void;
}
