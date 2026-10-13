/** A durable turn continues the existing Mira; it is not a conversation session.
 * The caller owns wake scheduling. The adapter owns interpretation of records. */
export interface CognitionTurn {
  id: string;
  input: string;
  occurredAt: string;
  inputRecordId: string | null;
  finalRecordId: string | null;
  /** Ordered immutable local attachments, independent of a provider's wire format. */
  attachments?: AttachmentReference[];
}
export interface CognitionRuntime {
  /** Input and terminal reply must be durably associated with this turn exactly
   * once before resolving. A rejected invocation must be recovered from storage. */
  continueTurn(turn: CognitionTurn, signal?: AbortSignal): Promise<void>;
}

/** Files contain a reconstructible view of canonical batch records. */
export interface WakeInputArtifact { path: string; bytes: number }
export type WriteOverflowInput = (runId: string, content: string) => Promise<WakeInputArtifact>;

export interface AttachmentReference {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  /** Server-owned immutable snapshot; never accepted as a browser read path. */
  path: string;
}
export function validateAttachmentReferences(value: unknown): asserts value is AttachmentReference[] {
  if (!Array.isArray(value)) throw new Error('Invalid attachment references');
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'id,mimeType,name,path,sha256,size'
      || typeof item.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(item.id)
      || typeof item.name !== 'string' || !item.name || item.name.length > 255 || /[\u0000-\u001f\u007f]/u.test(item.name)
      || typeof item.mimeType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(item.mimeType)
      || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 50 * 1024 * 1024
      || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(item.sha256)
      || typeof item.path !== 'string' || !item.path.startsWith('/') || item.path.length > 4096 || item.path.includes('\0')) throw new Error('Invalid attachment reference');
  }
}
