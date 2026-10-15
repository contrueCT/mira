import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import type { SubagentSpec, SubagentWriter, ToolIntent } from '@mira/life';
import { encodeEntry, messageEntry } from '@mira/runtime-pi';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, input } from './fixtures.mts';

const spec: SubagentSpec = { task: 'Original child assignment', fork: { mode: 'none', parentVersion: 0, parentHead: null, text: '', bytes: 0 }, model: { provider: 'offline', id: 'offline', api: 'openai-responses', configurationHash: 'a'.repeat(64) } };
async function parentCall(writer: SubagentWriter, callId: string) {
  let state = await writer.load();
  if (!state.records.length) {
    await writer.append(0,encodeEntry(messageEntry(assistant('Synthetic parent instruction source'),null)));
    state = await writer.load();
  }
  const intent: ToolIntent = { callId, assistantRecordId: state.records.at(-1)!.id, toolName: 'subagent_send', requestedArguments: {}, arguments: {}, occurredAt: new Date().toISOString() };
  await writer.beginTool(state.version,intent);
}
async function setup(db: Awaited<ReturnType<typeof createTestDatabase>>) {
  const parent = await db.acquire('parent'); await parentCall(parent,'spawn');
  const child = await parent.createSubagent('spawn',spec,8);
  const turn = await parent.claimSubagentTurn(child.id); assert(turn);
  const writer = await db.acquire(child.streamId);
  const initial = encodeEntry(messageEntry(input('Original child assignment'),null));
  await writer.appendTaskInput(turn.id,0,initial);
  return { parent,child,turn,writer,initial };
}

test('task PostgreSQL inbox owns parent calls, preserves order, fences child streams and arbitrates final', async () => {
  const db = await createTestDatabase();
  try {
    const { parent,child,turn,writer,initial } = await setup(db);
    for (const id of ['first','second','after-final']) await parentCall(parent,id);
    await parent.sendSubagent('first',child.id,'First live instruction',8);
    await parent.sendSubagent('second',child.id,'Second live instruction',8);
    await parent.sendSubagent('first',child.id,'First live instruction',8);
    await assert.rejects(parent.sendSubagent('first',child.id,'Changed instruction',8), /different content/);
    await assert.rejects(parent.createSubagent('first',spec,8), /already identifies/);
    const receipt = await parent.findSubagentCall('first'); assert(receipt?.followup);
    assert.equal(receipt.turn.id,turn.id); assert.equal(receipt.turn.instruction,spec.task);
    assert.equal(receipt.followup.instruction,'First live instruction'); assert.equal(receipt.followup.status,'pending');
    assert.equal((await parent.getSubagent(child.id))!.turnCount,1);
    assert.deepEqual((await writer.loadTaskInputs(turn.id)).map(row => row.callId), ['first','second']);
    assert.equal((await writer.loadTaskTurn(turn.id)).callId,'spawn');
    const stranger = await db.acquire('unrelated-child');
    await assert.rejects(stranger.loadTaskTurn(turn.id), /does not belong/);
    await assert.rejects(stranger.loadTaskInputs(turn.id), /does not belong/);
    const intent: ToolIntent = { callId: 'blocked-sibling', assistantRecordId: initial.id, toolName: 'effect', arguments: {}, requestedArguments: {}, occurredAt: new Date().toISOString() };
    assert.equal(await writer.tryBeginTaskTool(turn.id,1,intent),false);
    const oldFinal = encodeEntry(messageEntry(assistant('Stale final'),initial.id));
    assert.equal(await writer.tryAppendTaskFinal(turn.id,1,oldFinal),null);
    const first = encodeEntry(messageEntry(input('First live instruction'),initial.id));
    await assert.rejects(writer.appendTaskLiveInput(turn.id,'second',1,first), /receipt order/);
    await assert.rejects(writer.appendTaskLiveInput(turn.id,'first',2,first), /Stale context version/);
    assert.equal(await writer.appendTaskLiveInput(turn.id,'first',1,first),2);
    assert.equal(await writer.appendTaskLiveInput(turn.id,'first',1,first),2);
    assert.equal((await parent.findSubagentCall('first'))!.followup!.status,'consumed');
    const second = encodeEntry(messageEntry(input('Second live instruction'),first.id));
    assert.equal(await writer.appendTaskLiveInput(turn.id,'second',2,second),3);
    const final = encodeEntry(messageEntry(assistant('Current final'),second.id));
    assert.equal(await writer.tryAppendTaskFinal(turn.id,3,final),4);
    assert.equal(await writer.tryAppendTaskFinal(turn.id,3,final),4);
    await parent.sendSubagent('after-final',child.id,'A new turn',8);
    await parent.sendSubagent('after-final',child.id,'A new turn',8);
    assert.equal((await parent.getSubagent(child.id))!.turnCount,2);
    assert.equal((await parent.findSubagentCall('after-final'))!.followup,undefined);
    assert.equal((await writer.loadTaskInputs(turn.id)).length,2);
    assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM wake_runs WHERE mira_id=$1', [child.streamId])).rows[0].count,0);
    assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM tool_executions WHERE mira_id=$1', [child.streamId])).rows[0].count,0);
    await assert.rejects(db.admin.query('UPDATE subagent_live_inputs SET instruction=$1 WHERE call_id=$2', ['mutated','first']), /immutable/);
    assert.equal(parent.signal.aborted,false); assert.equal(writer.signal.aborted,false);
  } finally { await db.close(); }
});

