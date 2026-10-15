import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiDurableRuntime, type PiRuntimeActivity } from '@mira/runtime-pi';
import { MemoryWriter, assistant, streamOf, model, seed, input } from '../recovery/fixtures.mts';

async function history(writer: MemoryWriter) {
  await seed(writer, [
    { role: 'system', content: 'Task-scoped read-only worker. Do not publish.', timestamp: 1000 },
    input('Read the assigned sources'), assistant('source findings '.repeat(200)),
    input('Continue the investigation'), assistant('more source findings '.repeat(200)), input('Preserve source IDs'),
  ]);
}

test('summary activity observer failure stops before provider dispatch and checkpoint', async () => {
  const writer = new MemoryWriter(); await history(writer); let requests = 0;
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task',
    streamFn: () => { requests++; return streamOf(assistant('summary')); },
    onActivity: async event => { if (event.phase === 'started') throw Error('synthetic activity write failure'); } });
  await assert.rejects(runtime.compact({ keepRecentTokens: 200 }), /synthetic activity write failure/);
  assert.equal(requests, 0); assert.equal(writer.state.records.filter(record => record.kind === 'checkpoint').length, 0);
});

test('summary activity distinguishes durable checkpoint completion from cancellation after append', async () => {
  const writer = new MemoryWriter(); await history(writer); const events: PiRuntimeActivity[] = []; const controller = new AbortController();
  const append = writer.append.bind(writer);
  writer.append = async (version, record, signal) => {
    const next = await append(version, record, signal);
    if (record.kind === 'checkpoint') { controller.abort(Error('cancel after checkpoint commit')); throw Error('lost append response'); }
    return next;
  };
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(assistant('summary')),
    onActivity: async event => { events.push(event); } });
  await assert.rejects(runtime.compact({ keepRecentTokens: 200, signal: controller.signal }));
  assert.equal(writer.state.records.filter(record => record.kind === 'checkpoint').length, 1);
  assert.deepEqual(events.map(event => [event.name, event.phase, event.status]), [
    ['context-compaction', 'started', null], ['context-compaction', 'finished', 'completed'],
  ]);
});

test('summary publication failure reports failed activity and never completes the checkpoint', async () => {
  const writer = new MemoryWriter(); await history(writer); const events: PiRuntimeActivity[] = [];
  writer.beforeAppend = async record => { if (record.kind === 'checkpoint') throw Error('synthetic checkpoint failure'); };
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(assistant('summary')),
    onActivity: async event => { events.push(event); } });
  await assert.rejects(runtime.compact({ keepRecentTokens: 200 }), /synthetic checkpoint failure/);
  assert.equal(writer.state.records.filter(record => record.kind === 'checkpoint').length, 0);
  assert.equal(events.at(-1)?.status, 'failed');
});

