import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf, runtime } from './fixtures.mts';

for (const missing of [false, true]) test(`real service continues the same Wake after ${missing ? 'unknown tool' : 'terminal output budget'} rejection and preserves diagnosis across restart`, { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-preflight-pg-'));
  let service: LocalWebService | undefined, requests = 0;
  const marker = path.join(root, 'executed');
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'preflight-parent', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
  try {
    service = await LocalWebService.open({ ...options, syntheticStream: async (_model, context) => {
      requests++;
      if (requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'rejected', name: missing ? 'nonexistent_tool' : 'exec_command', arguments: { command: `printf rejected > ${marker}`, yield_ms: 1000, max_output_bytes: 9000 } },
        { type: 'toolCall', id: 'stale-sibling', name: 'exec_command', arguments: { command: `printf stale > ${marker}` } },
      ] });
      const messages = JSON.stringify(context.messages);
      assert.match(messages, missing ? /tool-not-found/ : /invalid-arguments/);
      assert.match(messages, /No execution started/);
      if (!missing) { assert.match(messages, /maximum/); assert.match(messages, /8192/); }
      if (requests === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'corrected', name: 'exec_command', arguments: { command: `printf corrected > ${marker}`, yield_ms: 1000, max_output_bytes: 8192 } }] });
      assert.equal(requests, 3); return streamOf(assistant('The corrected operation completed in the same Wake'));
    } });
    await service.submit({ id: 'preflight-request', text: 'Perform the synthetic command', occurredAt: new Date().toISOString() });
    const deadline = Date.now() + 10_000;
    while ((await service.status()).state !== 'idle') { assert.ok(Date.now() < deadline); assert.notEqual((await service.status()).state, 'error'); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(requests, 3); assert.equal(await readFile(marker, 'utf8'), 'corrected');
    assert.deepEqual((await db.admin.query('SELECT call_id FROM tool_executions')).rows.map(row => row.call_id), ['corrected']);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs WHERE completed')).rows[0].n, 1);
    const original = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows.map(row => row.envelope);
    await service.close(); service = undefined;
    const writer = await db.acquire('preflight-parent'); const recovered = await runtime(writer).recover();
    assert.deepEqual(recovered.snapshot.records, original);
    assert.equal(recovered.recovery.operations[0]!.diagnostic!.category, missing ? 'tool-not-found' : 'invalid-arguments');
    assert.equal(recovered.recovery.operations[0]!.status, 'not-started');
    await writer.close();
    service = await LocalWebService.open({ ...options, syntheticStream: async () => { throw Error('Completed Wake must not be replayed'); } });
    const restartDeadline = Date.now() + 5000;
    while ((await service.status()).state !== 'idle') { assert.ok(Date.now() < restartDeadline); assert.notEqual((await service.status()).state, 'error'); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(await readFile(marker, 'utf8'), 'corrected');
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PostgreSQL rejection-observation write failure stays fatal without command execution or a second model request', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-preflight-fence-'));
  let service: LocalWebService | undefined, requests = 0;
  try {
    await db.admin.query(`CREATE FUNCTION reject_preflight_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.envelope->'payload'->>'type'='custom_message' THEN RAISE EXCEPTION 'synthetic preflight write fault'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_preflight_notice BEFORE INSERT ON context_records FOR EACH ROW EXECUTE FUNCTION reject_preflight_notice()`);
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'preflight-fence', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: async () => { requests++; return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{type:'toolCall',id:'rejected',name:'exec_command',arguments:{command:'echo never',max_output_bytes:9000}}] }); } });
    await service.submit({ id: 'preflight-fenced', text: 'Test rejected arguments', occurredAt: new Date().toISOString() });
    const deadline = Date.now() + 10_000;
    while (!['error', 'stopped'].includes((await service.status()).state)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(requests, 1); assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 0);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM context_records WHERE envelope->'payload'->>'type'='custom_message'")).rows[0].n, 0);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
