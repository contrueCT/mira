/** A durable turn continues the existing Mira; it is not a conversation session.
 * The caller owns wake scheduling. The adapter owns interpretation of records. */
export interface CognitionTurn {
  id: string;
  input: string;
  occurredAt: string;
  inputRecordId: string | null;
  finalRecordId: string | null;
}
export interface CognitionRuntime {
  /** Input and terminal reply must be durably associated with this turn exactly
   * once before resolving. A rejected invocation must be recovered from storage. */
  continueTurn(turn: CognitionTurn, signal?: AbortSignal): Promise<void>;
}

/** Files contain a reconstructible view of canonical batch records. */
export interface WakeInputArtifact { path: string; bytes: number }
export type WriteOverflowInput = (runId: string, content: string) => Promise<WakeInputArtifact>;
