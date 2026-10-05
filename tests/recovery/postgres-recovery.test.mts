import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { createAssistantMessageEventStream, type TranscriptContext } from '@earendil-works/pi-ai';
import { PostgresPersistence } from '@mira/persistence';
import type { RecoverySnapshot } from '@mira/life';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, compactionMessages, deferred, effectTool, input, result, runtime, scripted, seed, streamOf, toolCalls } from './fixtures.mts';

const exec = promisify(execFile);
const worker = new URL('./pg-worker.mts', import.meta.url).pathname;
const guard = new URL('../deny-model-network.mts', import.meta.url).pathname;
async function child(schema: string, id: string, mode: string, path = '') {
  const run = await exec(process.execPath, ['--import', guard, worker, schema, id, mode, path], { timeout: 30_000 });
  return JSON.parse(run.stdout) as Record<string, unknown>;
}

test('real PostgreSQL: separate processes continue one Mira with exact original record prefix', async () => {
  const db = await createTestDatabase();
  try {
    const first = await child(db.schema, 'one-mira', 'first');
    const second = await child(db.schema, 'one-mira', 'second');
    const old = first['snapshot'] as RecoverySnapshot, current = second['snapshot'] as RecoverySnapshot;
    assert.equal(current.miraId, old.miraId);
    assert.deepEqual(current.records.slice(0, old.records.length), old.records);
    assert.equal(current.version, old.version + 2);
    assert.equal(new Set(current.records.map(r => r.id)).size, current.records.length);
    assert.match(JSON.stringify(second['requests']), /Paper Moon/);
    assert.match(JSON.stringify(second['requests']), /earlier restaurant/);
  } finally { await db.close(); }
});

for (const mode of ['before-effect', 'after-effect'] as const) test(`real PostgreSQL: process crash ${mode} leaves unknown intent and never blindly replays`, async () => {
  const db = await createTestDatabase(); const dir = await mkdtemp(join(tmpdir(), 'mira-pg-counter-')); const path = join(dir, 'counter');
  try {
    await assert.rejects(child(db.schema, 'one-mira', mode, path), error => error instanceof Error && 'code' in error && error.code === (mode === 'before-effect' ? 70 : 71));
    const recovered = await child(db.schema, 'one-mira', 'recover', path);
    assert.equal(recovered['blocked'], true); assert.equal(recovered['requests'], 0); assert.equal(recovered['effects'], 0);
    assert.match(String(recovered['error']), /unknown|reconciliation/);
    const snapshot = recovered['snapshot'] as RecoverySnapshot;
    assert.equal(snapshot.executions.length, 1); assert.equal(snapshot.executions[0]!.outcome, null);
    if (mode === 'before-effect') await assert.rejects(readFile(path));
    else assert.equal(await readFile(path, 'utf8'), 'synthetic-effect\n');
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real PostgreSQL: crash after outcome commit materializes exact tool result in next process', async () => {
  const db = await createTestDatabase(); const dir = await mkdtemp(join(tmpdir(), 'mira-pg-counter-')); const path = join(dir, 'counter');
  try {
    await assert.rejects(child(db.schema, 'one-mira', 'after-outcome', path), error => error instanceof Error && 'code' in error && error.code === 72);
    const result = await child(db.schema, 'one-mira', 'recover-outcome', path);
    const restored = result['restored'] as RecoverySnapshot;
    assert.equal(result['effects'], 0); assert.equal(restored.executions.length, 1);
    const message = (restored.records.at(-1)!.payload as { message: unknown }).message;
    assert.deepEqual(message, restored.executions[0]!.outcome!.payload);
    assert.equal(await readFile(path, 'utf8'), 'synthetic-effect\n');
    assert.equal((result['continued'] as RecoverySnapshot).version, restored.version + 1);
  } finally { await db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real PostgreSQL: duplicate call ID has one durable execution and one effect across runtime restarts', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); let effects = 0;
    const tools = [effectTool(async () => { effects++; return result; })];
    await runtime(writer, scripted([toolCalls('same'), assistant()]), { tools }).run(input());
    await assert.rejects(runtime(writer, scripted([toolCalls('same')]), { tools }).run(input()), /Duplicate tool-call/);
    assert.equal(effects, 1); assert.equal((await writer.load()).executions.length, 1);
  } finally { await db.close(); }
});

for (const boundary of ['authorization', 'model', 'effect'] as const) test(`real PostgreSQL: ownership connection loss at ${boundary} boundary stops old runtime`, async () => {
  const db = await createTestDatabase(); const app = `mira-runtime-loss-${randomUUID()}`;
  const writer = await new PostgresPersistence({ connectionString: db.connectionString, schema: db.schema, applicationName: app }).acquire('one-mira');
  const entered = deferred(), release = deferred(); let effects = 0, requests = 0;
  const instance = runtime(writer, async () => {
    requests++;
    if (boundary === 'model') { entered.resolve(); await release.promise; }
    return streamOf(toolCalls('a', 'b'));
  }, {
    authorize: async () => { if (boundary === 'authorization') { entered.resolve(); await release.promise; } return { allowed: true, evidence: { synthetic: true } }; },
    tools: [effectTool(async () => { effects++; if (boundary === 'effect') { entered.resolve(); await release.promise; } return result; })],
  });
  const work = instance.run(input());
  // Attach rejection handling before administratively terminating its connection.
  const rejected = assert.rejects(work, /terminated|connection|Writer|stopped|ownership/i);
  try {
    await entered.promise;
    const lost = writer.signal.aborted ? Promise.resolve() : once(writer.signal, 'abort');
    const killed = await db.admin.query('SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name = $1', [app]);
    assert.equal(killed.rows.length, 1); assert.equal(killed.rows[0]?.killed, true);
    await Promise.race([lost, setTimeout(5000).then(() => { throw Error('writer abort event missing'); })]);
    release.resolve(); await rejected;
    assert.equal(requests, 1); assert.equal(effects, boundary === 'effect' ? 1 : 0);
    await assert.rejects(instance.run(input()), /terminated|connection|Writer|stopped|ownership/i);
    const replacement = await db.acquire('one-mira');
    if (boundary === 'effect') {
      await assert.rejects(runtime(replacement).recover(), /unknown/);
      assert.equal((await replacement.load()).executions[0]?.outcome, null);
    }
  } finally { release.resolve(); await rejected.catch(() => {}); await writer.close(); await db.close(); }
});

test('real PostgreSQL: repeated full SDK compaction retains history, updated system, exact paired tail', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); await seed(writer, compactionMessages());
    const before = await writer.load();
    await runtime(writer, scripted([assistant('First checkpoint'), assistant('First turn prefix')])).compact({ keepRecentTokens: 1 });
    await seed(writer, compactionMessages('second'));
    const requests: TranscriptContext[] = [];
    const state = await runtime(writer, (_m, c) => { requests.push(structuredClone(c)); return streamOf(assistant('Second checkpoint')); }).compact({ keepRecentTokens: 1 });
    assert.deepEqual(state.snapshot.records.slice(0, before.records.length), before.records);
    assert.equal(state.entries.filter(e => e.type === 'compaction').length, 2);
    assert.deepEqual(state.messages.slice(2), compactionMessages('second').slice(4));
    assert.match(JSON.stringify(state.messages[0]), /second system/);
    assert.ok(requests.some(r => JSON.stringify(r).includes('<previous-summary>')));
    const continued = await runtime(writer).run();
    assert.equal(continued.snapshot.version, state.snapshot.version + 1);
  } finally { await db.close(); }
});