// These tests exercise the production registry and Pi with synthetic SQL only;
// the matching PostgreSQL transaction-boundary suite is a separate gate.
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { emptySubagentActivity, type SubagentActivityInput, type SubagentResult, type SubagentTurn } from '@mira/life';
import { PostgresSubagents } from '../../packages/persistence/src/subagents.ts';
const cancelledResult: SubagentResult = { text: 'Cancelled; preserve evidence.', truncated: false, fullResultPath: null, finalRecordId: null };
function registryFixture(writer: MemoryWriter) {
  const row = { turn_id: randomUUID(), child_id: randomUUID(), call_id: 'spawn', sequence: 1, instruction: 'Read only', status: 'running' as SubagentTurn['status'],
    created_at: new Date().toISOString(), started_at: new Date().toISOString(), activity: emptySubagentActivity(), finished_at: null as string | null, result: null as SubagentResult | null };
  let receipts = 0;
  const client = { query: async (sql: string, args: unknown[]) => {
    if (sql.startsWith('SELECT * FROM subagent_turns WHERE parent_mira_id=$1 AND turn_id=$2')) return { rows: [structuredClone(row)] };
    if (sql.startsWith('SELECT * FROM subagents WHERE parent_mira_id=$1 AND child_id=$2')) return { rows: [{ child_id: row.child_id, stream_id: writer.miraId, spawn_call_id: 'spawn', created_at: row.created_at, spec: {} }] };
    if (sql.startsWith('SELECT coalesce(max(sequence)')) return { rows: [{ count: 1 }] };
    if (sql.startsWith('(SELECT * FROM subagent_turns')) return { rows: [structuredClone(row)] };
    if (sql.startsWith('SELECT child.child_id,record.record_id')) {
      assert.match(sql, /child.stream_id=record.mira_id/); assert.match(sql, /record.envelope->>'kind'='checkpoint'/);
      return { rows: writer.state.records.filter(record => record.kind === 'checkpoint' && (args[1] as string[]).includes(record.id)).map(record => ({ child_id: row.child_id, record_id: record.id })) };
    }
    if (sql.startsWith('UPDATE subagent_turns SET activity=')) { row.activity = JSON.parse(args[1] as string); return { rows: [] }; }
    if (sql.startsWith('UPDATE subagent_turns SET status=')) {
      row.status = args[1] as SubagentTurn['status']; row.finished_at = args[2] as string; row.result = JSON.parse(args[3] as string); row.activity = JSON.parse(args[4] as string); return { rows: [] };
    }
    if (sql.includes(' AS committed')) {
      assert.match(sql, /child.parent_mira_id=\$1 AND child.child_id=\$2/);
      assert.match(sql, /child.stream_id=record.mira_id/); assert.match(sql, /record.envelope->>'kind'='checkpoint'/);
      return { rows: [{ committed: args[1] === row.child_id && writer.state.records.some(record => record.id === args[2] && record.kind === 'checkpoint') }] };
    }
    throw Error(`Unexpected fixture SQL: ${sql}`);
  } } as unknown as Client;
  const registry = new PostgresSubagents(client, 'parent', async work => work(), async () => { receipts++; return null; }, () => {});
  return { registry, row, receipts: () => receipts };
}
for (const boundary of ['before-commit', 'after-commit', 'cancel-wins-parent', 'cancel-wins-parent-no-callback', 'lost-writer', 'lost-writer-no-callback'] as const) {
  test(`actual registry confirms exact summary evidence at ${boundary} (offline SQL fixture)`, async () => {
    const writer = new MemoryWriter(); await history(writer); const f = registryFixture(writer); const controller = new AbortController();
    const events: PiRuntimeActivity[] = []; const append = writer.append.bind(writer);
    writer.append = async (version, record, signal) => {
      if (record.kind !== 'checkpoint') return append(version, record, signal);
      if (boundary === 'before-commit' || boundary.startsWith('cancel-wins-parent')) {
        controller.abort(Error('Cancel during checkpoint transaction'));
        await f.registry.finish(f.row.turn_id, 'cancelled', cancelledResult);
        assert.equal(f.row.activity.events.at(-1)?.status, 'interrupted');
        if (boundary === 'before-commit') throw controller.signal.reason;
      }
      // cancel-wins-parent models COMMIT already dispatched, beyond abort checks.
      const next = await append(version, record, boundary.startsWith('cancel-wins-parent') ? undefined : signal);
      if (boundary === 'after-commit') { controller.abort(Error('Cancel after COMMIT')); await f.registry.finish(f.row.turn_id, 'cancelled', cancelledResult); }
      if (boundary.startsWith('lost-writer')) writer.controller.abort(Error('Lost COMMIT acknowledgement'));
      throw Error(`Ambiguous append response ${next}`);
    };
    const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(assistant('summary')),
      onActivity: async event => { events.push(event); if (event.phase === 'finished' && boundary.endsWith('no-callback')) return; await f.registry.activity(f.row.turn_id, { ...event, source: 'runtime', text: null }); } });
    await assert.rejects(runtime.compact({ keepRecentTokens: 200, signal: controller.signal }));
    if (boundary.startsWith('lost-writer')) await f.registry.finish(f.row.turn_id, 'interrupted', { ...cancelledResult, text: 'Writer stopped' });
    const committed = boundary !== 'before-commit';
    assert.equal(writer.state.records.filter(record => record.kind === 'checkpoint').length, Number(committed));
    assert.equal((await f.registry.get(f.row.child_id))!.turns[0]!.activity.events.at(-1)?.status, committed ? 'completed' : 'interrupted');
    if (boundary.startsWith('cancel-wins-parent')) assert.equal(f.row.activity.events.at(-1)?.status, 'interrupted', 'terminal storage remains immutable; read projection reconciles late COMMIT');
    assert.equal(f.row.activity.current, null); assert.equal(f.row.activity.events.length, 2); assert.equal(f.receipts(), 1);
    assert.equal(f.row.status, boundary.startsWith('lost-writer') ? 'interrupted' : 'cancelled');
    assert.ok(events[0]?.checkpointId); assert.equal(events.at(-1)?.checkpointId, events[0]?.checkpointId);
    if (committed) assert.equal(writer.state.records.at(-1)?.id, events[0]?.checkpointId);
    const saved = structuredClone(f.row);
    await f.registry.activity(f.row.turn_id, { ...events.at(-1)!, source: 'runtime', text: null });
    await f.registry.activity(f.row.turn_id, { ...events.at(-1)!, checkpointId: randomUUID(), source: 'runtime', text: null });
    await f.registry.activity(f.row.turn_id, { kind: 'progress', phase: 'reported', source: 'worker', text: 'Too late', occurredAt: new Date().toISOString(), name: null, callId: null, status: null });
    assert.deepEqual(f.row, saved); assert.equal(f.receipts(), 1);
    await assert.rejects(f.registry.finish(f.row.turn_id, 'completed', cancelledResult), /immutable/);
  });
}
test('checkpoint identity is accepted only for a canonical summary and must match its recorded start', async () => {
  const writer = new MemoryWriter(); const f = registryFixture(writer); const checkpointId = randomUUID();
  const started: SubagentActivityInput = { kind: 'model', phase: 'started', source: 'runtime', text: null, occurredAt: new Date().toISOString(), name: 'context-compaction', callId: null, checkpointId, status: null };
  for (const invalid of [{ ...started, name: 'ordinary-model' }, { ...started, checkpointId: 'invalid' }, { ...started, checkpointId: undefined }])
    await assert.rejects(async () => f.registry.activity(f.row.turn_id, invalid as SubagentActivityInput), /Invalid public activity/);
  await f.registry.activity(f.row.turn_id, started);
  await assert.rejects(f.registry.activity(f.row.turn_id, { ...started, phase: 'finished', checkpointId: randomUUID(), status: 'completed' }), /exact registered checkpoint/);
  await f.registry.activity(f.row.turn_id, { ...started, phase: 'finished', status: 'completed' });
  assert.equal(f.row.activity.events.at(-1)?.status, 'interrupted', 'a claimed completion without exact durable evidence is not completed');
});
