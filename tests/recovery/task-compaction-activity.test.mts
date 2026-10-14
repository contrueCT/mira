import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import type { SubagentSpec } from '@mira/life';
import { PiDurableRuntime, type PiRuntimeActivity } from '@mira/runtime-pi';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, model, seed, streamOf } from './fixtures.mts';

const spec: SubagentSpec = { task: 'Read-only investigation', fork: { mode: 'none', parentVersion: 0, parentHead: null, text: '', bytes: 0 },
  model: { provider: model.provider, id: model.id, api: model.api, configurationHash: 'a'.repeat(64) } };
async function register(db: Awaited<ReturnType<typeof createTestDatabase>>) {
  const parent = await db.acquire('summary-activity-parent'); const callId = 'spawn-summary-activity';
  // Keep the real immutable parent tool-intent association required by the FK.
  await seed(parent, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: callId, name: 'subagent_spawn', arguments: {} }] }]);
  const state = await parent.load();
  await parent.beginTool(state.version, { callId, toolName: 'subagent_spawn', assistantRecordId: state.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: new Date().toISOString() });
  const child = await parent.createSubagent(callId, spec, 8); const turn = await parent.claimSubagentTurn(child.id); assert.ok(turn);
  const writer = await db.acquire(child.streamId);
  await seed(writer, [{ role: 'system', content: 'Task-scoped read-only worker.', timestamp: 1000 }, input('Read the assigned sources'), assistant('source findings '.repeat(200)),
    input('Continue investigation'), assistant('more source findings '.repeat(200)), input('Preserve source IDs')]);
  return { parent, child, turn, writer };
}

for (const boundary of ['before-commit', 'after-commit', 'cancel-wins-parent', 'cancel-wins-parent-no-callback', 'lost-writer', 'lost-writer-no-callback'] as const) {
  test(`real PostgreSQL summary activity reconciles ${boundary} with independent parent evidence`, { timeout: 30_000 }, async context => {
    const db = await createTestDatabase();
    try {
      const { parent, child, turn, writer } = await register(db); const controller = new AbortController();
      const before = await writer.load(); const events: PiRuntimeActivity[] = []; let childClient: Client | undefined; let injected = false;
      const query = Client.prototype.query;
      const hook = context.mock.method(Client.prototype, 'query', async function(this: Client, ...args: unknown[]) {
        const sql = args[0]; const values = args[1] as unknown[] | undefined;
        const checkpointInsert = typeof sql === 'string' && sql.startsWith('INSERT INTO context_records') && values?.[0] === child.streamId
          && JSON.parse(values[4] as string).kind === 'checkpoint';
        if (checkpointInsert) childClient = this;
        const commit = this === childClient && sql === 'COMMIT' && !injected;
        if (commit && boundary.startsWith('cancel-wins-parent')) {
          // The child passed its final abort check and dispatched COMMIT. Parent
          // cancellation commits first while the checkpoint is still invisible.
          injected = true; controller.abort(Error('Cancel after COMMIT dispatch'));
          await parent.cancelSubagent(child.id);
          assert.equal((await parent.getSubagent(child.id))!.turns[0]!.activity.events.at(-1)?.status, 'interrupted');
        }
        const answer: unknown = await Reflect.apply(query, this, args);
        if (checkpointInsert && boundary === 'before-commit') {
          injected = true; controller.abort(Error('Cancel before checkpoint COMMIT'));
          await parent.cancelSubagent(child.id);
        }
        if (commit && !boundary.startsWith('cancel-wins-parent')) {
          injected = true;
          if (boundary === 'after-commit') { controller.abort(Error('Cancel after checkpoint COMMIT')); await parent.cancelSubagent(child.id); }
          else throw Error('Synthetic lost child COMMIT acknowledgement');
        }
        return answer;
      });
      try {
        const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(assistant('PG_SUMMARY_EVIDENCE')),
          onActivity: async event => {
            events.push(event);
            if (event.phase === 'finished' && boundary.endsWith('no-callback')) return;
            await parent.recordSubagentActivity(turn.id, { ...event, source: 'runtime', text: null });
          } });
        await assert.rejects(runtime.compact({ keepRecentTokens: 200, signal: controller.signal }));
      } finally { hook.mock.restore(); }
      assert.equal(injected, true);
      if (boundary.startsWith('lost-writer')) {
        assert.equal(writer.signal.aborted, true, 'the actual PostgreSQL writer permanently stops on lost COMMIT response');
        // Exercise startup recovery of the registered start with no callback.
        if (boundary === 'lost-writer-no-callback') {
          await parent.close(); const replacement = await db.acquire(parent.miraId); await replacement.interruptSubagents();
        } else await parent.finishSubagentTurn(turn.id, 'interrupted', { text: 'Writer lost; inspect preserved transcript.', truncated: false, fullResultPath: null, finalRecordId: null });
      }
      if (boundary === 'cancel-wins-parent-no-callback') await parent.close();
      const stored = (await db.admin.query('SELECT activity,result,status,finished_at FROM subagent_turns WHERE turn_id=$1', [turn.id])).rows[0];
      const saved = (await db.store.subagents(parent.miraId).getSubagent(child.id))!.turns[0]!;
      const checkpoints = (await db.admin.query("SELECT record_id FROM context_records WHERE mira_id=$1 AND envelope->>'kind'='checkpoint'", [child.streamId])).rows;
      const committed = boundary !== 'before-commit';
      assert.equal(checkpoints.length, Number(committed)); assert.ok(events[0]?.checkpointId);
      if (committed) assert.equal(checkpoints[0].record_id, events[0]?.checkpointId);
      assert.equal(saved.status, boundary.startsWith('lost-writer') ? 'interrupted' : 'cancelled');
      assert.equal(saved.activity.current, null); assert.equal(saved.activity.events.length, 2);
      assert.equal(saved.activity.events.at(-1)?.status, committed ? 'completed' : 'interrupted');
      assert.equal(saved.activity.events.at(-1)?.checkpointId, events[0]?.checkpointId);
      if (boundary.startsWith('cancel-wins-parent')) {
        assert.equal(stored.activity.events.at(-1)?.status, 'interrupted', 'read projection does not relax terminal-row immutability');
        assert.deepEqual((await db.admin.query('SELECT activity,result,status,finished_at FROM subagent_turns WHERE turn_id=$1', [turn.id])).rows[0], stored);
        await assert.rejects(db.admin.query('UPDATE subagent_turns SET activity=$2::jsonb WHERE turn_id=$1', [turn.id, JSON.stringify(saved.activity)]), /immutable/);
      }
      assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n, 1);
      const after = (await db.admin.query('SELECT envelope FROM context_records WHERE mira_id=$1 ORDER BY version', [child.streamId])).rows.map(row => row.envelope);
      assert.deepEqual(after.slice(0, before.records.length), before.records, 'checkpoint activity never rewrites original history');
      assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM context_records WHERE mira_id=$1 AND envelope->>'kind'='checkpoint'", [parent.miraId])).rows[0].n, 0);
    } finally { await db.close(); }
  });
}

