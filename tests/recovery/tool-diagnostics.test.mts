import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableOperationError, type RecoverySnapshot } from '@mira/life';
import { createLocalHttp, LocalWebService } from '@mira/server';
import type { RecoveredContext } from '@mira/runtime-pi';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { PersistenceFailureNotice } from '../../apps/server/src/persistence-errors.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, effectTool, input, result, runtime, scripted, streamOf, toolCalls } from './fixtures.mts';

const secret = 'synthetic-tool-secret-do-not-save';
const exec = promisify(execFile);
const worker = new URL('./tool-diagnostics-worker.mts', import.meta.url).pathname;
const guard = new URL('../deny-model-network.mts', import.meta.url).pathname;
async function child(schema: string, miraId: string, mode = 'recover', counter = '') {
  const run = await exec(process.execPath, ['--import', guard, worker, schema, miraId, mode, counter], { timeout: 30_000 });
  return JSON.parse(run.stdout) as { snapshot: RecoverySnapshot; recovery: RecoveredContext['recovery']; contexts: TranscriptContext[] };
}

for (const category of ['execution-rejected', 'event-content-conflict', 'non-finite-result'] as const) test(`real PostgreSQL: ${category} diagnostic survives a fresh process without outcome fabrication`, async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire(); const effects: string[] = []; let requests = 0;
    const event = { id: 'same-event', type: 'diagnostic.fixture', source: 'extension' as const, occurredAt: '2026-10-07T12:00:00.000Z', payload: { sample: 1 } };
    if (category === 'event-content-conflict') await writer.receive(event);
    const recovered = await runtime(writer, (_model, context) => {
      requests++;
      if (requests === 1) return streamOf(toolCalls('a', 'b'));
      assert.match(JSON.stringify(context.messages), new RegExp(category));
      assert.ok(!JSON.stringify(context.messages).includes(secret));
      return streamOf(assistant('Inspect the original external state before deciding whether to retry'));
    }, { tools: [effectTool(async id => {
      effects.push(id);
      if (category === 'event-content-conflict') await writer.receive({ ...event, payload: { sample: 2 } });
      if (category === 'non-finite-result') return { ...result, details: { sample: Infinity, secret } };
      throw Error(secret, { cause: { headers: { authorization: secret } } });
    })] }).run(input());
    assert.deepEqual(effects, ['a']); assert.equal(requests, 2);
    assert.deepEqual(recovered.recovery.operations[0]?.diagnostic, { phase: category === 'non-finite-result' ? 'result' : 'execute', category });
    assert.equal(recovered.snapshot.executions[0]?.outcome, null);
    assert.ok(!recovered.recovery.operations[1]?.diagnostic);
    const before = await writer.load(); assert.ok(!JSON.stringify(before).includes(secret));
    await writer.close();
    const restarted = await child(db.schema, writer.miraId);
    assert.deepEqual(restarted.snapshot.records.slice(0, before.records.length), before.records);
    assert.deepEqual(restarted.recovery, recovered.recovery);
    assert.equal(restarted.snapshot.executions.length, 1);
    assert.equal(restarted.snapshot.executions[0]?.outcome, null);
    assert.equal(restarted.contexts.length, 1);
    assert.match(JSON.stringify(restarted.contexts), new RegExp(category));
    assert.ok(!JSON.stringify(restarted).includes(secret));
  } finally { await db.close(); }
});

for (const mode of ['unobserved-crash', 'observed-crash'] as const) test(`real PostgreSQL: process death ${mode === 'unobserved-crash' ? 'before' : 'after'} observation commit retains honest diagnostic availability`, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp(join(tmpdir(), 'mira-diagnostic-crash-')); const counter = join(root, 'counter');
  try {
    await assert.rejects(child(db.schema, 'crash-mira', mode, counter), error => error instanceof Error && 'code' in error && error.code === (mode === 'unobserved-crash' ? 75 : 76));
    const writer = await db.acquire('crash-mira'); const before = await writer.load(); await writer.close();
    assert.equal(before.executions[0]?.outcome, null);
    assert.equal(before.records.some(record => (record.payload as { type?: string }).type === 'custom_message'), mode === 'observed-crash');
    const recovered = await child(db.schema, 'crash-mira', 'recover', counter);
    assert.deepEqual(recovered.snapshot.records.slice(0, before.records.length), before.records);
    assert.deepEqual(recovered.recovery.operations.map(operation => operation.status), ['outcome-unknown', 'not-started']);
    assert.equal(!!recovered.recovery.operations[0]?.diagnostic, mode === 'observed-crash');
    assert.ok(!recovered.recovery.operations[1]?.diagnostic);
    if (mode === 'observed-crash') assert.deepEqual(recovered.recovery.operations[0]?.diagnostic, { phase: 'execute', category: 'execution-rejected' });
    assert.equal(recovered.snapshot.executions.length, 1);
    assert.equal(await readFile(counter, 'utf8'), 'synthetic-effect\n');
    assert.ok(!JSON.stringify(recovered).includes(secret));
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL: an actual outcome-write fault stops the writer and cannot promise a persisted diagnostic', async () => {
  const db = await createTestDatabase();
  try {
    await db.admin.query(`CREATE FUNCTION reject_diagnostic_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.outcome IS NOT NULL THEN RAISE EXCEPTION '${secret}'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_diagnostic_outcome BEFORE UPDATE ON tool_executions FOR EACH ROW EXECUTE FUNCTION reject_diagnostic_outcome()`);
    const writer = await db.acquire(); const effects: string[] = []; let requests = 0;
    const instance = runtime(writer, () => { requests++; return streamOf(toolCalls('a', 'b')); }, {
      tools: [effectTool(async id => { effects.push(id); return result; })],
    });
    await assert.rejects(instance.run(input()), error => {
      assert.equal(DurableOperationError.categoryOf(error), 'persistence-write-failure');
      assert.match(PersistenceFailureNotice.text(PersistenceFailureNotice.from(error))!, /no durable tool diagnostic is confirmed/);
      return true;
    });
    assert.equal(writer.signal.aborted, true); assert.deepEqual(effects, ['a']); assert.equal(requests, 1);
    const original = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    assert.ok(!original.some(row => row.envelope.payload.type === 'custom_message'));
    assert.ok(!JSON.stringify(original).includes(secret));
    await writer.close();
    const restarted = await db.acquire(); const recovered = await runtime(restarted, scripted([assistant()])).recover();
    assert.equal(recovered.snapshot.executions[0]?.outcome, null);
    assert.ok(recovered.recovery.operations.every(operation => !operation.diagnostic));
    assert.deepEqual(recovered.snapshot.records.slice(0, original.length), original.map(row => row.envelope));
  } finally { await db.close(); }
});

