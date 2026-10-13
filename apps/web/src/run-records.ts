import { latestPagination, nextHistoryRequest, olderPagination } from './timeline.ts';
import type { HistoryPagination, HistoryRequest } from './timeline.ts';
import type { RunExecution } from './types.ts';

export interface RunRecordsState { executions: RunExecution[]; pagination: HistoryPagination; initialized: boolean }
export const emptyRunRecords = (): RunRecordsState => ({ executions: [], pagination: { latestCursor: null, oldestCursor: null, gaps: [] }, initialized: false });
/** Pages are ordered by durable version by the server; wall-clock time may move
 * backwards. New latest values replace old outcomes, older in-flight pages never
 * overwrite newer values, and independent gap frontiers remain reachable. */
export function acceptRunRecords(current: RunRecordsState, page: { executions: RunExecution[]; nextCursor: string | null }, request: HistoryRequest | null = null): RunRecordsState {
  const executions = [...current.executions];
  const gap = request?.gapId ? current.pagination.gaps.find(item => item.id === request.gapId) : null;
  // A non-overlapping gap page belongs after its previously loaded older
  // boundary and before pages already fetched within that gap.
  let insertion = request ? gap ? executions.reduce((at, item, index) => gap.boundaryIds.includes(item.id) ? index + 1 : at, 0) : 0 : executions.length;
  for (let i = 0; i < page.executions.length; i += 1) {
    const incoming = page.executions[i]!;
    const known = executions.findIndex(item => item.id === incoming.id);
    if (known >= 0) { if (!request) executions[known] = incoming; insertion = known + 1; continue; }
    const nextKnown = page.executions.slice(i + 1).map(item => executions.findIndex(existing => existing.id === item.id)).find(index => index >= 0);
    const at = nextKnown ?? insertion;
    executions.splice(at, 0, incoming); insertion = at + 1;
  }
  const projected = { items: page.executions, nextCursor: page.nextCursor };
  const pagination = request ? olderPagination(current.pagination, request, projected) : latestPagination(current.pagination, current.executions, projected, current.initialized);
  return { executions, pagination, initialized: true };
}
export function nextRunRecords(state: RunRecordsState): HistoryRequest | null { return nextHistoryRequest(state.pagination); }
