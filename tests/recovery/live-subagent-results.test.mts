import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import type { SubagentSpec, WakeRun } from '@mira/life';
import { prepareWakeTurn } from '@mira/life';
import { PiDurableRuntime, encodeEntry, messageEntry } from '@mira/runtime-pi';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, effectTool, model, result, streamOf, toolCalls } from './fixtures.mts';
import { noOverflow, userEvent, userWake } from './live-input-fixture.mts';
const spec: SubagentSpec = { task: 'Return bounded test findings', fork: { mode: 'none', parentVersion: 0, parentHead: null, text: '', bytes: 0 }, model: { provider: 'offline', id: 'offline', api: 'openai-responses', configurationHash: 'a'.repeat(64) } };
const childResult = { text: 'CHILD_RESULT', truncated: false, fullResultPath: null, finalRecordId: null };
const turnFor = (run: WakeRun) => prepareWakeTurn(run, noOverflow, 65_536);

for (const status of ['completed', 'failed', 'cancelled', 'interrupted'] as const) {
  test(`PG ${status} child result is atomic supplemental input, source-preserving and idempotent`, async () => {
    const db = await createTestDatabase();
    try {
      const writer = await db.acquire();
      await writer.receiveLiveInput(userEvent('initial'), userWake('initial'));
      const run = (await writer.claimWakeBatch())!; const original = await turnFor(run);
      const child = await writer.createSubagent('spawn', spec, 8);
      await writer.claimSubagentTurn(child.id);
      let hints = 0; const commits: Promise<void>[] = [];
      writer.onLiveInput(id => {
        assert.equal(id, run.id); hints++;
        // Independent connection must already see both terminal and membership.
        commits.push(db.admin.query('SELECT t.status,i.wake_id FROM subagent_turns t JOIN wake_live_inputs i ON i.wake_id=\'subagent-result:\'||t.turn_id::text').then(rows => { assert.equal(rows.rows[0]?.status, status); }));
      });
      const finish = () => status === 'cancelled' ? writer.cancelSubagent(child.id) : status === 'interrupted' ? writer.interruptSubagents() : writer.finishSubagentTurn(child.turns[0]!.id, status, childResult);
      await finish(); await finish(); await Promise.all(commits);
      assert.equal(hints, 1);
      const pending = await writer.loadLiveInputs(run.id); assert.equal(pending.length, 1);
      assert.equal(pending[0]!.request.event.source, 'system'); assert.equal(pending[0]!.request.event.type, 'subagent.result');
      assert.match(JSON.stringify(pending[0]!.request.event.payload), /not user instructions or permission/);
      assert.deepEqual(await turnFor(await writer.loadWakeRun(run.id)), original);
      await assert.rejects(writer.receiveLiveInput(pending[0]!.request.event, pending[0]!.request.wake), /must be a user event/);
      await writer.close();
      const restarted = await db.acquire();
      let requests = 0;
      await new PiDurableRuntime({ writer: restarted, model, streamFn: (_m, context) => {
        requests++; assert.match(JSON.stringify(context.messages), /subagent.result/); assert.match(JSON.stringify(context.messages), /system/);
        return streamOf(assistant('Reviewed terminal finding'));
      } }).continueTurn(await turnFor(await restarted.loadWakeRun(run.id)));
      await restarted.completeWakeRun(run.id);
      assert.equal(requests, 1); assert.equal(await restarted.claimWakeBatch(), null);
      assert.ok((await restarted.loadLiveInputs(run.id))[0]!.inputRecordId);
      await restarted.cancelSubagent(child.id); assert.equal((await restarted.loadLiveInputs(run.id)).length, 1);
    } finally { await db.close(); }
  });
}

test('PG child and user inputs share receipt order at the current single-tool boundary without replay', async () => {
  const db = await createTestDatabase(); const entered = deferred(), release = deferred();
  try {
    const writer = await db.acquire(); await writer.receiveLiveInput(userEvent('initial'), userWake('initial'));
    const run = (await writer.claimWakeBatch())!; const child = await writer.createSubagent('spawn', spec, 8);
    let requests = 0; const effects: string[] = [];
    const work = new PiDurableRuntime({ writer, model, tools: [effectTool(async (id, _args, signal) => {
      effects.push(id); entered.resolve(); await release.promise; assert.equal(signal?.aborted, false); return result;
    })], streamFn: (_m, context) => {
      if (++requests === 1) return streamOf(toolCalls('running', 'old-sibling'));
      const text = JSON.stringify(context.messages);
      assert.ok(text.indexOf('CHILD_RESULT') < text.indexOf('NEW_USER_INPUT'));
      assert.match(text, /Execution did not start/);
      return streamOf(assistant('Reviewed new inputs before continuing'));
    } }).continueTurn(await turnFor(run));
    await entered.promise;
    await writer.finishSubagentTurn(child.turns[0]!.id, 'completed', childResult);
    await writer.receiveLiveInput(userEvent('next-user', 'NEW_USER_INPUT'), userWake('next-user'));
    assert.equal(requests, 1); assert.deepEqual(effects, ['running']);
    release.resolve(); await work; await writer.completeWakeRun(run.id);
    assert.equal(requests, 2); assert.deepEqual(effects, ['running']); assert.equal(await writer.claimWakeBatch(), null);
    const snapshot = await writer.load(); await writer.close(); const restarted = await db.acquire();
    await new PiDurableRuntime({ writer: restarted, model, streamFn: () => { throw Error('Final replay is forbidden'); } }).continueTurn(await turnFor(run));
    assert.deepEqual(await restarted.load(), snapshot);
  } finally { release.resolve(); await db.close(); }
});