test('real PostgreSQL: stale compaction CAS cannot erase newer accepted context', async () => {
  const db = await createTestDatabase(); const entered = deferred(), release = deferred();
  try {
    const writer = await db.acquire(); await seed(writer, compactionMessages());
    const work = runtime(writer, async () => { entered.resolve(); await release.promise; return streamOf(assistant('stale')); }).compact({ keepRecentTokens: 1 });
    await entered.promise; await seed(writer, [input('new accepted message')]);
    const newer = await writer.load(); release.resolve();
    await assert.rejects(work, /version/i); assert.deepEqual(await writer.load(), newer);
  } finally { release.resolve(); await db.close(); }
});

test('real PostgreSQL: cancelled compaction publishes no checkpoint', async () => {
  const db = await createTestDatabase(); const entered = deferred(); const controller = new AbortController();
  try {
    const writer = await db.acquire(); await seed(writer, compactionMessages()); const before = await writer.load();
    const work = runtime(writer, (_m, _c, options) => {
      const stream = createAssistantMessageEventStream();
      const abort = () => { const error = { ...assistant(''), stopReason: 'aborted' as const }; stream.push({ type: 'error', reason: 'aborted', error }); stream.end(); };
      if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
      entered.resolve(); return stream;
    }).compact({ keepRecentTokens: 1, signal: controller.signal });
    await entered.promise; controller.abort(Error('cancelled synthetic compaction'));
    await assert.rejects(work, /abort|cancel/i); assert.deepEqual(await writer.load(), before);
  } finally { await db.close(); }
});

test('real PostgreSQL: structured provider fields and ordered system sections roundtrip exactly', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    const messages = compactionMessages();
    messages[0] = { role: 'system', content: [{ type: 'text', text: 'base' }], sections: { identity: 'Synthetic identity', state: '<state>synthetic</state>', removed: null }, timestamp: 1000 };
    messages[1] = { role: 'user', content: [{ type: 'text', text: 'Synthetic image' }, { type: 'image', data: 'c3ludGhldGlj', mimeType: 'image/png' }], timestamp: 1000 };
    const signed = { ...assistant(), content: [{ type: 'thinking', thinking: '', thinkingSignature: 'synthetic-opaque-encrypted', redacted: true }, { type: 'text', text: 'signed text', textSignature: 'synthetic-response-signature' }], unknownProviderField: { data: [1, null, 'exact'] } };
    await seed(writer, [...messages, signed as ReturnType<typeof assistant>]);
    const before = await writer.load(); await writer.close();
    const restarted = await db.acquire(); const recovered = await runtime(restarted).recover();
    assert.deepEqual(recovered.snapshot.records, before.records);
    assert.deepEqual(recovered.messages, [...messages, signed]);
    const restoredSystem = recovered.messages[0];
    assert.ok(restoredSystem?.role === 'system');
    assert.deepEqual(Object.keys(restoredSystem.sections ?? {}), ['identity', 'state', 'removed'], 'ordered sections must not be reordered by storage');
  } finally { await db.close(); }
});
