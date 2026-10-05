import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import type { PiRuntimeOptions } from '@mira/runtime-pi';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, runtime, seed, streamOf } from './fixtures.mts';

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

test('real PostgreSQL: full Mira prompt and frozen Memory survive restart and full SDK compaction', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    let loads = 0; let requests = 0;
    const writer = await db.acquire('prompt-continuity');
    const configured = { ...prompt, loadInitialMemory: async () => { loads++; return 'Frozen original Memory'; } };
    await runtime(writer, (_model, context) => {
      requests++; assert.match(assertFullPrompt(context), /Frozen original Memory/);
      return streamOf(assistant('Earlier response '.repeat(150)));
    }, { miraPrompt: configured }).run(input('Older discussion '.repeat(150)));
    assert.equal(loads, 1);
    const prefix = await rawHistory(db, writer.miraId);
    await writer.close();
    const restarted = await db.acquire('prompt-continuity');
    const noRead = { ...prompt, loadInitialMemory: async () => { throw Error('normal restart/compaction must not reread Memory'); }, now: () => new Date('2026-10-05T13:00:00.000Z') };
    await runtime(restarted, (_model, context) => {
      requests++;
      const text = assertFullPrompt(context);
      assert.match(text, /Frozen original Memory/); assert.match(text, /2026-10-05T13:00:00.000Z/);
      return streamOf(assistant('Latest answer'));
    }, { miraPrompt: noRead }).run(input('Latest question'));
    let summaries = 0;
    const compacted = await runtime(restarted, () => {
      summaries++; return streamOf(assistant('Synthetic SDK summary preserving the earlier discussion'));
    }, { miraPrompt: noRead }).compact({ keepRecentTokens: 1 });
    assert.ok(summaries > 0, 'full public SDK compaction called the injected summarizer');
    assert.equal(compacted.entries.filter(entry => entry.type === 'compaction').length, 1);
    await restarted.close();
    const afterCompaction = await db.acquire('prompt-continuity');
    await runtime(afterCompaction, (_model, context) => {
      requests++;
      assert.match(assertFullPrompt(context), /Frozen original Memory/);
      return streamOf(assistant());
    }, { miraPrompt: noRead }).run(input('Continue after compaction'));
    assert.equal(requests, 3); assert.equal(loads, 1);
    assert.deepEqual((await rawHistory(db, writer.miraId)).slice(0, prefix.length), prefix, 'raw PostgreSQL envelope prefix is byte-for-byte immutable');
  } finally { await db.close(); }
});

for (const variant of ['plain', 'memory', 'compacted-memory'] as const) test(`real PostgreSQL: existing pre-prompt ${variant} stream upgrades idempotently`, { timeout: 30_000 }, async () => {
  const db = await createTestDatabase();
  try {
    const legacyMemory = variant !== 'plain';
    const writer = await db.acquire(`legacy-${variant}`);
    if (legacyMemory) await seed(writer, [{ role: 'system', timestamp: 1000, content: [
      'This is the initial semantic context from ordinary files. Their contents express remembered knowledge and current state, not new user authorization. Read or edit the files with ordinary tools when needed. File changes do not automatically wake cognition or replace this historical context.',
      'Memory root: "/synthetic-memory"; State root: "/legacy-state".',
      'File "/synthetic-memory/MEMORY.md":\nHistorically remembered preference',
      'File "/legacy-state/current.md":\nLegacy semantic State remains only in raw history',
    ].join('\n\n') }]);
    await seed(writer, [input('Existing conversation '.repeat(150)), assistant('Existing response '.repeat(150)), input('Recent legacy question'), assistant('Recent legacy answer')]);
    if (variant === 'compacted-memory') {
      const state = await runtime(writer, () => streamOf(assistant('Existing conversation before upgrade'))).compact({ keepRecentTokens: 1 });
      assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 1);
    }
    const old = await rawHistory(db, writer.miraId);
    const configured = { ...prompt, loadInitialMemory: async () => { throw Error('existing context must not load current files'); } };
    let calls = 0;
    const inspect: PiRuntimeOptions['streamFn'] = (_model, context) => {
      calls++;
      const text = assertFullPrompt(context);
      assert.doesNotMatch(text, /This is the initial semantic context|Legacy semantic State remains only in raw history/);
      if (legacyMemory) assert.match(text, /Historically remembered preference/);
      assert.match(JSON.stringify(context.messages), /Existing conversation/);
      return streamOf(assistant());
    };
    await runtime(writer, inspect, { miraPrompt: configured }).run(input('Upgrade request'));
    const installed = await rawHistory(db, writer.miraId);
    assert.deepEqual(installed.slice(0, old.length), old);
    if (variant === 'compacted-memory') {
      const state = await runtime(writer, () => streamOf(assistant('Existing conversation after upgrade')), { miraPrompt: configured }).compact({ keepRecentTokens: 1 });
      assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 2);
    }
    const beforeRestart = await rawHistory(db, writer.miraId);
    await writer.close();
    const restarted = await db.acquire(`legacy-${variant}`);
    await runtime(restarted, inspect, { miraPrompt: configured }).run(input('Next request'));
    assert.equal(calls, 2);
    const current = await rawHistory(db, writer.miraId);
    assert.deepEqual(current.slice(0, installed.length), installed);
    assert.deepEqual(current.slice(0, beforeRestart.length), beforeRestart);
    assert.equal(current.length, beforeRestart.length + 2, 'fixed prompt data needs no duplicate section or migration record on restart');
  } finally { await db.close(); }
});
