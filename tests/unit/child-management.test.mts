import test from 'node:test';
import assert from 'node:assert/strict';
import { childActivity, childDetail, publicChildText } from '../../apps/server/src/management-projections.ts';
import { createLocalHttp } from '../../apps/server/src/http.ts';
import type { WebBackend } from '../../apps/server/src/http.ts';
import type { SubagentRecord } from '@mira/life';

const runId = '11111111-1111-4111-8111-111111111111';
const id = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-14T00:00:00.000Z';
const activity = { sequence: 1, occurredAt: at, source: 'worker' as const, kind: 'progress' as const, phase: 'reported' as const,
  name: null, toolHistoryId: 'PRIVATE_HISTORY_ID', status: null, text: 'Read two files' };
const child: SubagentRecord = { id, streamId: 'PRIVATE_STREAM', spawnCallId: 'PRIVATE_SPAWN', createdAt: at,
  spec: { task: 'PRIVATE_ASSIGNMENT', title: 'Inspect files', fork: { mode: 'none', parentVersion: 0, parentHead: null, text: '', bytes: 0 }, model: { provider: 'test', id: 'test', api: 'test', configurationHash: '0'.repeat(64) } },
  turnCount: 1, turns: [{ id, childId: id, callId: 'PRIVATE_CALL_ID', sequence: 1, instruction: 'PRIVATE_INSTRUCTION', status: 'completed', createdAt: at, startedAt: at, finishedAt: at,
    activity: { current: null, events: [activity], dropped: 0, updatedAt: at },
    result: { text: 'Useful result', truncated: true, fullResultPath: '/PRIVATE/SPOOL', finalRecordId: id } }] };

test('child projection uses only explicit public fields; no tasks, hidden blocks, protocol IDs or spool download', () => {
  const result = childDetail(child, runId);
  assert.equal(result.title, 'Inspect files'); assert.equal(result.turns[0]?.result?.text, 'Useful result');
  assert.equal(result.turns[0]?.activities[0]?.source, 'worker');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const unnamed = structuredClone(child); delete unnamed.spec.title;
  assert.equal(childDetail(unnamed, runId).title, '子任务');
  assert.equal(childActivity({ ...activity, text: 'api_key=secret-value Bearer abcdefghijklmnop' }).text, 'api_key=[redacted] Bearer [redacted]');
  assert.equal(publicChildText('sk-' + 'a'.repeat(30)), '[credential redacted]');
});

test('child read API preserves exact run/child ownership and independently reprojects detail or summary', async () => {
  const backend = { child: async (run: string, childId: string) => run === runId && childId === id ? { ...childDetail(child, runId), privateField: 'PRIVATE' } : null } as unknown as WebBackend;
  const app = createLocalHttp({ backend, port: 3210 });
  const headers = { host: '127.0.0.1:3210', 'x-mira-client': 'web' };
  try {
    const result = await app.inject({ url: `/api/runs/${runId}/subagents/${id}`, headers });
    assert.equal(result.statusCode, 200, result.body); assert.doesNotMatch(result.body, /PRIVATE/);
    assert.equal(result.json().turns[0].activities[0].text, 'Read two files');
    const summary = await app.inject({ url: `/api/runs/${runId}/subagents/${id}?view=summary`, headers });
    assert.equal(summary.statusCode, 200); assert.equal(summary.json().turns, undefined);
    const wrong = await app.inject({ url: `/api/runs/${id}/subagents/${id}`, headers }); assert.equal(wrong.statusCode, 404);
    const invalidCursor = await app.inject({ url: `/api/runs/${runId}/subagents?before=wrong`, headers }); assert.equal(invalidCursor.statusCode, 400);
    const invalid = await app.inject({ url: `/api/runs/${runId}/subagents/${id}?view=raw`, headers }); assert.equal(invalid.statusCode, 400);
  } finally { await app.close(); }
});

test('active turn remains inspectable even when sixteen followups push it beyond recent eight', () => {
  const pending = structuredClone(child); pending.turnCount = 17;
  const first = pending.turns[0]!; first.status = 'running'; first.finishedAt = null;
  pending.turns = Array.from({ length: 17 }, (_, index) => ({ ...first, id: `${index}`, sequence: index + 1, status: index === 0 ? 'running' as const : 'queued' as const }));
  const view = childDetail(pending, runId);
  assert.equal(view.status, 'running'); assert.equal(view.turns.length, 9);
  assert.equal(view.turns[0]?.sequence, 1); assert.equal(view.turns.at(-1)?.sequence, 17);
  assert.equal(view.olderTurns, 8);
});