test('real PostgreSQL Web service reports only a temporary persistence notice and recovers the same Wake', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp(join(tmpdir(), 'mira-web-diagnostic-'));
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  try {
    await db.admin.query(`CREATE FUNCTION reject_web_diagnostic_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.outcome IS NOT NULL THEN RAISE EXCEPTION '${secret}'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_web_diagnostic_outcome BEFORE UPDATE ON tool_executions FOR EACH ROW EXECUTE FUNCTION reject_web_diagnostic_outcome()`);
    const file = join(root, 'synthetic-readable.txt'); await writeFile(file, 'Synthetic tool result');
    let requests = 0;
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'web-diagnostic', sourceDirectory: process.cwd(),
      spoolDirectory: join(root, 'spool'), settingsFile: join(root, 'models.json'), miraHome: root, synthetic: true,
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        requests++;
        if (requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'read-a', name: 'read', arguments: { path: file } },
          { type: 'toolCall', id: 'read-b', name: 'read', arguments: { path: file } },
        ] });
        assert.match(JSON.stringify(context.messages), /success or failure is unknown/);
        assert.ok(!JSON.stringify(context.messages).includes(secret));
        assert.ok(!JSON.stringify(context.messages).includes('persistence-write-failure'));
        return streamOf(assistant('Recovered the saved request without repeating the interrupted read'));
      } };
    service = await LocalWebService.open(options);
    const waitFor = async (ready: (status: Awaited<ReturnType<LocalWebService['status']>>) => boolean) => {
      const end = Date.now() + 10_000;
      while (!ready(await service!.status())) {
        if (Date.now() > end) throw Error('Synthetic web diagnostic did not settle');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await waitFor(status => status.state === 'idle');
    await service.submit({ id: 'diagnostic-user', text: 'Read the synthetic file', occurredAt: '2026-10-07T12:00:00.000Z' });
    await waitFor(status => status.error !== null);
    assert.equal(requests, 1); assert.equal((await service.status()).state, 'stopped');
    app = createLocalHttp({ backend: service, port: 4317 });
    const response = await app.inject({ url: '/api/status', headers: { host: '127.0.0.1:4317', 'x-mira-client': 'web' } });
    assert.equal(response.statusCode, 200); assert.equal(response.json().state, 'stopped');
    assert.match(response.json().error, /temporary server notice; no durable tool diagnostic is confirmed/);
    assert.ok(!response.body.includes(secret));
    const timeline = await service.timeline(); assert.deepEqual(timeline.items.map(item => item.role), ['user']);
    assert.ok(!JSON.stringify(timeline).includes(secret));
    const calls = (await db.admin.query('SELECT intent, outcome FROM tool_executions')).rows;
    assert.equal(calls.length, 1); assert.equal(calls[0].intent.callId, 'read-a'); assert.equal(calls[0].outcome, null);
    const before = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    assert.ok(!before.some(row => row.envelope.payload.type === 'custom_message'));
    await app.close(); app = undefined; await service.close(); service = undefined;
    service = await LocalWebService.open(options); await waitFor(status => status.state === 'idle');
    assert.equal(requests, 2); assert.equal((await service.status()).error, null);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE completed')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 1);
    const after = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    assert.deepEqual(after.slice(0, before.length), before);
    assert.ok(!JSON.stringify(after).includes(secret));
    assert.deepEqual((await service.timeline()).items.map(item => item.role), ['user', 'assistant']);
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
