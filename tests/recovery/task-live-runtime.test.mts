import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { DurableWriter } from '@mira/life';
import { PiDurableRuntime, encodeEntry, messageEntry } from '@mira/runtime-pi';
import { SubagentManager } from '../../apps/server/src/subagents.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, effectTool, model, result, streamOf, toolCalls } from './fixtures.mts';

async function intent(writer: DurableWriter, id: string, name: string) {
  const state = await writer.load();
  const entry = encodeEntry(messageEntry({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: {} }] }, state.records.at(-1)?.id ?? null));
  const version = await writer.append(state.version, entry);
  await writer.beginTool(version, { callId: id, toolName: name, assistantRecordId: entry.id, arguments: {}, requestedArguments: {}, occurredAt: new Date().toISOString() });
}
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > end) throw Error('Child did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

for (const phase of ['tool', 'generation'] as const) {
  test(`real PG manager delivers parent instructions during child ${phase} in the same turn`, { timeout: 30_000 }, async () => {
    const db = await createTestDatabase(); const entered = deferred(), release = deferred(); let manager: SubagentManager | undefined;
    try {
      const parent = await db.acquire('live-parent'); let requests = 0, aborted = false; const effects: string[] = []; const failures: unknown[] = [];
      const transport = { model, streamFn: (_model: unknown, context: { messages: unknown[] }, options?: { signal?: AbortSignal }) => {
        if (++requests === 1) {
          if (phase === 'tool') return streamOf(toolCalls('running-effect', 'old-sibling'));
          const stream = createAssistantMessageEventStream();
          options!.signal!.addEventListener('abort', () => { aborted = true; stream.push({ type: 'error', reason: 'aborted', error: { ...assistant('uncommitted stale generation'), stopReason: 'aborted' } }); }, { once: true });
          entered.resolve(); return stream;
        }
        const text = JSON.stringify(context.messages);
        assert.match(text, /FIRST_PARENT_UPDATE/);
        assert.match(text, /Source: parent agent, not a new human message/);
        if (phase === 'tool') { assert.match(text, /SECOND_PARENT_UPDATE/); assert.ok(text.indexOf('FIRST_PARENT_UPDATE') < text.indexOf('SECOND_PARENT_UPDATE')); assert.match(text, /Execution did not start/); }
        return streamOf(assistant('Followed updated task instruction'));
      } };
      manager = new SubagentManager({ writer: parent, acquire: id => db.acquire(id), tools: () => [effectTool(async (id, _args, signal) => {
        effects.push(id); entered.resolve(); await release.promise; assert.equal(signal?.aborted, false); return result;
      })], writeOverflowInput: async () => { throw Error('No overflow expected'); }, onCompletion: () => {}, onFailure: error => { failures.push(error); } });
      await manager.initialize(); await intent(parent, 'spawn-parent', 'subagent_spawn');
      const child = await manager.spawn('spawn-parent', 'Inspect assigned sources', 'none', transport);
      await entered.promise;
      await intent(parent, 'parent-update-one', 'subagent_send');
      const receipt = await manager.send('parent-update-one', child.id, 'FIRST_PARENT_UPDATE', transport);
      assert.equal(receipt.delivery.route, 'current_turn');
      assert.ok(['pending', 'consumed'].includes(receipt.delivery.status));
      if (phase === 'tool') {
        assert.equal(requests, 1); assert.deepEqual(effects, ['running-effect']);
        await intent(parent, 'parent-update-two', 'subagent_send');
        await manager.send('parent-update-two', child.id, 'SECOND_PARENT_UPDATE', transport);
      }
      await manager.send('parent-update-one', child.id, 'FIRST_PARENT_UPDATE', transport);
      await assert.rejects(manager.send('parent-update-one', child.id, 'MUTATED_UPDATE', transport), /different content/);
      release.resolve();
      await until(async () => (await parent.getSubagent(child.id))!.turns[0]!.status === 'completed');
      await manager.close(); manager = undefined;
      const saved = (await parent.getSubagent(child.id))!;
      assert.equal(saved.turnCount, 1); assert.equal(saved.turns[0]!.result!.text, 'Followed updated task instruction');
      assert.equal((await parent.findSubagentCall('parent-update-one'))!.followup!.status, 'consumed');
      assert.deepEqual(failures, []); assert.equal(requests, 2);
      if (phase === 'generation') assert.equal(aborted, true); else assert.deepEqual(effects, ['running-effect']);
      const childWriter = await db.acquire(saved.streamId);
      const state = await childWriter.load(); assert.doesNotMatch(JSON.stringify(state.records), /uncommitted stale generation/);
      // Recovery reads only evidence; it must never re-execute old effects.
      await new PiDurableRuntime({ writer: childWriter, model, compactionScope: 'task', streamFn: () => { throw Error('No automatic restart'); } }).recover();
      assert.deepEqual(await childWriter.load(), state);
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM life_events WHERE event->>\'type\'=\'subagent.result\'')).rows[0].n, 1);
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE mira_id=$1', [saved.streamId])).rows[0].n, 0);
    } finally { release.resolve(); await manager?.close(); await db.close(); }
  });
}
