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
  const known = new Set(items.map(item => item.id));
  return pending.filter(message => !known.has(`event:${message.id}`));
}
export function readPending(storage: Pick<Storage, 'getItem'>): PendingMessage[] {
  const raw = storage.getItem(PENDING_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('无法读取尚未确认的消息');
  return parsed.map((value: unknown) => {
    if (!value || typeof value !== 'object') throw new Error('无法读取尚未确认的消息');
    const item = value as Record<string, unknown>;
    if (typeof item['id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(item['id']) || typeof item['text'] !== 'string' || !item['text'].trim() || typeof item['occurredAt'] !== 'string' || !Number.isFinite(Date.parse(item['occurredAt']))) throw new Error('无法读取尚未确认的消息');
    return { id: item['id'], text: item['text'], occurredAt: item['occurredAt'], state: item['state'] === 'queued' ? 'queued' : 'uncertain' };
  });
}
export function writePending(storage: Pick<Storage, 'setItem' | 'removeItem'>, messages: PendingMessage[]): void {
  if (messages.length) storage.setItem(PENDING_KEY, JSON.stringify(messages.map(({ id, text, occurredAt, state }) => ({ id, text, occurredAt, state }))));
  else storage.removeItem(PENDING_KEY);
}

export interface HistoryGap { id: string; cursor: string; boundaryIds: string[] }
export interface HistoryPagination { oldestCursor: string | null; gaps: HistoryGap[] }
export interface HistoryRequest { cursor: string; gapId: string | null }
/** Track disconnected latest windows without losing the older-history frontier. */
export function latestPagination(current: HistoryPagination, known: TimelineItem[], page: { items: TimelineItem[]; nextCursor: string | null }, initialized: boolean): HistoryPagination {
  if (!initialized) return { oldestCursor: page.nextCursor, gaps: [] };
  // Hidden runtime records can occupy whole pages. Polling their empty visible
  // projection must not rewind a user's already-advanced history frontier.
  if (known.length === 0 && page.items.length === 0) return current;
  const ids = new Set(known.map(item => item.id));
  if (page.items.some(item => ids.has(item.id)) || page.nextCursor === null || current.gaps.some(gap => gap.cursor === page.nextCursor)) return current;
  return { ...current, gaps: [{ id: page.nextCursor, cursor: page.nextCursor, boundaryIds: [...ids] }, ...current.gaps] };
}
export function nextHistoryRequest(pagination: HistoryPagination): HistoryRequest | null {
  const gap = pagination.gaps[0];
  return gap ? { cursor: gap.cursor, gapId: gap.id } : pagination.oldestCursor ? { cursor: pagination.oldestCursor, gapId: null } : null;
}
export function olderPagination(current: HistoryPagination, request: HistoryRequest, page: { items: TimelineItem[]; nextCursor: string | null }): HistoryPagination {
  if (request.gapId === null) return { ...current, oldestCursor: page.nextCursor };
  return { ...current, gaps: current.gaps.flatMap(gap => {
    if (gap.id !== request.gapId) return [gap];
    const reachedBoundary = page.items.some(item => gap.boundaryIds.includes(item.id));
    return reachedBoundary || !page.nextCursor ? [] : [{ ...gap, cursor: page.nextCursor }];
  }) };
}
