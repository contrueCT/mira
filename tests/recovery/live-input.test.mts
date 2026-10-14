import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import type { LiveWakeInput, RecoverySnapshot, WakeRun } from '@mira/life';
import { prepareWakeTurn } from '@mira/life';
import { PiDurableRuntime, encodeEntry, messageEntry } from '@mira/runtime-pi';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, effectTool, model, result, streamOf, toolCalls, seed, input } from './fixtures.mts';
import { userEvent, userWake, noOverflow } from './live-input-fixture.mts';

const exec = promisify(execFile);
const worker = new URL('./live-input-worker.mts', import.meta.url).pathname;
const guard = new URL('../deny-model-network.mts', import.meta.url).pathname;
const turnFor = (run: WakeRun) => prepareWakeTurn(run, noOverflow, 65_536);

test('real PostgreSQL live input ownership, receipt ordering, CAS and final arbitration', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receiveLiveInput(userEvent('original'), userWake('original'));
    const run = await writer.claimWakeBatch(); assert.ok(run); const original = await turnFor(run);
    let notifications = 0; const unsubscribe = writer.onLiveInput(id => { assert.equal(id, run.id); notifications++; });
    await writer.receiveLiveInput(userEvent('second'), userWake('second'));
    await writer.receiveLiveInput(userEvent('third'), userWake('third'));
    assert.equal(await writer.receiveLiveInput(userEvent('second'), userWake('second')), 'duplicate');
    assert.equal(notifications, 2); unsubscribe();
    assert.deepEqual(await turnFor(await writer.loadWakeRun(run.id)), original, 'original input stays frozen');
    const initial = encodeEntry(messageEntry({ role: 'user', content: original.input, timestamp: Date.parse(original.occurredAt) }, null));
    let version = await writer.appendWakeInput(run.id, 0, initial);
    const pending = await writer.loadLiveInputs(run.id); assert.deepEqual(pending.map(item => item.request.event.id), ['second', 'third']);
    const intent = { callId: 'must-not-begin', assistantRecordId: initial.id, toolName: 'effect', arguments: {}, requestedArguments: {}, occurredAt: new Date().toISOString() };
    assert.equal(await writer.tryBeginWakeTool(run.id, version, intent), false);
    let parent = initial.id;
    const final = encodeEntry(messageEntry(assistant('old final'), parent));
    assert.equal(await writer.tryAppendWakeFinal(run.id, version, final), null);
    assert.equal((await writer.load()).version, version);
    const wrongOrder = encodeEntry(messageEntry({ role: 'user', content: 'wrong order', timestamp: 1000 }, parent));
    await assert.rejects(writer.appendLiveInput(run.id, pending[1]!.request.wake.id, version, wrongOrder), /receipt order/);
    for (const item of pending) {
      const supplemental = await turnFor({ ...run, id: item.request.eventId, claimedAt: item.request.event.occurredAt, requests: [item.request] });
      const record = encodeEntry(messageEntry({ role: 'user', content: supplemental.input, timestamp: Date.parse(supplemental.occurredAt) }, parent));
      await assert.rejects(writer.appendLiveInput(run.id, item.request.wake.id, version + 1, record), /Stale context version/);
      const prior = version; version = await writer.appendLiveInput(run.id, item.request.wake.id, version, record); parent = record.id;
      assert.equal(await writer.appendLiveInput(run.id, item.request.wake.id, prior, record), version);
    }
    const terminal = encodeEntry(messageEntry(assistant('current final'), parent));
    assert.equal(await writer.tryAppendWakeFinal(run.id, version, terminal), version + 1);
    await writer.receiveLiveInput(userEvent('after-final'), userWake('after-final'));
    await writer.completeWakeRun(run.id);
    const next = await writer.claimWakeBatch(); assert.ok(next); assert.notEqual(next.id, run.id);
    assert.deepEqual(next.requests.map(item => item.event.id), ['after-final']);
    assert.equal((await writer.loadLiveInputs(run.id)).length, 2);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 0);
  } finally { await db.close(); }
});

test('real PostgreSQL runtime settles only the current tool before consuming new input', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const entered = deferred(), release = deferred();
  try {
    const writer = await db.acquire(); await writer.receiveLiveInput(userEvent('original'), userWake('original'));
    const run = await writer.claimWakeBatch(); assert.ok(run); let calls = 0; const effects: string[] = [];
    const work = new PiDurableRuntime({ writer, model, tools: [effectTool(async (id, _args, signal) => {
      effects.push(id); entered.resolve(); await release.promise; assert.equal(signal?.aborted, false); return result;
    })], streamFn: (_model, context) => {
      if (++calls === 1) return streamOf(toolCalls('first', 'never-started'));
      assert.match(JSON.stringify(context.messages), /new-direction/);
      return streamOf(assistant('Updated direction'));
    } }).continueTurn(await turnFor(run));
    await entered.promise; await writer.receiveLiveInput(userEvent('new-direction'), userWake('new-direction'));
    assert.equal((await writer.loadLiveInputs(run.id))[0]!.inputRecordId, null);
    release.resolve(); await work; await writer.completeWakeRun(run.id);
    assert.deepEqual(effects, ['first']); assert.equal(calls, 2);
    const snapshot = await writer.load(); assert.equal(snapshot.executions.length, 1); assert.ok(snapshot.executions[0]!.outcome);
    await writer.close(); const restarted = await db.acquire();
    await new PiDurableRuntime({ writer: restarted, model, streamFn: () => { throw Error('Final recovery must not call model'); } }).continueTurn({ ...await turnFor(run), input: '' });
    assert.deepEqual(await restarted.load(), snapshot);
  } finally { release.resolve(); await db.close(); }
});

