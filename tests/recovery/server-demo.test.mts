import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import { runDemo, memoryCheckpointHook, demoModel } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';
import { WakeLoop, type LifeEvent } from '@mira/life';
import { PostgresPersistence } from '@mira/persistence';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { setupMemoryWorkspace } from '@mira/workspace';

const suppliedTemplate = readFileSync(new URL('../../packages/runtime-pi/prompts/mira-system-v0.2.md', import.meta.url), 'utf8');
function assertMira(context: TranscriptContext): string {
  assert.equal(JSON.stringify(context.messages).split('# Mira System Prompt v0.2').length - 1, 1, 'provider transcript must not contain obsolete full prompt copies');
  const system = getCurrentSystemMessage(context.messages);
  assert.ok(system);
  const text = getSystemMessageText(system);
  assert.equal(text.split('# Mira System Prompt v0.2').length - 1, 1);
  let position = 0;
  for (const literal of suppliedTemplate.split(/\{\{[A-Z_]+\}\}/)) {
    const next = text.indexOf(literal, position);
    assert.ok(next >= position, 'full supplied template reaches provider');
    position = next + literal.length;
  }
  assert.match(text, /You are Mira\./);
  assert.match(text, /Example: remembering the fact without faking provenance/);
  assert.match(text, /Do not assume that every wake requires a user-visible response/);
  return text;
}

const event = (id: string): LifeEvent => ({ id, type: 'synthetic-message', source: 'user', occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: `Synthetic message ${id}` } });

test('server composition coalesces, restarts same Mira, deduplicates and leaves event-only history asleep', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const spool = await realpath(await mkdtemp('/tmp/mira-demo-pg-'));
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'demo-mira', sourceDirectory: process.cwd(), spoolDirectory: spool };
    const events = ['a', 'b', 'c'].map(id => ({ event: event(id), wake: { id: `wake-${id}`, reason: 'message' } }));
    const first = await runDemo({ ...options, events, streamFn: (_model, context) => { assertMira(context); return streamOf(assistant()); } });
    assert.equal(first.completedRuns, 1); assert.equal(first.modelCalls, 1);
    const duplicate = await runDemo({ ...options, events });
    assert.equal(duplicate.completedRuns, 0); assert.equal(duplicate.modelCalls, 0); assert.equal(duplicate.version, first.version);
    const historyOnly = await runDemo({ ...options, events: [{ event: event('history') }] });
    assert.equal(historyOnly.modelCalls, 0); assert.equal(historyOnly.version, first.version);
    const second = await runDemo({ ...options, events: [{ event: event('d'), wake: { id: 'wake-d', reason: 'next message' } }], streamFn: (_model, context) => { assertMira(context); return streamOf(assistant()); } });
    assert.equal(second.miraId, first.miraId); assert.equal(second.completedRuns, 1); assert.ok(second.version > first.version);
    const runs = await db.admin.query('SELECT completed FROM wake_runs WHERE mira_id = $1', [first.miraId]);
    assert.equal(runs.rows.length, 2); assert.ok(runs.rows.every(row => row.completed));
  } finally { await db.close(); await rm(spool, { recursive: true, force: true }); }
});

test('overflow is one run and the model can read the ordinary file through the ordinary tool', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const spool = await realpath(await mkdtemp('/tmp/mira-demo-overflow-'));
  let calls = 0; let filePath = ''; let observedToolText = '';
  try {
    const outcome = await runDemo({ connectionString: db.connectionString, schema: db.schema, miraId: 'overflow-mira', sourceDirectory: process.cwd(), spoolDirectory: spool, maxInlineBytes: 1,
      events: ['a', 'b', 'c'].map(id => ({ event: event(id), wake: { id: `wake-${id}`, reason: 'message' } })),
      streamFn: (_model, context) => {
        calls++;
        if (calls === 1) {
          const user = context.messages.find(message => message.role === 'user');
          const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
          const match = /stored at ("[^"\n]+")/.exec(text ?? '');
          if (!match) throw Error('Missing ordinary file path in overflow notice');
          filePath = JSON.parse(match[1]!);
          return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'ordinary-read', name: 'read', arguments: { path: filePath } }] });
        }
        const result = context.messages.find(message => message.role === 'toolResult');
        observedToolText = JSON.stringify(result?.content);
        return streamOf(assistant('Read the synthetic file.'));
      },
    });
    assert.equal(outcome.completedRuns, 1); assert.equal(calls, 2); // One turn, tool round trip.
    assert.match(filePath, /batch\.txt$/);
    const content = await readFile(filePath, 'utf8');
    for (const id of ['a', 'b', 'c']) { assert.match(content, new RegExp(`Synthetic message ${id}`)); assert.match(observedToolText, new RegExp(`Synthetic message ${id}`)); }
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
  } finally { await db.close(); await rm(spool, { recursive: true, force: true }); }
});