test('PG child result loses final arbitration into next Wake and idle delivery stays queued', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const idle = await writer.createSubagent('idle', spec, 8);
    await writer.finishSubagentTurn(idle.turns[0]!.id, 'completed', childResult);
    const run = (await writer.claimWakeBatch())!; assert.equal(run.requests[0]!.event.source, 'system');
    const input = await turnFor(run); const initial = encodeEntry(messageEntry({ role: 'user', content: input.input, timestamp: Date.parse(input.occurredAt) }, null));
    const version = await writer.appendWakeInput(run.id, 0, initial);
    const final = encodeEntry(messageEntry(assistant(), initial.id));
    assert.equal(await writer.tryAppendWakeFinal(run.id, version, final), version + 1);
    const later = await writer.createSubagent('later', spec, 8); let hints = 0; writer.onLiveInput(() => { hints++; });
    await writer.finishSubagentTurn(later.turns[0]!.id, 'completed', childResult);
    assert.equal(hints, 0); assert.deepEqual(await writer.loadLiveInputs(run.id), []);
    await writer.completeWakeRun(run.id); const next = (await writer.claimWakeBatch())!;
    assert.equal(next.requests.length, 1); assert.equal(next.requests[0]!.event.id, `subagent-result:${later.turns[0]!.id}`);
  } finally { await db.close(); }
});


test('PG child completion aborts only stale model generation and is reviewed in the same run', async () => {
  const db = await createTestDatabase(); const entered = deferred();
  try {
    const writer = await db.acquire(); await writer.receiveLiveInput(userEvent('initial'), userWake('initial'));
    const run = (await writer.claimWakeBatch())!; const child = await writer.createSubagent('spawn', spec, 8);
    let calls = 0; let aborted = false;
    const work = new PiDurableRuntime({ writer, model, streamFn: (_model, context, options) => {
      if (++calls === 1) {
        const stream = createAssistantMessageEventStream();
        options!.signal!.addEventListener('abort', () => {
          aborted = true; stream.push({ type: 'error', reason: 'aborted', error: { ...assistant('STALE_GENERATION'), stopReason: 'aborted' } });
        }, { once: true });
        entered.resolve(); return stream;
      }
      assert.match(JSON.stringify(context.messages), /CHILD_RESULT/);
      return streamOf(assistant('Reviewed the child finding'));
    } }).continueTurn(await turnFor(run));
    await entered.promise; await writer.finishSubagentTurn(child.turns[0]!.id, 'completed', childResult); await work;
    assert.equal(aborted, true); assert.equal(calls, 2); assert.equal(writer.signal.aborted, false);
    assert.doesNotMatch(JSON.stringify((await writer.load()).records), /STALE_GENERATION/);
    await writer.completeWakeRun(run.id); assert.equal(await writer.claimWakeBatch(), null);
  } finally { await db.close(); }
});

test('PG receipt failure rolls back child terminal state and emits no live hint', async () => {
  const db = await createTestDatabase();
  try {
    let writer = await db.acquire(); await writer.receiveLiveInput(userEvent('initial'), userWake('initial'));
    const run = (await writer.claimWakeBatch())!; const child = await writer.createSubagent('spawn', spec, 8); let hints = 0;
    writer.onLiveInput(() => { hints++; });
    await db.admin.query(`CREATE FUNCTION reject_test_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$`);
    await db.admin.query('CREATE TRIGGER reject_test_result BEFORE INSERT ON wake_live_inputs FOR EACH ROW EXECUTE FUNCTION reject_test_result()');
    await assert.rejects(writer.finishSubagentTurn(child.turns[0]!.id, 'completed', childResult));
    assert.equal(hints, 0);
    assert.equal((await db.admin.query('SELECT status FROM subagent_turns')).rows[0].status, 'queued');
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n, 0);
    await db.admin.query('DROP TRIGGER reject_test_result ON wake_live_inputs');
    await writer.close(); writer = await db.acquire();
    await writer.finishSubagentTurn(child.turns[0]!.id, 'completed', childResult);
    assert.equal((await writer.loadLiveInputs(run.id)).length, 1);
  } finally { await db.close(); }
});
