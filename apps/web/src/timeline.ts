import type { PendingMessage, TimelineItem } from './types.ts';
export const PENDING_KEY = 'mira.pending-messages.v1';
export function mergeTimeline(current: TimelineItem[], incoming: TimelineItem[]): TimelineItem[] {
  const items = new Map(current.map(item => [item.id, item]));
  for (const item of incoming) items.set(item.id, item);
  return [...items.values()].sort((a, b) => {
    const left = Date.parse(a.occurredAt); const right = Date.parse(b.occurredAt);
    if (Number.isFinite(left) && Number.isFinite(right)) {
      if (left !== right) return left - right;
      // Date.parse truncates sub-millisecond precision; retain it for equal instants.
      const fraction = (value: string) => (value.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/iu)?.[1] ?? '').padEnd(9, '0');
      return fraction(a.occurredAt).localeCompare(fraction(b.occurredAt)) || a.id.localeCompare(b.id);
    }
    if (Number.isFinite(left) !== Number.isFinite(right)) return Number.isFinite(left) ? 1 : -1;
    return a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id);
  });
}
export function reconcilePending(pending: PendingMessage[], items: TimelineItem[]): PendingMessage[] {
  return pending.filter(message => !items.some(item => confirmsPending(message, item)));
}
export function readPending(storage: Pick<Storage, 'getItem'>): PendingMessage[] {
  const raw = storage.getItem(PENDING_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('无法读取尚未确认的消息');
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('无法读取尚未确认的消息');
    const item = value as Record<string, unknown>;
    const attachmentIds = item['attachmentIds'];
    const replyToMessageId = item['replyToMessageId'];
    if (replyToMessageId !== undefined && (typeof replyToMessageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(replyToMessageId))) throw new Error('无法读取尚未确认的消息引用');
    if (attachmentIds !== undefined && (!Array.isArray(attachmentIds) || attachmentIds.length > 10 || attachmentIds.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(id)) || new Set(attachmentIds).size !== attachmentIds.length)) throw new Error('无法读取尚未确认的消息附件');
    if (typeof item['id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(item['id']) || typeof item['text'] !== 'string' || (!item['text'].trim() && !(attachmentIds as string[] | undefined)?.length) || typeof item['occurredAt'] !== 'string' || !Number.isFinite(Date.parse(item['occurredAt']))) throw new Error('无法读取尚未确认的消息');
    return { ...(replyToMessageId !== undefined ? { replyToMessageId: replyToMessageId as string } : {}), id: item['id'], text: item['text'], occurredAt: item['occurredAt'], ...(attachmentIds !== undefined ? { attachmentIds: [...attachmentIds as string[]] } : {}), state: item['state'] === 'queued' ? 'queued' : 'uncertain' };
  });
}
export function writePending(storage: Pick<Storage, 'setItem' | 'removeItem'>, messages: PendingMessage[]): void {
  if (messages.length) storage.setItem(PENDING_KEY, JSON.stringify(messages.map(({ id, text, occurredAt, attachmentIds, replyToMessageId, state }) => ({ id, text, occurredAt, ...(replyToMessageId !== undefined ? { replyToMessageId } : {}), ...(attachmentIds !== undefined ? { attachmentIds: [...attachmentIds] } : {}), state }))));
  else storage.removeItem(PENDING_KEY);
}

export interface HistoryGap { id: string; cursor: string; boundaryIds: string[] }
export interface HistoryPagination { latestCursor: string | null; oldestCursor: string | null; gaps: HistoryGap[] }
export interface HistoryRequest { cursor: string; gapId: string | null }
/** Track disconnected latest windows without losing the older-history frontier. */
export function latestPagination(current: HistoryPagination, known: { id: string }[], page: { items: { id: string }[]; nextCursor: string | null }, initialized: boolean): HistoryPagination {
  if (!initialized) return { latestCursor: page.nextCursor, oldestCursor: page.nextCursor, gaps: [] };
  // The same hidden-only latest window must not rewind a partially read gap.
  // A changed window still needs a gap, even before any visible item is found.
  if (current.latestCursor === page.nextCursor) return current;
  const updated = { ...current, latestCursor: page.nextCursor };
  const ids = new Set(known.map(item => item.id));
  if (page.items.some(item => ids.has(item.id)) || page.nextCursor === null || current.gaps.some(gap => gap.id === page.nextCursor || gap.cursor === page.nextCursor)) return updated;
  // A latest window without visible messages over the same boundary as the
  // newest gap: the new gap's range contains the old one. Replace it rather
  // than add a gap per poll during a long private tool interval; at worst the
  // replaced gap's partial progress is reread.
  if (!page.items.length && current.gaps[0]?.boundaryIds.length === ids.size) {
    return { ...updated, gaps: [{ id: page.nextCursor, cursor: page.nextCursor, boundaryIds: [...ids] }, ...current.gaps.slice(1)] };
  }
  return { ...updated, gaps: [{ id: page.nextCursor, cursor: page.nextCursor, boundaryIds: [...ids] }, ...current.gaps] };
}
export function nextHistoryRequest(pagination: HistoryPagination): HistoryRequest | null {
  const gap = pagination.gaps[0];
  return gap ? { cursor: gap.cursor, gapId: gap.id } : pagination.oldestCursor ? { cursor: pagination.oldestCursor, gapId: null } : null;
}
export function olderPagination(current: HistoryPagination, request: HistoryRequest, page: { items: { id: string }[]; nextCursor: string | null }): HistoryPagination {
  if (request.gapId === null) return { ...current, oldestCursor: page.nextCursor };
  const gapIndex = current.gaps.findIndex(gap => gap.id === request.gapId);
  if (gapIndex < 0) return current;
  // Reaching the beginning covers this gap and every older frontier. A newer
  // gap added while this request was outstanding remains independently unread.
  if (page.nextCursor === null) return { ...current, oldestCursor: null, gaps: current.gaps.slice(0, gapIndex) };
  return { ...current, gaps: current.gaps.flatMap(gap => {
    if (gap.id !== request.gapId) return [gap];
    const reachedBoundary = page.items.some(item => gap.boundaryIds.includes(item.id));
    return reachedBoundary ? [] : [{ ...gap, cursor: page.nextCursor! }];
  }) };
}

