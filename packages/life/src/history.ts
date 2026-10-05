import type { RuntimeRecord } from '@mira/context';
import type { LifeEvent, ToolIntent, ToolOutcome, WakeReceipt } from './index.ts';

export type HistoryKind = 'event' | 'context' | 'tool' | 'wake';
/** Full text is PostgreSQL's simple dictionary, not semantic/Chinese search.
 * Substring is an explicit, literal case-insensitive fallback, never automatic. */
export type HistorySearchMode = 'full_text' | 'substring';
export interface HistoryReference { kind: HistoryKind; id: string }
export interface HistorySearchRequest {
  query: string;
  mode?: HistorySearchMode;
  kinds?: HistoryKind[];
  /** Default 20, maximum 100. */
  limit?: number;
}
export interface HistoryHit extends HistoryReference {
  miraId: string;
  occurredAt: string;
  /** Display-only excerpt of original serialized data; use read for evidence. */
  snippet: string;
  /** Database lexical rank, or null for literal substring mode. */
  rank: number | null;
}
export interface HistorySearchResult {
  query: string;
  mode: HistorySearchMode;
  /** Full text indexes a bounded prefix so unusually large originals cannot
   * break durable writes. Substring scans the entire original document. */
  fullTextPrefixChars: number | null;
  hits: HistoryHit[];
  hasMore: boolean;
}
export interface HistoryReadRequest extends HistoryReference {
  /** Complete serialized response budget. Default 65,536; maximum 1,048,576.
   * Oversized records fail explicitly instead of silently losing evidence. */
  maxBytes?: number;
}
interface HistoryBase extends HistoryReference { miraId: string; occurredAt: string }
export interface HistoryEvent extends HistoryBase {
  kind: 'event';
  event: LifeEvent;
  requestedWake: WakeReceipt | null;
}
export interface HistoryContext extends HistoryBase {
  kind: 'context';
  version: number;
  /** Original runtime envelope. Only its runtime adapter interprets payload. */
  record: RuntimeRecord;
}
export interface HistoryTool extends HistoryBase {
  kind: 'tool';
  contextVersion: number;
  intent: ToolIntent;
  outcome: ToolOutcome | null;
}
export interface HistoryWake extends HistoryBase {
  kind: 'wake';
  claimedVersion: number;
  inputRecordId: string | null;
  finalRecordId: string | null;
  status: 'running' | 'completed';
  /** Exact immutable membership, in persisted receipt order. Event originals
   * (including wake reasons) are available through their event references. */
  requests: { wakeId: string; eventId: string; receiptOrder: string }[];
}
export type HistoryEntry = HistoryEvent | HistoryContext | HistoryTool | HistoryWake;
/** Mira scope is fixed by trusted assembly, never supplied by model arguments.
 * Reads never acquire ownership, mutate history, or start cognition. */
export interface HistoryReader {
  readonly miraId: string;
  search(request: HistorySearchRequest): Promise<HistorySearchResult>;
  /** Null means this exact kind/ID was not found in this Mira. */
  read(request: HistoryReadRequest): Promise<HistoryEntry | null>;
}
export class HistoryError extends Error {
  readonly code: 'invalid' | 'corrupt' | 'too_large';
  readonly requiredBytes: number | undefined;
  constructor(code: HistoryError['code'], message: string, requiredBytes?: number) {
    super(message);
    this.name = 'HistoryError'; this.code = code; this.requiredBytes = requiredBytes;
  }
}