for (const winner of ['input','final'] as const) test(`task PostgreSQL separate owner connections serialize ${winner}-first COMMIT against the competing admission`, { timeout: 20_000 }, async () => {
  const db = await createTestDatabase(); const entered = deferred(), release = deferred();
  const original = Client.prototype.query;
  try {
    const { parent,child,turn,writer,initial } = await setup(db); await parentCall(parent,'race');
    const final = encodeEntry(messageEntry(assistant('Candidate final'),initial.id));
    let boundary: Client | undefined, paused = false;
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if ((winner === 'input' && sql.startsWith('INSERT INTO subagent_live_inputs')) || (winner === 'final' && sql.startsWith('UPDATE subagent_turns SET final_record_id='))) boundary = this;
      if (this === boundary && sql === 'COMMIT' && !paused) {
        paused = true; entered.resolve();
        return release.promise.then(() => Reflect.apply(original,this,args));
      }
      return Reflect.apply(original,this,args);
    } as typeof original;
    const leading = winner === 'input' ? parent.sendSubagent('race',child.id,'Committed racing instruction',8) : writer.tryAppendTaskFinal(turn.id,1,final);
    await entered.promise;
    let competingSettled = false;
    const competing = (winner === 'input' ? writer.tryAppendTaskFinal(turn.id,1,final) : parent.sendSubagent('race',child.id,'Committed racing instruction',8)).finally(() => { competingSettled = true; });
    // Observe the real waiter instead of guessing whether a delayed promise ran.
    const deadline = Date.now()+5_000;
    for (;;) {
      const waiting = await db.admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT child_id FROM subagents%' AND pid<>pg_backend_pid()");
      if (waiting.rows[0].count > 0) break;
      if (Date.now()>deadline) throw Error('Competing task boundary did not block on the database lock');
      await new Promise(resolve => setTimeout(resolve,10));
    }
    assert.equal(competingSettled,false); release.resolve();
    const [first,second] = await Promise.all([leading,competing]);
    const saved = await parent.findSubagentCall('race'); assert(saved);
    if (winner === 'input') { assert.equal(second,null); assert.equal(saved.followup?.status,'pending'); assert.equal((await writer.loadTaskTurn(turn.id)).finalRecordId,null); }
    else { assert.equal(first,2); assert.equal(saved.followup,undefined); assert.notEqual(saved.turn.id,turn.id); }
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM subagent_calls WHERE call_id='race'")).rows[0].count,1);
  } finally { release.resolve(); Client.prototype.query = original; await db.close(); }
});

