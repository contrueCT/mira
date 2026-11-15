import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import path from 'node:path';
import { LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

for (const started of [false, true]) test(`browser ${started ? 'daemon failure' : 'preflight rejection'} reaches the next model request and durable tool outcome`, { timeout: 30_000 }, async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-browser-pg-')); const db = await createTestDatabase();
  const executable = path.join(root, 'native'); const previous = process.env['MIRA_AGENT_BROWSER_EXECUTABLE'];
  let service: LocalWebService | undefined; let requests = 0;
  try {
    if (started) { await writeFile(executable, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('agent-browser 0.39.1');process.exit(0);}process.stderr.write('error while loading shared libraries: libmissing.so synthetic-private-browser-detail');process.exit(127);`); await chmod(executable, 0o700); }
    process.env['MIRA_AGENT_BROWSER_EXECUTABLE'] = executable;
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'browser-failure-main',
      sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      synthetic: true, autoCompaction: { enabled: false }, dreaming: { enabled: false },
      syntheticStream: async (_model, context) => {
        requests++;
        if (requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'browser-failure-open', name: 'browser_open', arguments: { url: 'https://example.test/' } },
          { type: 'toolCall', id: 'browser-failure-list', name: 'browser_list', arguments: {} },
        ] });
        assert.equal(requests, 2);
        const messages = JSON.parse(JSON.stringify(context.messages)) as Array<{ role: string; toolName?: string; isError?: boolean; content?: Array<{ text?: string }> }>;
        const result = messages.find(message => message.role === 'toolResult' && message.toolName === 'browser_open')!;
        assert.ok(result); assert.equal(result.isError, true);
        const detail = JSON.parse(result.content![0]!.text!);
        assert.equal(detail.status, started ? 'unknown' : 'not_executed');
        assert.equal(detail.diagnostic.reason, started ? 'native_dependencies_missing' : 'executable_unavailable');
        assert.equal(detail.diagnostic.phase, started ? 'daemon_start' : 'dependency');
        assert.ok(!JSON.stringify(messages).includes('synthetic-private-browser-detail'));
        assert.ok(messages.some(message => message.toolName === 'browser_list'), 'ordinary error must not prevent the next tool');
        return streamOf(assistant('The exact browser dependency failure is visible.'));
      } });
    await service.submit({ id: 'diagnose-browser', text: 'Inspect the browser failure', occurredAt: new Date().toISOString() });
    const deadline = Date.now() + 10_000;
    while ((await service.status()).state !== 'idle') { assert.ok(Date.now() < deadline); assert.notEqual((await service.status()).state, 'error'); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal(requests, 2);
    const row = (await db.admin.query("SELECT outcome FROM tool_executions WHERE call_id='browser-failure-open'")).rows[0];
    assert.ok(row.outcome); assert.equal(row.outcome.payload.isError, true);
    assert.ok(!JSON.stringify(row.outcome).includes('synthetic-private-browser-detail'));
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
    assert.equal(service.browser.list()[0]!.state, started ? 'unknown' : 'closed');
  } finally {
    await service?.close(); await db.close(); await rm(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env['MIRA_AGENT_BROWSER_EXECUTABLE']; else process.env['MIRA_AGENT_BROWSER_EXECUTABLE'] = previous;
  }
});