for (const [mode, code] of [['after-receipt', 80], ['after-consume', 81], ['after-outcome', 82], ['unknown', 83]] as const) {
  test(`real PostgreSQL process death ${mode}: newest input first and no repeated effect`, { timeout: 30_000 }, async () => {
    const db = await createTestDatabase(); const directory = await mkdtemp('/tmp/mira-live-input-'); const counter = path.join(directory, 'effects');
    const child = (selected: string) => exec(process.execPath, ['--import', guard, worker, db.schema, mode, selected, counter], { timeout: 20_000 });
    try {
      await assert.rejects(child(mode), error => error instanceof Error && 'code' in error && error.code === code);
      const prior = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows.map(row => row.envelope);
      const output = JSON.parse((await child('recover')).stdout) as { completed: number; calls: number; contexts: unknown[]; snapshot: RecoverySnapshot; run: WakeRun; live: LiveWakeInput[] };
      assert.equal(output.completed, 1); assert.equal(output.calls, 1);
      assert.deepEqual(output.snapshot.records.slice(0, prior.length), prior);
      assert.equal(output.live.length, 1); assert.ok(output.live[0]!.inputRecordId);
      assert.deepEqual(output.run.requests.map(item => item.event.id), ['original']);
      assert.match(JSON.stringify(output.contexts), /new-input-before-crash/);
      assert.doesNotMatch(JSON.stringify(output.snapshot.records), /Stale response must not publish/);
      if (mode === 'after-outcome' || mode === 'unknown') {
        assert.equal(await readFile(counter, 'utf8'), 'one-effect\n');
        assert.equal(output.snapshot.executions.length, 1);
        assert.equal(output.snapshot.executions[0]!.outcome === null, mode === 'unknown');
        assert.match(JSON.stringify(output.contexts), mode === 'unknown' ? /success or failure is unknown/ : /synthetic effect done/);
      } else assert.equal(output.snapshot.executions.length, 0);
    } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test('real PostgreSQL new input during compaction commits after its frozen checkpoint and before cognition', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const entered = deferred(), release = deferred();
  try {
    const writer = await db.acquire();
    await seed(writer, [input('Older question '.repeat(4000)), assistant('Earlier answer '.repeat(4000)), input('Recent question'), assistant('Recent answer')]);
    await writer.receiveLiveInput(userEvent('original'), userWake('original')); const run = await writer.claimWakeBatch(); assert.ok(run);
    let summaries = 0, requests = 0;
    const work = new PiDurableRuntime({ writer, model: { ...model, contextWindow: 65536 },
      autoCompaction: { enabled: true, threshold: 0.3, reserveTokens: 512, keepRecentTokens: 1 },
      streamFn: async (_model, context, options) => {
        const system = getCurrentSystemMessage(context.messages);
        if (system && getSystemMessageText(system).startsWith('你负责压缩 Mira 的 Working Context')) {
          summaries++; entered.resolve(); await release.promise; assert.equal(options?.signal?.aborted, false);
          return streamOf(assistant('Frozen old-history summary'));
        }
        requests++; assert.match(JSON.stringify(context.messages), /new-during-summary/);
        return streamOf(assistant('Latest input after checkpoint'));
      } }).continueTurn(await turnFor(run));
    await entered.promise; await writer.receiveLiveInput(userEvent('new-during-summary'), userWake('new-during-summary'));
    const unread = await writer.loadLiveInputs(run.id); assert.equal(unread[0]!.inputRecordId, null);
    release.resolve(); await work; assert.equal(summaries, 1); assert.equal(requests, 1);
    const state = await writer.load(); const live = await writer.loadLiveInputs(run.id);
    const checkpoint = state.records.findIndex(record => record.kind === 'checkpoint');
    assert.ok(checkpoint >= 0); assert.ok(state.records.findIndex(record => record.id === live[0]!.inputRecordId) > checkpoint);
    await writer.close(); const restarted = await db.acquire();
    await new PiDurableRuntime({ writer: restarted, model, streamFn: () => { throw Error('No new request after final'); } }).continueTurn({ ...await turnFor(run), input: '' });
    assert.deepEqual(await restarted.load(), state);
  } finally { release.resolve(); await db.close(); }
});
