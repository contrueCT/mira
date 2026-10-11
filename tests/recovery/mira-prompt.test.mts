import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import type { PiRuntimeOptions } from '@mira/runtime-pi';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, runtime, streamOf } from './fixtures.mts';

const template = await readFile(new URL('../../packages/runtime-pi/prompts/mira-system-v0.2.md', import.meta.url), 'utf8');
function assertFullPrompt(context: TranscriptContext): string {
  assert.equal(JSON.stringify(context.messages).split('# Mira System Prompt v0.2').length - 1, 1, 'raw provider transcript contains one full prompt, not additive obsolete copies');
  const system = getCurrentSystemMessage(context.messages);
  assert.ok(system, 'provider receives an effective system message');
  const text = getSystemMessageText(system);
  assert.equal(text.split('# Mira System Prompt v0.2').length - 1, 1, 'one effective Mira template');
  let position = 0;
  for (const literal of template.split(/\{\{[A-Z_]+\}\}/)) {
    const next = text.indexOf(literal, position);
    assert.ok(next >= position, 'every literal byte of the supplied template reaches the provider in order');
    position = next + literal.length;
  }
  return text;
}
const prompt: NonNullable<PiRuntimeOptions['miraPrompt']> = {
  memoryRoot: '/synthetic-memory', extensionsRoot: '/synthetic-extensions',
  environmentContext: 'Synthetic isolated acceptance test; no model network',
  authorizationContext: 'Synthetic test authorization only',
  now: () => new Date('2026-10-05T12:00:00.000Z'),
};
async function rawHistory(db: Awaited<ReturnType<typeof createTestDatabase>>, miraId: string) {
  return (await db.admin.query('SELECT version, record_id, parent_id, envelope::text AS raw FROM context_records WHERE mira_id = $1 ORDER BY version', [miraId])).rows;
}

test('real PostgreSQL: full Mira prompt refreshes Memory atomically at compaction and preserves it across restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    let loads = 0; let requests = 0;
    const writer = await db.acquire('prompt-continuity');
    const configured = { ...prompt, loadMemory: async () => { loads++; return 'Frozen original Memory'; } };
    await runtime(writer, (_model, context) => {
      requests++; assert.match(assertFullPrompt(context), /Frozen original Memory/);
      return streamOf(assistant('Earlier response '.repeat(150)));
    }, { miraPrompt: configured, autoCompaction: { enabled: false } }).run(input('Older discussion '.repeat(150)));
    assert.equal(loads, 1);
    const prefix = await rawHistory(db, writer.miraId);
    await writer.close();
    const restarted = await db.acquire('prompt-continuity');
    const noRead = { ...prompt, loadMemory: async () => { throw Error('normal restart must not reread Memory'); }, now: () => new Date('2026-10-05T13:00:00.000Z') };
    await runtime(restarted, (_model, context) => {
      requests++;
      const text = assertFullPrompt(context);
      assert.match(text, /Frozen original Memory/); assert.match(text, /2026-10-05T13:00:00.000Z/);
      return streamOf(assistant('Latest answer'));
    }, { miraPrompt: noRead, autoCompaction: { enabled: false } }).run(input('Latest question'));
    let summaries = 0;
    const refresh = { ...noRead, loadMemory: async () => { loads++; return 'New Memory at compaction'; } };
    const compacted = await runtime(restarted, () => {
      summaries++; return streamOf(assistant('Synthetic SDK summary preserving the earlier discussion'));
    }, { miraPrompt: refresh, autoCompaction: { enabled: false } }).compact({ keepRecentTokens: 1 });
    assert.ok(summaries > 0, 'full public SDK compaction called the injected summarizer');
    assert.equal(compacted.entries.filter(entry => entry.type === 'compaction').length, 1);
    await restarted.close();
    const afterCompaction = await db.acquire('prompt-continuity');
    await runtime(afterCompaction, (_model, context) => {
      requests++;
      const text = assertFullPrompt(context);
      assert.match(text, /New Memory at compaction/); assert.doesNotMatch(text, /Frozen original Memory/);
      return streamOf(assistant());
    }, { miraPrompt: noRead, autoCompaction: { enabled: false } }).run(input('Continue after compaction'));
    assert.equal(requests, 3); assert.equal(loads, 2);
    assert.deepEqual((await rawHistory(db, writer.miraId)).slice(0, prefix.length), prefix, 'raw PostgreSQL envelope prefix is byte-for-byte immutable');
  } finally { await db.close(); }
});