test('task PostgreSQL pending capacity and cancellation/restart keep unknown effects and never move an old inbox into a new turn', async () => {
  const db = await createTestDatabase();
  try {
    const { parent,child,turn,writer,initial } = await setup(db);
    const intent: ToolIntent = { callId: 'unknown-effect', assistantRecordId: initial.id, toolName: 'effect', arguments: {}, requestedArguments: {}, occurredAt: new Date().toISOString() };
    assert.equal(await writer.tryBeginTaskTool(turn.id,1,intent),true);
    for (let index=0; index<17; index++) {
      await parentCall(parent,`input-${index}`);
      if (index<16) await parent.sendSubagent(`input-${index}`,child.id,`Instruction ${index}`,8);
      else await assert.rejects(parent.sendSubagent(`input-${index}`,child.id,`Instruction ${index}`,8), /too many pending/);
    }
    assert.equal((await writer.loadTaskInputs(turn.id)).length,16);
    await parent.cancelSubagent(child.id);
    assert.equal((await parent.findSubagentCall('input-0'))!.followup!.status,'cancelled');
    await assert.rejects(writer.loadTaskInputs(turn.id), /not active/);
    await assert.rejects(writer.tryBeginTaskTool(turn.id,1,{ ...intent,callId: 'after-cancel' }), /active initialized turn/);
    assert.equal((await writer.load()).executions[0]!.outcome,null);
    await parent.sendSubagent('input-0',child.id,'Instruction 0',8);
    assert.equal((await parent.getSubagent(child.id))!.turnCount,1,'retry of cancelled receipt cannot create work');
    await writer.close(); await parent.close();
    const restarted = await db.acquire('parent'); await restarted.interruptSubagents();
    assert.equal(await restarted.claimSubagentTurn(child.id),null);
    await restarted.sendSubagent('input-16',child.id,'Explicit continuation',8);
    const next = await restarted.claimSubagentTurn(child.id); assert(next); assert.notEqual(next.id,turn.id);
    const recovered = await db.acquire(child.streamId);
    assert.deepEqual(await recovered.loadTaskInputs(next.id),[]);
    assert.equal((await recovered.load()).executions[0]!.outcome,null);
    await parentCall(restarted,'pending-at-restart'); await restarted.sendSubagent('pending-at-restart',child.id,'Pending before restart',8);
    await recovered.close(); await restarted.close();
    const thirdOwner = await db.acquire('parent'); await thirdOwner.interruptSubagents();
    assert.equal((await thirdOwner.findSubagentCall('pending-at-restart'))!.followup!.status,'interrupted');
    assert.equal(await thirdOwner.claimSubagentTurn(child.id),null);
  } finally { await db.close(); }
});

test('task PostgreSQL live-call management associations use the calling parent run', async () => {
  const db = await createTestDatabase();
  try {
    const { parent,child,turn } = await setup(db);
    await parent.receive({ id: 'followup-run', source: 'user', type: 'message', occurredAt: new Date().toISOString(), payload: 'Continue delegated work' }, { id: 'followup-run', reason: 'new request' });
    const run = await parent.claimWakeBatch(); assert(run);
    const state = await parent.load();
    await parent.appendWakeInput(run.id,state.version,encodeEntry(messageEntry(input('Continue delegated work'),state.records.at(-1)!.id)));
    await parentCall(parent,'new-run-live-call'); await parent.sendSubagent('new-run-live-call',child.id,'New run instruction',8);
    assert.equal((await parent.getSubagentForRun(child.id,run.id))!.id,child.id);
    assert.deepEqual((await parent.readSubagentsForRun(run.id)).children.map(value => value.id),[child.id]);
    const calls = await db.store.subagents('parent').readSubagentCalls(['new-run-live-call']);
    assert.equal(calls.length,1); assert.equal(calls[0]!.runId,run.id); assert.equal(calls[0]!.turnId,turn.id);
    const otherParent = await db.acquire('different-parent');
    assert.equal(await otherParent.findSubagentCall('new-run-live-call'),null);
    assert.equal(await otherParent.getSubagent(child.id),null);
  } finally { await db.close(); }
});

