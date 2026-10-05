import type { Json } from '@mira/context';
import type { WakeWriter } from './index.ts';

/** Durable intent to finish a finalized Wake's Memory-only snapshot. The opaque
 * payload identifies adapter recovery inputs, not a second file-content store.
 * preparedAt is intent time; it does not claim when Git captured the files. */
export interface MemoryCheckpoint {
  runId: string;
  finalRecordId: string;
  preparedAt: string;
  payload: Json;
}

/** Null means the adapter durably observed no Memory changes for this Wake.
 * It is distinct from a missing receipt, which still requires recovery. */
export interface MemorySnapshotReceipt {
  runId: string;
  commit: string | null;
}

export interface MemoryCheckpointState {
  checkpoint: MemoryCheckpoint;
  receipt: MemorySnapshotReceipt | null;
}

/** Optional extension so unrelated WakeWriter implementations remain valid.
 * The lifecycle is checkpoint -> Git snapshot -> receipt -> Wake completion.
 * These are recoverable boundaries, never a claimed PostgreSQL/Git transaction.
 * Adapters must key Git outcomes by Mira + run and retry them without capturing
 * newer edits or creating a second commit. Snapshot lineage records a workspace
 * observation, not proof that this Wake or an agent authored every file change. */
export interface MemoryCheckpointWriter extends WakeWriter {
  loadMemoryCheckpoint(runId: string): Promise<MemoryCheckpointState | null>;
  /** Requires the persisted final reply; identical retries are allowed. */
  prepareMemoryCheckpoint(checkpoint: MemoryCheckpoint): Promise<void>;
  /** First receipt is immutable; an identical retry is allowed. */
  finishMemoryCheckpoint(receipt: MemorySnapshotReceipt): Promise<void>;
}
