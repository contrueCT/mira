import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { LifeEvent, RecoverySnapshot, WakeRequest, WakeRun } from '@mira/life';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, seed } from './fixtures.mts';
import type { CrashBoundary, WorkerMessage, WorkerMode } from './wake-process-worker.mts';

const workerPath = new URL('./wake-process-worker.mts', import.meta.url).pathname;
const guard = new URL('../deny-model-network.mts', import.meta.url).pathname;
const miraId = 'same-synthetic-mira';
type Database = Awaited<ReturnType<typeof createTestDatabase>>;
type Exit = { code: number | null; signal: NodeJS.Signals | null };

function startWorker(db: Database, mode: WorkerMode, effectPath = '') {
  const applicationName = `mira-wake-process-${randomUUID()}`;
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'MIRA_TEST_DATABASE_URL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const child = spawn(process.execPath, ['--import', guard, workerPath, db.schema, miraId, mode, applicationName, effectPath], {
    env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const messages: WorkerMessage[] = [];
  const observers = new Set<() => void>();
  let exit: Exit | undefined;
  let launchError: Error | undefined;
  child.on('message', message => { messages.push(message as WorkerMessage); for (const notify of observers) notify(); });
  const exited = new Promise<Exit>(resolve => {
    child.once('error', error => { launchError = error; for (const notify of observers) notify(); });
    child.once('close', (code, signal) => { exit = { code, signal }; for (const notify of observers) notify(); resolve(exit); });
  });
  function next<T extends WorkerMessage['type']>(type: T): Promise<Extract<WorkerMessage, { type: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Wake worker did not report ${type}`)), 15_000);
      const finish = (error?: Error, message?: WorkerMessage) => {
        clearTimeout(timer); observers.delete(check);
        if (error) reject(error); else resolve(message as Extract<WorkerMessage, { type: T }>);
      };
      const check = () => {
        const failed = messages.find(message => message.type === 'failed');
        if (failed?.type === 'failed') { finish(new Error(`Wake worker failed: ${failed.message}`)); return; }
        const index = messages.findIndex(message => message.type === type);
        if (index !== -1) { finish(undefined, messages.splice(index, 1)[0]); return; }
        if (launchError) finish(launchError);
        else if (exit) finish(new Error(`Wake worker exited before ${type}: ${JSON.stringify(exit)}`));
      };
      observers.add(check); check();
    });
  }
  return {
    applicationName, next, exited,
    get pid() { return child.pid; },
    get running() { return child.exitCode === null && child.signalCode === null; },
    command(command: 'release' | 'exit') {
      return new Promise<void>((resolve, reject) => child.send({ command }, error => error ? reject(error) : resolve()));
    },
    kill() { assert.equal(child.kill('SIGKILL'), true); },
    async close() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    },
  };
}

async function waitForBackendExit(db: Database, applicationName: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    const sessions = await db.admin.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1', [applicationName]);
    if (sessions.rows.length === 0) return;
    if (Date.now() >= deadline) throw new Error('Terminated worker still owns a PostgreSQL backend');
    await delay(10);
  }
}

const requests: WakeRequest[] = [
  { event: { id: 'first-event', source: 'user', type: 'message', occurredAt: '2026-01-01T00:00:01.000Z', payload: { text: 'synthetic first wake' } }, wake: { id: 'first-wake', reason: 'synthetic user request' } },
  { event: { id: 'second-event', source: 'external', type: 'notice', occurredAt: '2025-12-31T23:59:59.000Z', payload: { text: 'synthetic second wake' } }, wake: { id: 'second-wake', reason: 'synthetic requested notice' } },
];
const eventOnly: LifeEvent = { id: 'event-only', source: 'system', type: 'note', occurredAt: '2026-01-01T00:00:02.000Z', payload: 'synthetic unrequested history' };
async function prepare(db: Database): Promise<RecoverySnapshot> {
  const writer = await db.acquire(miraId);
  try {
    await seed(writer, [input('synthetic original context'), assistant('synthetic original answer')]);
    for (const request of requests) await writer.receive(request.event, request.wake);
    await writer.receive(eventOnly);
    return await writer.load();
  } finally { await writer.close(); }
}
async function inspect(db: Database, runId: string) {
  const writer = await db.acquire(miraId);
  try { return { run: await writer.loadWakeRun(runId), snapshot: await writer.load(), next: await writer.claimWakeBatch() }; }
  finally { await writer.close(); }
}
function assertFinished(run: WakeRun, snapshot: RecoverySnapshot, original: RecoverySnapshot): void {
  assert.equal(snapshot.miraId, miraId);
  assert.deepEqual(snapshot.records.slice(0, original.records.length), original.records);
  assert.equal(new Set(snapshot.records.map(record => record.id)).size, snapshot.records.length);
  assert.equal(run.status, 'completed');
  assert.deepEqual(run.requests, requests);
  assert.ok(run.inputRecordId); assert.ok(run.finalRecordId);
  const added = snapshot.records.slice(original.records.length);
  assert.equal(added.filter(record => record.id === run.inputRecordId).length, 1);
  assert.equal(added.filter(record => record.id === run.finalRecordId).length, 1);
  assert.equal(added.filter(record => (record.payload as { message?: { role: string } }).message?.role === 'user').length, 1);
  assert.equal(added.filter(record => {
    const message = (record.payload as { message?: { role: string; stopReason?: string } }).message;
    return message?.role === 'assistant' && message.stopReason === 'stop';
  }).length, 1);
  const inputRecord = added.find(record => record.id === run.inputRecordId)!;
  assert.match(JSON.stringify(inputRecord), /synthetic first wake/);
  assert.match(JSON.stringify(inputRecord), /synthetic second wake/);
  assert.doesNotMatch(JSON.stringify(inputRecord), /synthetic unrequested history/);
  const finalRecord = added.find(record => record.id === run.finalRecordId)!;
  assert.equal((finalRecord.payload as { message: { role: string; stopReason: string } }).message.role, 'assistant');
  assert.equal((finalRecord.payload as { message: { stopReason: string } }).message.stopReason, 'stop');
}

// Real PostgreSQL 18.6 is supplied only by the explicitly configured integration
// runner/CI. No local service, alternate transport or implicit URL is attempted.
for (const boundary of ['after-claim', 'after-input', 'after-final', 'after-complete'] as const satisfies readonly CrashBoundary[]) {
  for (const termination of ['exit', 'SIGKILL'] as const) test(`real PostgreSQL: wake ${termination} ${boundary} resumes exact run without duplicate input/final`, async () => {
    const db = await createTestDatabase();
    const children: ReturnType<typeof startWorker>[] = [];
    try {
      const original = await prepare(db);
      const first = startWorker(db, boundary); children.push(first);
      const checkpoint = await first.next('checkpoint');
      assert.equal(checkpoint.boundary, boundary);
      assert.deepEqual(checkpoint.run.requests, requests);
      assert.equal(checkpoint.run.status, boundary === 'after-complete' ? 'completed' : 'running');
      assert.equal(checkpoint.run.inputRecordId !== null, boundary !== 'after-claim');
      assert.equal(checkpoint.run.finalRecordId !== null, boundary === 'after-final' || boundary === 'after-complete');
      if (termination === 'exit') await first.command('exit'); else first.kill();
      assert.deepEqual(await first.exited, termination === 'exit' ? { code: 80, signal: null } : { code: null, signal: 'SIGKILL' });
      await waitForBackendExit(db, first.applicationName);
      const persisted = await inspect(db, checkpoint.run.id);
      assert.deepEqual(persisted.run, checkpoint.run);
      assert.deepEqual(persisted.snapshot, checkpoint.snapshot);
      assert.deepEqual(persisted.next, boundary === 'after-complete' ? null : checkpoint.run);
      const second = startWorker(db, 'drain'); children.push(second);
      const recovered = await second.next('result');
      assert.deepEqual(await second.exited, { code: 0, signal: null });
      const finished = await inspect(db, checkpoint.run.id);
      assert.equal(finished.run.id, checkpoint.run.id);
      assert.equal(finished.next, null);
      assertFinished(finished.run, finished.snapshot, original);
      assert.deepEqual(finished.snapshot, recovered.snapshot);
      assert.deepEqual(finished.snapshot.records.slice(0, checkpoint.snapshot.records.length), checkpoint.snapshot.records);
      assert.equal(finished.snapshot.version, original.version + 2);
      assert.equal(recovered.completed, boundary === 'after-complete' ? 0 : 1);
      assert.deepEqual(recovered.claims, boundary === 'after-complete' ? [] : [checkpoint.run.id]);
      const alreadyFinal = boundary === 'after-final' || boundary === 'after-complete';
      assert.equal(checkpoint.modelCalls, alreadyFinal ? 1 : 0);
      assert.equal(recovered.modelCalls, alreadyFinal ? 0 : 1);
      assert.equal(checkpoint.modelCalls + recovered.modelCalls, 1);
      assert.equal(checkpoint.effects + recovered.effects, 0);
      if (checkpoint.run.inputRecordId) assert.equal(finished.run.inputRecordId, checkpoint.run.inputRecordId);
      if (checkpoint.run.finalRecordId) {
        assert.equal(finished.run.finalRecordId, checkpoint.run.finalRecordId);
        assert.deepEqual(finished.snapshot, checkpoint.snapshot, 'saved final must complete without any context/model replay');
      }
      const counts = await db.admin.query<{ runs: number; receipts: number }>('SELECT (SELECT count(*)::int FROM wake_runs WHERE mira_id = $1) AS runs, (SELECT count(*)::int FROM wake_run_requests WHERE mira_id = $1) AS receipts', [miraId]);
      assert.deepEqual(counts.rows, [{ runs: 1, receipts: 2 }]);
    } finally { await Promise.all(children.map(child => child.close())); await db.close(); }
  });
}

for (const boundary of ['model', 'effect'] as const) test(`real PostgreSQL: replacement process owns exact wake while stale ${boundary} awaits, then fences its continuation`, async () => {
  const db = await createTestDatabase();
  const directory = await mkdtemp(join(tmpdir(), 'mira-wake-process-'));
  const effectPath = join(directory, 'synthetic-effects');
  const children: ReturnType<typeof startWorker>[] = [];
  try {
    const original = await prepare(db);
    const stale = startWorker(db, boundary === 'model' ? 'hold-model' : 'hold-effect', effectPath); children.push(stale);
    const owner = await stale.next('acquired');
    const waiting = await stale.next('waiting');
    assert.equal(waiting.boundary, boundary);
    assert.ok(waiting.run.inputRecordId); assert.equal(waiting.run.finalRecordId, null);
    const killed = await db.admin.query<{ killed: boolean }>('SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name = $1', [stale.applicationName]);
    assert.deepEqual(killed.rows, [{ killed: true }]);
    await stale.next('lost');
    await waitForBackendExit(db, stale.applicationName);
    assert.equal(stale.running, true, 'the old OS process must remain alive during takeover');
    const replacement = startWorker(db, 'resume-with-tools', effectPath); children.push(replacement);
    const newOwner = await replacement.next('acquired');
    assert.ok(BigInt(newOwner.epoch) > BigInt(owner.epoch));
    assert.notEqual(replacement.pid, stale.pid);
    const recovered = await replacement.next('result');
    assert.deepEqual(await replacement.exited, { code: 0, signal: null });
    assert.equal(stale.running, true, 'replacement must finish before releasing the old awaited operation');
    assert.equal(recovered.completed, 1); assert.deepEqual(recovered.claims, [waiting.run.id]);
    assert.equal(recovered.modelCalls, 1); assert.equal(recovered.effects, 0);
    assert.deepEqual(recovered.snapshot.records.slice(0, waiting.snapshot.records.length), waiting.snapshot.records);
    assert.match(JSON.stringify(recovered.requests), /synthetic original context/);
    assert.match(JSON.stringify(recovered.requests), /synthetic first wake/);
    if (boundary === 'effect') {
      assert.match(JSON.stringify(recovered.requests), /may already have executed/);
      assert.match(JSON.stringify(recovered.requests), /Execution did not start/);
      assert.match(JSON.stringify(recovered.snapshot.records), /outcome-unknown/);
      assert.match(JSON.stringify(recovered.snapshot.records), /not-started/);
      assert.equal(recovered.requests[0]!.messages.some(message => message.role === 'toolResult'), false);
      assert.equal(recovered.requests[0]!.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall')), false);
      assert.equal(recovered.snapshot.executions.length, 1);
      assert.equal(recovered.snapshot.executions[0]!.intent.callId, 'stale-first');
      assert.equal(recovered.snapshot.executions[0]!.outcome, null);
    } else assert.equal(recovered.snapshot.executions.length, 0);
    await stale.command('release');
    const stopped = await stale.next('stopped');
    assert.deepEqual(stopped, { type: 'stopped', ownershipLost: true, modelCalls: 1, effects: boundary === 'effect' ? 1 : 0 });
    assert.deepEqual(await stale.exited, { code: 0, signal: null });
    const finished = await inspect(db, waiting.run.id);
    assertFinished(finished.run, finished.snapshot, original);
    assert.equal(finished.run.inputRecordId, waiting.run.inputRecordId);
    assert.equal(finished.next, null);
    assert.deepEqual(finished.snapshot, recovered.snapshot, 'stale model/effect return must append no outcome, final or other record');
    if (boundary === 'effect') assert.equal(await readFile(effectPath, 'utf8'), 'hold-effect:stale-first\n');
    else await assert.rejects(readFile(effectPath), error => error instanceof Error && 'code' in error && error.code === 'ENOENT');
    const runs = await db.admin.query<{ run_id: string; completed: boolean }>('SELECT run_id, completed FROM wake_runs WHERE mira_id = $1', [miraId]);
    assert.deepEqual(runs.rows, [{ run_id: waiting.run.id, completed: true }]);
  } finally { await Promise.all(children.map(child => child.close())); await db.close(); await rm(directory, { recursive: true, force: true }); }
});