for (const boundary of ['receipt','consumption'] as const) test(`task PostgreSQL lost ${boundary} COMMIT acknowledgement preserves exact immutable evidence`, async () => {
  const db = await createTestDatabase(); const original = Client.prototype.query;
  try {
    const { parent,child,turn,writer,initial } = await setup(db); await parentCall(parent,'ambiguous-followup');
    if (boundary === 'consumption') await parent.sendSubagent('ambiguous-followup',child.id,'Exact committed instruction',8);
    const consumed = encodeEntry(messageEntry(input('Exact committed instruction'),initial.id));
    let target: Client | undefined, thrown = false;
    Client.prototype.query = function (this: Client, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : '';
      if (boundary === 'receipt' ? sql.startsWith('INSERT INTO subagent_live_inputs') : sql.startsWith('UPDATE subagent_live_inputs SET input_record_id=')) target = this;
      const response = Reflect.apply(original,this,args);
      if (this === target && sql === 'COMMIT' && !thrown) {
        thrown = true;
        return Promise.resolve(response).then(() => { throw Error('Synthetic lost task COMMIT acknowledgement'); });
      }
      return response;
    } as typeof original;
    if (boundary === 'receipt') {
      await assert.rejects(parent.sendSubagent('ambiguous-followup',child.id,'Exact committed instruction',8), /lost task COMMIT acknowledgement/);
      assert.equal(parent.signal.aborted,true); await assert.rejects(parent.getSubagent(child.id), /stopped/);
      await parent.close(); Client.prototype.query = original;
      const recovered = await db.acquire('parent');
      await recovered.sendSubagent('ambiguous-followup',child.id,'Exact committed instruction',8);
      const saved = await recovered.findSubagentCall('ambiguous-followup'); assert(saved?.followup);
      assert.equal(saved.turn.id,turn.id); assert.equal(saved.followup.status,'pending');
      assert.equal(saved.followup.instruction,'Exact committed instruction');
      await assert.rejects(recovered.sendSubagent('ambiguous-followup',child.id,'Replacement content',8), /different content/);
      assert.equal((await recovered.getSubagent(child.id))!.turnCount,1);
      await recovered.interruptSubagents();
      assert.equal((await recovered.findSubagentCall('ambiguous-followup'))!.followup!.status,'interrupted');
      assert.equal(await recovered.claimSubagentTurn(child.id),null);
    } else {
      await assert.rejects(writer.appendTaskLiveInput(turn.id,'ambiguous-followup',1,consumed), /lost task COMMIT acknowledgement/);
      assert.equal(writer.signal.aborted,true); await assert.rejects(writer.loadTaskTurn(turn.id), /stopped/);
      await writer.close(); Client.prototype.query = original;
      const recovered = await db.acquire(child.streamId);
      const snapshot = await recovered.load(); assert.equal(snapshot.version,2); assert.deepEqual(snapshot.records[1],consumed);
      assert.equal((await recovered.loadTaskInputs(turn.id))[0]!.inputRecordId,consumed.id);
      assert.equal((await parent.findSubagentCall('ambiguous-followup'))!.followup!.status,'consumed');
      assert.equal(await recovered.appendTaskLiveInput(turn.id,'ambiguous-followup',1,consumed),2);
      assert.deepEqual(await recovered.load(),snapshot,'retry only acknowledges the original atomic input append');
    }
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM subagent_calls WHERE call_id='ambiguous-followup'")).rows[0].count,1);
    assert.equal((await db.admin.query("SELECT count(*)::int AS count FROM subagent_live_inputs WHERE call_id='ambiguous-followup'")).rows[0].count,1);
  } finally { Client.prototype.query = original; await db.close(); }
});

test('task PostgreSQL pre-claim supplements preserve order across queued and final-won transitions', async () => {
  const db = await createTestDatabase();
  try {
    const parent = await db.acquire('queued-order-parent');
    for (const id of ['spawn-queued','before-claim','after-claim','next-turn','next-before-claim']) await parentCall(parent,id);
    const child = await parent.createSubagent('spawn-queued',spec,8);
    await parent.sendSubagent('before-claim',child.id,'FIRST',8);
    const first = await parent.findSubagentCall('before-claim'); assert(first?.followup);
    assert.equal(first.turn.status,'queued'); assert.equal(first.turn.id,child.turns[0]!.id);
    const turn = await parent.claimSubagentTurn(child.id); assert(turn);
    await parent.sendSubagent('after-claim',child.id,'SECOND',8);
    const writer = await db.acquire(child.streamId);
    assert.deepEqual((await writer.loadTaskInputs(turn.id)).map(value => value.instruction),['FIRST','SECOND']);
    assert.equal((await parent.getSubagent(child.id))!.turnCount,1);
    let record = encodeEntry(messageEntry(input('Original assignment'),null));
    let version = await writer.appendTaskInput(turn.id,0,record);
    for (const value of await writer.loadTaskInputs(turn.id)) {
      record = encodeEntry(messageEntry(input(value.instruction),record.id));
      version = await writer.appendTaskLiveInput(turn.id,value.callId,version,record);
    }
    const final = encodeEntry(messageEntry(assistant('First task complete'),record.id));
    assert.equal(await writer.tryAppendTaskFinal(turn.id,version,final),version+1);
    await parent.sendSubagent('next-turn',child.id,'NEXT_TASK',8);
    const next = (await parent.findSubagentCall('next-turn'))!;
    assert.equal(next.followup,undefined); assert.notEqual(next.turn.id,turn.id);
    await parent.sendSubagent('next-before-claim',child.id,'NEXT_SUPPLEMENT',8);
    const extra = (await parent.findSubagentCall('next-before-claim'))!;
    assert.equal(extra.turn.id,next.turn.id); assert.equal(extra.followup!.status,'pending');
    assert.equal((await parent.getSubagent(child.id))!.turnCount,2);
  } finally { await db.close(); }
});