/** A conflicting server identity must not silently discard a retained reply. */
export function confirmsPending(message: PendingMessage | import('./types.ts').MessageEnvelope, item: TimelineItem): boolean {
  return item.role === 'user' && item.externalEventId === message.id && item.reply?.messageId === message.replyToMessageId;
}
/** Local calendar boundaries deliberately use the viewer's timezone. */
export function timelineSpacing(previous: TimelineItem | undefined, current: TimelineItem): { divider: boolean; compact: boolean } {
  const now = new Date(current.occurredAt); const before = previous ? new Date(previous.occurredAt) : null;
  if (!Number.isFinite(now.getTime())) return { divider: false, compact: false };
  const validPrevious = before !== null && Number.isFinite(before.getTime());
  const divider = !validPrevious || now.toDateString() !== before.toDateString() || now.getTime() - before.getTime() > 5 * 60_000;
  const sameSource = previous?.source?.extensionId === current.source?.extensionId && previous?.source?.senderId === current.source?.senderId && previous?.source?.direction === current.source?.direction;
  return { divider, compact: !divider && previous?.role === current.role && current.role !== 'notice' && sameSource };
}
export function replySnippet(reply: import('./types.ts').ReplyReference): string {
  return (reply.text.trim() || reply.attachmentNames?.join('、') || '原消息').replace(/\s+/gu, ' ');
}

export type OlderHistoryResult = { kind: 'target' | 'complete' | 'budget' | 'timeout' | 'stopped' } | { kind: 'error'; error: unknown };
export interface OlderHistoryOptions<P> {
  next(): HistoryRequest | null;
  fetchPage(request: HistoryRequest, signal: AbortSignal): Promise<P>;
  /** Commits one page and returns how many rows it newly added. */
  accept(page: P, request: HistoryRequest): number;
  /** The owning view or its polling scope; aborting it stops silently. */
  owner: AbortSignal;
  stopped(): boolean;
  target?: number; maxPages?: number; timeoutMs?: number;
  schedule?(callback: () => void, ms: number): () => void;
}
/** One explicit "older messages" intent: consecutive frontiers until enough new
 * rows, the end, a repeated cursor, the page budget or the deadline. Every
 * completed response is committed before the deadline is considered, so a page
 * that arrives as time runs out is retained rather than silently dropped. */
export async function loadOlderHistory<P>(options: OlderHistoryOptions<P>): Promise<OlderHistoryResult> {
  const { target = 50, maxPages = 8, timeoutMs = 15_000 } = options;
  const schedule = options.schedule ?? ((callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); });
  if (options.owner.aborted || options.stopped()) return { kind: 'stopped' };
  // Linked by hand: AbortSignal.any is newer than Vite's default browser target.
  const controller = new AbortController();
  const stop = () => controller.abort();
  options.owner.addEventListener('abort', stop, { once: true });
  let timedOut = false;
  const cancel = schedule(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const cursors = new Set<string>();
  let added = 0;
  try {
    for (let pageCount = 0; pageCount < maxPages; pageCount++) {
      const request = options.next();
      if (!request) return { kind: 'complete' };
      if (cursors.has(request.cursor)) return { kind: 'budget' };
      cursors.add(request.cursor);
      let page: P;
      try { page = await options.fetchPage(request, controller.signal); }
      catch (error) {
        if (options.owner.aborted || options.stopped()) return { kind: 'stopped' };
        return timedOut ? { kind: 'timeout' } : { kind: 'error', error };
      }
      if (options.owner.aborted || options.stopped()) return { kind: 'stopped' };
      added += options.accept(page, request);
      if (added >= target) return { kind: 'target' };
      if (timedOut) return { kind: 'timeout' };
    }
    return options.next() ? { kind: 'budget' } : { kind: 'complete' };
  } finally {
    cancel(); options.owner.removeEventListener('abort', stop);
  }
}
