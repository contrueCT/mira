import type { MemoryCheckpointWriter } from './memory-lifecycle.ts';

/** Scheduling thresholds only. The instruction is ordinary system-Wake input;
 * the existing cognitive loop and tools perform any Memory maintenance. */
export interface DreamingRequest {
  idleMs: number;
  intervalMs: number;
  minCompactions: number;
  instruction: string;
}

export type DreamingRequestResult =
  | { status: 'inserted' }
  | { status: 'waiting'; nextCheckAt: string | null };

/** Optional scheduling extension; progress is technical trigger bookkeeping,
 * never semantic Memory or a second cognitive/run lifecycle. */
export interface DreamingWriter extends MemoryCheckpointWriter {
  /** Initialize once at enable time, baselining existing receipts and context.
   * Restart must preserve the prior time, receipt and compaction baselines. */
  initializeDreaming(): Promise<void>;
  /** Atomically check idle + fresh effective experiences + (compactions or time),
   * insert an ordinary system Event/Wake, and advance the trigger baselines.
   * Only successfully published checkpoint records count as compactions.
   * Null nextCheckAt means wait for lifecycle activity, not a polling timer. */
  requestDreaming(request: DreamingRequest): Promise<DreamingRequestResult>;
}
