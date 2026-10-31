import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import { assistant, input, MemoryWriter, model, runtime, streamOf } from '../recovery/fixtures.mts';

const roomy = { ...model, contextWindow: 65_536 };
const disabled = { enabled: false };
const systemText = (context: Pick<TranscriptContext, 'messages'>) => { const system = getCurrentSystemMessage(context.messages); return system ? getSystemMessageText(system) : ''; };

test('a pending Memory reset refreshes the frozen snapshot once through compaction, then clears its marker', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-memory-refresh-'));
  try {
    const file = path.join(directory, 'MEMORY.md'); await writeFile(file, 'OLD_FACT: likes oolong');
    const miraPrompt = { memoryRoot: directory, environmentContext: 'Synthetic', authorizationContext: 'None', loadMemory: async () => readFile(file, 'utf8') };
    const writer = new MemoryWriter();
    await runtime(writer, () => streamOf(assistant('First answer')), { model: roomy, autoCompaction: disabled, miraPrompt }).run(input('First question'));
    await writeFile(file, '');
    const contexts: TranscriptContext[] = []; let refreshed = 0;
    await runtime(writer, (_model, context) => { contexts.push(context); return streamOf(assistant(contexts.length === 1 ? 'Synthetic summary of the earlier talk' : 'Second answer')); },
      { model: roomy, autoCompaction: disabled, miraPrompt: { ...miraPrompt, refreshMemory: async () => { refreshed++; } } }).run(input('Second question'));
    assert.equal(refreshed, 1);
    assert.equal(contexts.length, 2, 'one compaction summary request, then the natural request');
    assert.doesNotMatch(systemText(contexts[1]!), /OLD_FACT/, 'the reset Memory replaced the frozen snapshot');
    assert.ok((await writer.load()).records.some(record => record.kind === 'checkpoint'));
    // Ordinary later Wakes reuse the refreshed snapshot and never compact again.
    const later: TranscriptContext[] = [];
    await runtime(writer, (_model, context) => { later.push(context); return streamOf(assistant('Third answer')); }, { model: roomy, autoCompaction: disabled, miraPrompt }).run(input('Third question'));
    assert.equal(later.length, 1); assert.doesNotMatch(systemText(later[0]!), /OLD_FACT/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a refresh request is satisfied without compaction when the frozen Memory is already current', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-memory-refresh-'));
  try {
    const file = path.join(directory, 'MEMORY.md'); await writeFile(file, '');
    const miraPrompt = { memoryRoot: directory, environmentContext: 'Synthetic', authorizationContext: 'None', loadMemory: async () => readFile(file, 'utf8') };
    const writer = new MemoryWriter(); let refreshed = 0; let requests = 0;
    await runtime(writer, () => { requests++; return streamOf(assistant('Fresh answer')); }, { model: roomy, autoCompaction: disabled, miraPrompt: { ...miraPrompt, refreshMemory: async () => { refreshed++; } } }).run(input('Hello'));
    assert.equal(refreshed, 1); assert.equal(requests, 1);
    assert.equal((await writer.load()).records.filter(record => record.kind === 'checkpoint').length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
