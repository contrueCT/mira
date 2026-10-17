import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, streamOf } from './fixtures.mts';
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw Error('Combined capability condition did not settle'); await pause(10); }
}
const childContext = (context: Parameters<StreamFn>[1]) => getCurrentSystemPrompt(context.messages).includes('task-scoped worker');
function options(db: Awaited<ReturnType<typeof createTestDatabase>>, root: string, syntheticStream: StreamFn) {
  return { connectionString: db.connectionString, schema: db.schema, miraId: 'capability-parent', sourceDirectory: process.cwd(),
    workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    synthetic: true, syntheticStream, autoCompaction: { enabled: false }, dreaming: { enabled: false } };
}

test('committed live user input releases subagent_wait and enters the model before its old sibling without cancelling child', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-capability-wait-'));
  const release = deferred(); let service: LocalWebService | undefined; let parentCalls = 0; let childId = '';
  try {
    service = await LocalWebService.open(options(db, root, async (_m, context) => {
      if (childContext(context)) { await release.promise; return streamOf(assistant('CHILD_WAIT_RESULT')); }
      parentCalls++;
      if (parentCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'wait-spawn', name: 'subagent_spawn', arguments: { task: 'Wait for the assigned test result' } }] });
      if (parentCalls === 2) {
        const child = (await db.admin.query('SELECT child_id FROM subagents')).rows[0]; childId = child.child_id;
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'wait-child', name: 'subagent_wait', arguments: { id: childId, timeoutMs: 10_000 } },
          { type: 'toolCall', id: 'wait-old-sibling', name: 'bash', arguments: { command: 'printf forbidden' } },
        ] });
      }
      if (parentCalls === 3) {
        assert.match(JSON.stringify(context.messages), /USER_DURING_WAIT/);
        assert.match(JSON.stringify(context.messages), /live_input/);
        assert.match(JSON.stringify(context.messages), /Execution did not start/);
        assert.equal((await db.admin.query('SELECT status FROM subagent_turns WHERE child_id=$1', [childId])).rows[0].status, 'running');
        return streamOf(assistant('Handled the user first'));
      }
      assert.equal(parentCalls, 4); assert.match(JSON.stringify(context.messages), /CHILD_WAIT_RESULT/);
      return streamOf(assistant('Handled child after user'));
    }));
    await service.submit({ id: 'wait-initial', text: 'Delegate a test', occurredAt: new Date().toISOString() });
    await until(async () => !!(await db.admin.query("SELECT 1 FROM tool_executions WHERE call_id='wait-child'")).rowCount);
    const start = Date.now();
    await service.submit({ id: 'wait-user', text: 'USER_DURING_WAIT', occurredAt: new Date().toISOString() });
    await until(() => parentCalls === 3);
    assert.ok(Date.now() - start < 5_000, 'wait must release before its ten-second timeout');
    await until(async () => (await service!.status()).state === 'idle');
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE call_id='wait-old-sibling'")).rows[0].n, 0);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
    release.resolve(); await until(() => parentCalls === 4); await until(async () => (await service!.status()).state === 'idle');
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n, 1);
  } finally { release.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('child completion persists behind a failed main run without silently clearing its error or retrying inference', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-capability-error-'));
  const release = deferred(); let service: LocalWebService | undefined; let parentCalls = 0;
  try {
    service = await LocalWebService.open(options(db, root, async (_m, context) => {
      if (childContext(context)) { await release.promise; return streamOf(assistant('QUEUED_AFTER_PARENT_FAILURE')); }
      parentCalls++;
      if (parentCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'error-spawn', name: 'subagent_spawn', arguments: { task: 'Independent bounded test' } }] });
      throw Error('Synthetic parent provider failure');
    }));
    await service.submit({ id: 'error-initial', text: 'Delegate test work', occurredAt: new Date().toISOString() });
    await until(async () => (await service!.status()).state === 'error'); assert.equal(parentCalls, 2);
    release.resolve();
    await until(async () => (await db.admin.query('SELECT status FROM subagent_turns')).rows[0]?.status === 'completed');
    await pause(150);
    assert.equal(parentCalls, 2); assert.equal((await service.status()).state, 'error');
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NULL')).rows[0].n, 1);
  } finally { release.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});


test('real service child provider completion enters main after current bash, before old siblings and without an extra Wake', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-child-insert-'));
  const childRelease = deferred(); let service: LocalWebService | undefined; let parentCalls = 0; let childCalls = 0;
  const gate = path.join(root, 'release');
  try {
    service = await LocalWebService.open(options(db, root, async (_m, context) => {
      if (childContext(context)) { childCalls++; await childRelease.promise; return streamOf(assistant('LIVE_CHILD_FINDING')); }
      parentCalls++;
      if (parentCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'live-spawn', name: 'subagent_spawn', arguments: { task: 'Return a controlled finding' } }] });
      if (parentCalls === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'live-current', name: 'bash', arguments: { command: `while [ ! -f '${gate}' ]; do sleep 0.02; done; printf CURRENT_FINISHED` } },
        { type: 'toolCall', id: 'live-stale', name: 'bash', arguments: { command: 'printf MUST_NOT_RUN' } },
      ] });
      assert.equal(parentCalls, 3);
      const text = JSON.stringify(context.messages); assert.match(text, /LIVE_CHILD_FINDING/); assert.match(text, /CURRENT_FINISHED/);
      assert.match(text, /Execution did not start/); assert.match(text, /not user instructions or permission/);
      return streamOf(assistant('Main chose to report the finding'));
    }));
    await service.submit({ id: 'live-initial', text: 'Delegate and continue', occurredAt: new Date().toISOString() });
    await until(async () => !!(await db.admin.query("SELECT 1 FROM tool_executions WHERE call_id='live-current'")).rowCount);
    childRelease.resolve();
    await until(async () => !!(await db.admin.query('SELECT 1 FROM wake_live_inputs')).rowCount);
    assert.equal(parentCalls, 2);
    assert.equal((await db.admin.query("SELECT outcome FROM tool_executions WHERE call_id='live-current'")).rows[0].outcome, null);
    await writeFile(gate, 'release'); await until(async () => (await service!.status()).state === 'idle');
    assert.equal(parentCalls, 3); assert.equal(childCalls, 1);
    assert.equal((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE call_id='live-stale'")).rows[0].n, 0);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NOT NULL')).rows[0].n, 1);
    assert.doesNotMatch(JSON.stringify(await service.timeline()), /LIVE_CHILD_FINDING/);
    await service.close(); service = await LocalWebService.open(options(db, root, () => { throw Error('No completion replay after restart'); }));
    await until(async () => (await service!.status()).state === 'idle');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
  } finally { childRelease.resolve(); await writeFile(gate, 'release').catch(() => {}); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