test('Memory-only bootstrap survives restart and file edits stay silent', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const data = await realpath(await mkdtemp('/tmp/mira-memory-demo-'));
  try {
    const memoryRoot = path.join(data, 'memory');
    await mkdir(memoryRoot);
    await writeFile(path.join(memoryRoot, 'MEMORY.md'), 'Original remembered preference');
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'memory-mira', sourceDirectory: process.cwd(), spoolDirectory: path.join(data, 'spool'), memory: { memoryRoot } };
    const wake = (id: string) => [{ event: event(id), wake: { id: `wake-${id}`, reason: 'synthetic' } }];
    const first = await runDemo({ ...options, events: wake('one'), streamFn: (_model, context) => {
      assert.match(JSON.stringify(context), /Original remembered preference/);
      assertMira(context);
      return streamOf(assistant());
    } });
    assert.equal(first.completedRuns, 1);
    const head = execFileSync('git', ['-C', memoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const second = await runDemo({ ...options, events: wake('two'), streamFn: (_model, context) => {
      assertMira(context);
      assert.match(JSON.stringify(context), /Original remembered preference/);
      return streamOf(assistant());
    } });
    assert.equal(second.modelCalls, 1);
    assert.equal(execFileSync('git', ['-C', memoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
    await writeFile(path.join(memoryRoot, 'MEMORY.md'), 'External memory edit stays silent');
    const noWake = await runDemo({ ...options, events: [] });
    assert.equal(noWake.modelCalls, 0); assert.equal(noWake.version, second.version);
    await runDemo({ ...options, events: wake('three'), streamFn: (_model, context) => {
      assertMira(context);
      assert.match(JSON.stringify(context), /Original remembered preference/);
      assert.doesNotMatch(JSON.stringify(context), /External memory edit stays silent/);
      return streamOf(assistant());
    } });
    assert.notEqual(execFileSync('git', ['-C', memoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), head);
    assert.equal(execFileSync('git', ['-C', memoryRoot, 'ls-files'], { encoding: 'utf8' }).trim(), 'MEMORY.md');
    const receipts = await db.admin.query('SELECT commit_id FROM wake_memory_receipts WHERE mira_id = $1', [options.miraId]);
    assert.equal(receipts.rows.length, 3); assert.equal(receipts.rows.filter(row => row.commit_id === null).length, 1);
  } finally { await db.close(); await rm(data, { recursive: true, force: true }); }
});


for (const replaceRepository of [false, true]) test(`Git-before-PG crash ${replaceRepository ? 'rejects replaced repository identity' : 'resumes without model or recapturing later edits'}`, { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const data = await realpath(await mkdtemp('/tmp/mira-memory-crash-'));
  let writer: Awaited<ReturnType<PostgresPersistence['acquire']>> | undefined;
  try {
    const memory = await setupMemoryWorkspace({ memoryRoot: path.join(data, 'memory'), sourceDirectory: process.cwd() });
    await writeFile(path.join(memory.memoryRoot, 'MEMORY.md'), 'Before checkpoint interruption');
    writer = await new PostgresPersistence({ connectionString: db.connectionString, schema: db.schema }).acquire('checkpoint-crash');
    await writer.receive(event('crash'), { id: 'wake-crash', reason: 'synthetic' });
    writer.finishMemoryCheckpoint = async () => { throw Error('synthetic receipt publication failure'); };
    let models = 0;
    const loop = new WakeLoop({ writer, writeOverflowInput: async () => { throw Error('unexpected overflow'); },
      createRuntime: () => new PiDurableRuntime({ writer: writer!, model: demoModel,
        miraPrompt: { memoryRoot: memory.memoryRoot, extensionsRoot: path.join(data, 'extensions'),
          environmentContext: 'Synthetic isolated checkpoint recovery test', authorizationContext: 'Synthetic test authorization only',
          loadMemory: () => readFile(path.join(memory.memoryRoot, 'MEMORY.md'), 'utf8') },
        streamFn: (_model, context) => { models++; assert.match(assertMira(context), /Before checkpoint interruption/); return streamOf(assistant()); } }),
      beforeComplete: memoryCheckpointHook(writer, memory.memoryRoot, memory.repositoryId),
    });
    await assert.rejects(loop.drain(), /receipt publication failure/);
    assert.equal(models, 1);
    const committed = execFileSync('git', ['-C', memory.memoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    await writer.close(); writer = undefined;
    await writeFile(path.join(memory.memoryRoot, 'MEMORY.md'), 'Later edit must wait for another wake');
    if (replaceRepository) {
      await rm(path.join(memory.memoryRoot, '.git'), { recursive: true, force: true });
      await assert.rejects(runDemo({ connectionString: db.connectionString, schema: db.schema, miraId: 'checkpoint-crash', sourceDirectory: process.cwd(), spoolDirectory: path.join(data, 'spool'), memory, events: [], streamFn: () => { throw Error('must not call model'); } }), /Restore the Memory repository/);
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_memory_receipts')).rows[0].n, 0);
      assert.equal((await db.admin.query('SELECT completed FROM wake_runs')).rows[0].completed, false);
      assert.throws(() => execFileSync('git', ['-C', memory.memoryRoot, 'rev-parse', '--verify', 'HEAD'], { stdio: 'pipe' }));
      return;
    }
    const resumed = await runDemo({ connectionString: db.connectionString, schema: db.schema, miraId: 'checkpoint-crash', sourceDirectory: process.cwd(), spoolDirectory: path.join(data, 'spool'), memory, events: [], streamFn: () => { throw Error('must not call model during receipt recovery'); } });
    assert.equal(resumed.completedRuns, 1); assert.equal(resumed.modelCalls, 0);
    assert.equal(execFileSync('git', ['-C', memory.memoryRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), committed);
    assert.equal(execFileSync('git', ['-C', memory.memoryRoot, 'show', 'HEAD:MEMORY.md'], { encoding: 'utf8' }), 'Before checkpoint interruption');
    assert.equal(await readFile(path.join(memory.memoryRoot, 'MEMORY.md'), 'utf8'), 'Later edit must wait for another wake');
    assert.equal((await db.admin.query('SELECT commit_id FROM wake_memory_receipts')).rows[0].commit_id, committed);
  } finally { await writer?.close(); await db.close(); await rm(data, { recursive: true, force: true }); }
});


test('inline wake uses an existing ordinary cwd and native shell without needing an overflow directory', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const data = await realpath(await mkdtemp('/tmp/mira-inline-shell-'));
  let calls = 0;
  try {
    const result = await runDemo({ connectionString: db.connectionString, schema: db.schema, miraId: 'inline-shell', sourceDirectory: process.cwd(), spoolDirectory: path.join(data, 'does-not-exist'), workingDirectory: data,
      events: [{ event: event('shell'), wake: { id: 'wake-shell', reason: 'synthetic command' } }],
      streamFn: (_model, context) => {
        calls++;
        if (calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'shell-first', name: 'bash', arguments: { command: 'printf harmless-inline' } }] });
        assert.match(JSON.stringify(context.messages.find(message => message.role === 'toolResult')), /harmless-inline/);
        return streamOf(assistant());
      },
    });
    assert.equal(result.completedRuns, 1); assert.equal(calls, 2);
  } finally { await db.close(); await rm(data, { recursive: true, force: true }); }
});


test('empty terminal assistant output durably completes a silent wake and is not replayed', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const spool = await realpath(await mkdtemp('/tmp/mira-silent-wake-'));
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'silent-mira', sourceDirectory: process.cwd(), spoolDirectory: spool };
    const events = [{ event: event('silent'), wake: { id: 'wake-silent', reason: 'nothing worth saying' } }];
    const first = await runDemo({ ...options, events, streamFn: (_model, context) => {
      assertMira(context);
      return streamOf({ ...assistant(), content: [] });
    } });
    assert.equal(first.completedRuns, 1); assert.equal(first.modelCalls, 1);
    const rows = await db.admin.query('SELECT completed, final_record_id FROM wake_runs WHERE mira_id = $1', [options.miraId]);
    assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].completed, true); assert.ok(rows.rows[0].final_record_id);
    const final = await db.admin.query('SELECT envelope FROM context_records WHERE mira_id = $1 AND record_id = $2', [options.miraId, rows.rows[0].final_record_id]);
    assert.deepEqual(final.rows[0].envelope.payload.message.content, []);
    const resumed = await runDemo({ ...options, events, streamFn: () => { throw Error('silent final must not replay'); } });
    assert.equal(resumed.completedRuns, 0); assert.equal(resumed.modelCalls, 0); assert.equal(resumed.version, first.version);
  } finally { await db.close(); await rm(spool, { recursive: true, force: true }); }
});