for (const evidence of ['foreign-checkpoint', 'same-stream-message'] as const) {
  test(`real PostgreSQL terminal summary projection rejects ${evidence}`, { timeout: 30_000 }, async () => {
    const db = await createTestDatabase();
    try {
      const { parent, child, turn, writer } = await register(db);
      let checkpointId = (await writer.load()).records[0]!.id;
      if (evidence === 'foreign-checkpoint') {
        const siblingCall = 'spawn-sibling-summary';
        await seed(parent, [{ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: siblingCall, name: 'subagent_spawn', arguments: {} }] }]);
        const state = await parent.load();
        await parent.beginTool(state.version, { callId: siblingCall, toolName: 'subagent_spawn', assistantRecordId: state.records.at(-1)!.id, arguments: {}, requestedArguments: {}, occurredAt: new Date().toISOString() });
        const sibling = await parent.createSubagent(siblingCall, spec, 8);
        const other = await db.acquire(sibling.streamId); await seed(other, [input('old '.repeat(500)), assistant('old '.repeat(500)), input('new')]);
        await new PiDurableRuntime({ writer: other, model, compactionScope: 'task', streamFn: () => streamOf(assistant('Other summary')) }).compact({ keepRecentTokens: 100 });
        checkpointId = (await other.load()).records.find(record => record.kind === 'checkpoint')!.id;
      }
      const start = { kind: 'model' as const, phase: 'started' as const, source: 'runtime' as const, text: null, occurredAt: new Date().toISOString(), name: 'context-compaction', callId: null, checkpointId, status: null };
      await parent.recordSubagentActivity(turn.id, start);
      await parent.recordSubagentActivity(turn.id, { ...start, phase: 'finished', status: 'completed' });
      assert.equal((await parent.getSubagent(child.id))!.turns[0]!.activity.events.at(-1)?.status, 'interrupted');
      await parent.cancelSubagent(child.id); await parent.close();
      const saved = (await db.store.subagents(parent.miraId).getSubagent(child.id))!.turns[0]!;
      assert.equal(saved.status, 'cancelled'); assert.equal(saved.activity.events.at(-1)?.status, 'interrupted');
      assert.equal((await db.store.subagents(parent.miraId).findSubagentCall('spawn-summary-activity'))!.turn.activity.events.at(-1)?.status, 'interrupted');
    } finally { await db.close(); }
  });
}
