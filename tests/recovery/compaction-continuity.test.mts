import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { currentMemory } from '@mira/runtime-pi';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, model, overrideWriter, runtime, seed, streamOf } from './fixtures.mts';

// Real isolated PostgreSQL persistence; completions are deterministic mocks.
// These tests do not establish native model output quality or external effects.
const largeModel = { ...model, contextWindow: 65536 };
const disabled = { enabled: false };
function dataMessage(context: TranscriptContext): Record<string, any> {
  const user = context.messages.find(message => message.role === 'user'); assert.ok(user);
  assert.equal(typeof user.content, 'string');
  return JSON.parse(user.content as string);
}
async function rawHistory(db: Awaited<ReturnType<typeof createTestDatabase>>, miraId: string) {
  return (await db.admin.query('SELECT version, record_id, parent_id, envelope::text AS raw FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId])).rows;
}

for (const interruptBeforeCommit of [false, true]) test(`real PostgreSQL: continuity candidate ${interruptBeforeCommit ? 'interruption publishes neither Memory nor summary' : 'commits the selected Memory and summary together across restart'}`, { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-pg-continuity-'));
  try {
    const file = path.join(directory, 'MEMORY.md'); await writeFile(file, 'ORIGINAL_DURABLE_MEMORY');
    let loads = 0;
    const miraPrompt = {
      memoryRoot: directory, extensionsRoot: '/synthetic-extensions',
      environmentContext: 'Isolated PostgreSQL continuity test', authorizationContext: 'No external actions',
      now: () => new Date('2026-10-11T12:00:00Z'),
      loadMemory: async () => { loads++; return readFile(file, 'utf8'); },
    };
    const writer = await db.acquire('continuity-candidate');
    await runtime(writer, () => streamOf(assistant('Earlier response '.repeat(100))), { model: largeModel, autoCompaction: disabled, miraPrompt }).run(input('Earlier discussion '.repeat(100)));
    await seed(writer, [input('Still waiting on a reply'), assistant('Recent answer')]);
    const before = await writer.load(); const prefix = await rawHistory(db, writer.miraId);
    await writeFile(file, 'SELECTED_MEMORY_BEFORE_SUMMARY');
    const selectedWriter = interruptBeforeCommit ? overrideWriter(writer, { append: async () => { throw Error('Synthetic interruption immediately before durable append'); } }) : writer;
    let summaries = 0;
    const compacting = runtime(selectedWriter, async (_model, context) => {
      summaries++; const data = dataMessage(context);
      assert.equal(data.memory_snapshot, 'SELECTED_MEMORY_BEFORE_SUMMARY'); assert.equal(loads, 2);
      await writeFile(file, 'LATER_DISK_EDIT_DURING_SUMMARY');
      return streamOf(assistant('DURABLE_CONTINUITY_SUMMARY'));
    }, { model: largeModel, autoCompaction: disabled, miraPrompt }).compact({ keepRecentTokens: 1 });
    if (interruptBeforeCommit) await assert.rejects(compacting, /Synthetic interruption/); else await compacting;
    assert.equal(summaries, 1); assert.equal(loads, 2);
    const saved = await writer.load();
    assert.deepEqual((await rawHistory(db, writer.miraId)).slice(0, prefix.length), prefix);
    assert.equal(saved.version, before.version + (interruptBeforeCommit ? 0 : 1));
    if (interruptBeforeCommit) assert.deepEqual(saved, before);
    await writer.close();
    const restarted = await db.acquire('continuity-candidate');
    const recovered = await runtime(restarted, () => { throw Error('Recovery cannot call a summary model'); }, {
      model: largeModel, autoCompaction: disabled,
      miraPrompt: { ...miraPrompt, loadMemory: async () => { throw Error('Recovery must use durable Memory'); } },
    }).recover();
    assert.deepEqual(recovered.snapshot, saved);
    assert.equal(currentMemory(recovered.entries), interruptBeforeCommit ? 'ORIGINAL_DURABLE_MEMORY' : 'SELECTED_MEMORY_BEFORE_SUMMARY');
    assert.doesNotMatch(JSON.stringify(recovered.snapshot), /LATER_DISK_EDIT_DURING_SUMMARY/);
    if (interruptBeforeCommit) assert.doesNotMatch(JSON.stringify(recovered.snapshot), /DURABLE_CONTINUITY_SUMMARY|SELECTED_MEMORY_BEFORE_SUMMARY/);
    else assert.match(JSON.stringify(recovered.messages), /DURABLE_CONTINUITY_SUMMARY/);
  } finally { await db.close(); await rm(directory, { recursive: true, force: true }); }
});
