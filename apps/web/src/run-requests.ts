import type { RunRequest, RunRequestsPage } from './types.ts';

export interface RunRequestsRead { runId: string; cursor: string; generation: number }
export interface RunRequestsState {
  runId: string; items: RunRequest[]; nextCursor: string | null; initialized: boolean;
  generation: number; reading: RunRequestsRead | null;
}
export const emptyRunRequests = (runId: string): RunRequestsState => ({ runId, items: [], nextCursor: null, initialized: false, generation: 0, reading: null });
function mergeRequests(known: RunRequest[], incoming: RunRequest[]): RunRequest[] {
  const items = new Map(known.map(item => [item.eventId, item]));
  for (const item of incoming) items.set(item.eventId, item);
  return [...items.values()];
}
/** Wake membership is fixed at claim time. Re-reading its first page updates the
 * known metadata without rewinding the independently advanced member cursor. */
export function seedRunRequests(state: RunRequestsState, runId: string, items: RunRequest[], nextCursor: string | null): RunRequestsState {
  if (state.runId !== runId) return state;
  return { ...state, items: mergeRequests(state.items, items), nextCursor: state.initialized ? state.nextCursor : nextCursor, initialized: true };
}
export function beginRunRequests(state: RunRequestsState): RunRequestsState {
  if (state.reading || !state.nextCursor) return state;
  const generation = state.generation + 1;
  return { ...state, generation, reading: { runId: state.runId, cursor: state.nextCursor, generation } };
}
export function matchesRunRequests(state: RunRequestsState, request: RunRequestsRead): boolean {
  return state.runId === request.runId && state.generation === request.generation && state.reading?.cursor === request.cursor;
}
export function acceptRunRequests(state: RunRequestsState, request: RunRequestsRead, page: RunRequestsPage): RunRequestsState {
  if (!matchesRunRequests(state, request)) return state;
  return { ...state, items: mergeRequests(page.items, state.items), nextCursor: page.nextCursor, reading: null };
}
export function finishRunRequests(state: RunRequestsState, request: RunRequestsRead): RunRequestsState {
  return matchesRunRequests(state, request) ? { ...state, reading: null } : state;
}
export function cancelRunRequests(state: RunRequestsState): RunRequestsState {
  return { ...state, generation: state.generation + 1, reading: null };
}
