import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { LocalWebService, createLocalHttp } from '@mira/server';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';
import { createExtensionFixture } from './extension-fixtures.mts';

async function settled(service: LocalWebService): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > deadline) throw Error('Service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

test('management current Memory reads do not refresh frozen context; exact request receipts survive restart and unrelated failures', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-management-service-'));
  let service: LocalWebService | undefined; let calls = 0; let fail = false; const prompts: string[] = [];
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'management',
      sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      memoryRoot: path.join(root, 'memory'), miraHome: root, synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        calls++; prompts.push(JSON.stringify(context.messages.filter(message => message.role === 'system')));
        if (fail) throw Error('PRIVATE_MODEL_FAILURE_SENTINEL');
        return streamOf({ ...assistant(`Response ${calls}`), content: [{ type: 'thinking', thinking: 'PRIVATE_THINKING_SENTINEL' }, { type: 'text', text: `Response ${calls}` }] });
      } };
    service = await LocalWebService.open(options); await settled(service);
    assert.equal(calls, 0); assert.equal((await service.memory()).content, '');
    await writeFile(path.join(root, 'memory', 'MEMORY.md'), 'External initial Memory');
    const firstView = await service.memory(); assert.equal(firstView.content, 'External initial Memory');
    assert.equal(calls, 0, 'display reads cannot wake the runtime');
    const first = { id: 'memory-first', text: 'Remember this explicit preference', occurredAt: '2026-10-13T01:00:00.000Z' };
    await service.submit(first); await settled(service);
    const status = await service.messageStatus(first.id);
    assert.equal(status.state, 'completed'); assert.equal(status.assistant?.text, 'Response 1'); assert.equal(status.memory.state, 'changed'); assert.match(status.memory.commit!, /^[a-f0-9]{40,64}$/);
    assert.match(prompts[0]!, /External initial Memory/);
    // This commit captured a preexisting external edit, not proof of assistant authorship.
    await writeFile(path.join(root, 'memory', 'MEMORY.md'), 'External newer Memory');
    const newer = await service.memory(); assert.equal(newer.content, 'External newer Memory'); assert.notEqual(newer.revision, firstView.revision);
    const second = { ...first, id: 'memory-second', text: 'Continue normally' };
    await service.submit(second); await settled(service);
    assert.equal(calls, 2); assert.match(prompts[1]!, /External initial Memory/); assert.doesNotMatch(prompts[1]!, /External newer Memory/);
    assert.equal((await service.messageStatus(second.id)).memory.state, 'changed');
    await service.submit({ ...first, id: 'memory-no-change', text: 'Continue without edits' }); await settled(service);
    const unchanged = await service.messageStatus('memory-no-change'); assert.equal(unchanged.state, 'completed'); assert.equal(unchanged.memory.state, 'unchanged'); assert.equal(unchanged.memory.commit, null);
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service);
    assert.equal(calls, 3); assert.deepEqual(await service.messageStatus(first.id), status); assert.equal((await service.memory()).content, 'External newer Memory');
    assert.equal((await service.submit(first)).receipt, 'duplicate'); await settled(service); assert.equal(calls, 3);
    fail = true;
    await service.submit({ ...first, id: 'memory-failed', text: 'A failing request' }); await settled(service);
    const failed = await service.messageStatus('memory-failed'); assert.equal(failed.state, 'failed'); assert.equal(failed.assistant, null); assert.ok(failed.error);
    assert.equal((await service.messageStatus(first.id)).state, 'completed', 'a later run failure cannot relabel an earlier request');
    assert.equal((await service.messageStatus('missing')).state, 'unknown');
    await service.submit({ ...first, id: 'memory-queued', text: 'New input for the unfinished failed run' }); await settled(service);
    const supplemental = await service.messageStatus('memory-queued');
    assert.equal(supplemental.state, 'failed', 'new input joins the unfinished run and its fresh failed attempt');
    assert.equal(supplemental.runId, failed.runId);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NOT NULL')).rows[0].n, 1);
    const app = createLocalHttp({ backend: service, port: 4317 });
    try {
      const response = await app.inject({ url: `/api/runs/${status.runId}`, headers: { host: '127.0.0.1:4317', 'x-mira-client': 'web' } });
      assert.equal(response.statusCode, 200, response.body); assert.equal(response.json().assistant.text, 'Response 1');
      assert.equal(response.json().memory.commit, status.memory.commit); assert.equal(response.json().requests[0].eventId, status.eventId);
      assert.equal(response.json().compactionErrors, 'not-recorded'); assert.ok(response.json().executions.some((entry: { kind: string }) => entry.kind === 'model'));
      assert.doesNotMatch(response.body, /PRIVATE_THINKING_SENTINEL|PRIVATE_MODEL_FAILURE_SENTINEL|External initial Memory|requestedArguments|miraPrompt/);
    } finally { await app.close(); }
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('management extension HTTP changes use real host persistence, stale revision conflicts and write-only configuration', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const fixture = await createExtensionFixture(); let service: LocalWebService | undefined;
  const secret = 'PRIVATE_EXTENSION_CONFIGURATION_SENTINEL';
  try {
    const configurationFile = path.join(fixture.root, 'extensions.json');
    const entries = [{ id: 'example', path: fixture.modulePath, config: { ...fixture.config, token: secret } }];
    await writeFile(configurationFile, JSON.stringify({ entries }));
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'extension-management',
      sourceDirectory: process.cwd(), spoolDirectory: path.join(fixture.root, 'spool'), settingsFile: path.join(fixture.root, 'models.json'),
      miraHome: fixture.root, synthetic: true, extensions: { entries, configurationFile } });
    await settled(service);
    const app = createLocalHttp({ backend: service, port: 4317 });
    const readHeaders = { host: '127.0.0.1:4317', 'x-mira-client': 'web' };
    const writeHeaders = { ...readHeaders, origin: 'http://127.0.0.1:4317', 'content-type': 'application/json' };
    try {
      const original = await app.inject({ url: '/api/extensions', headers: readHeaders }); assert.equal(original.statusCode, 200); assert.doesNotMatch(original.body, new RegExp(secret)); assert.doesNotMatch(original.body, /effectsPath|modulePath/);
      const initial = original.json().extensions[0]; assert.equal(initial.status, 'active'); assert.deepEqual(initial.tools, ['fixture_echo']);
      const request = { method: 'POST' as const, url: '/api/extensions/example', headers: writeHeaders, payload: { action: 'disable', expectedRevision: initial.revision } };
      const disabled = await app.inject(request); assert.equal(disabled.statusCode, 200, disabled.body); assert.equal(disabled.json().persistence, 'saved'); assert.equal(disabled.json().runtime.status, 'disabled');
      assert.equal((await app.inject(request)).statusCode, 409, 'a repeated stale lifecycle mutation must not reexecute');
      const configured = await app.inject({ ...request, payload: { action: 'configure', expectedRevision: disabled.json().runtime.revision, config: { ...fixture.config, token: secret, toolName: 'changed_echo' } } });
      assert.equal(configured.statusCode, 200, configured.body); assert.doesNotMatch(configured.body, new RegExp(secret));
      const enabled = await app.inject({ ...request, payload: { action: 'enable', expectedRevision: configured.json().runtime.revision } });
      assert.equal(enabled.statusCode, 200, enabled.body); assert.equal(enabled.json().runtime.status, 'active'); assert.deepEqual(enabled.json().runtime.tools, ['changed_echo']);
      const saved = JSON.parse(await readFile(configurationFile, 'utf8')); assert.equal(saved.entries[0].config.token, secret); assert.equal(saved.entries[0].config.toolName, 'changed_echo');
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 0, 'direct settings lifecycle changes do not create synthetic model Wake runs');
    } finally { await app.close(); }
  } finally { await service?.close(); await db.close(); await rm(fixture.root, { recursive: true, force: true }); }
});
