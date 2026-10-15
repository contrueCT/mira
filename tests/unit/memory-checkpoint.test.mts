import test from 'node:test';
import assert from 'node:assert/strict';
import type { SystemMessage } from '@earendil-works/pi-ai';
import type { CompactionEntry, SessionEntry } from '@earendil-works/pi-coding-agent';
import {
  currentMemory, memoryConfigured, currentPrompt, refreshMiraMemory, projectMiraPrompt,
  encodeEntry, decodeRecords, messageEntry, renderMiraPrompt, MIRA_PROMPT_SECTION, MIRA_PROMPT_SHA256,
  type MiraPromptSnapshot,
} from '@mira/runtime-pi';

function fixture(memory = '') {
  const prompt: MiraPromptSnapshot = { templateSha256: MIRA_PROMPT_SHA256, values: {
    MEMORY_ROOT: '/memory', MEMORY_STATE: memory, CURRENT_TIME: '2026-10-08T09:00:00.000Z',
    EXTENSIONS_ROOT: '/extensions', OTHER_ENVIRONMENT_CONTEXT: '<frozen environment>',
    DYNAMIC_TOOL_AND_EXTENSION_GUIDANCE: 'read: Read files', CURRENT_AUTHORIZATION_CONTEXT: 'frozen instructions',
  }, skills: '\n<available_skills>already &amp; escaped</available_skills>' };
  const bootstrap = messageEntry({ role: 'system', content: '', timestamp: 0, miraMemory: memory, miraMemoryConfigured: true } as never, null);
  const system: SystemMessage = { role: 'system', content: 'unrelated content', timestamp: 1,
    sections: { unrelated: 'preserve', [MIRA_PROMPT_SECTION]: renderMiraPrompt(prompt.values) + prompt.skills },
    toolsAdded: [{ name: 'read', description: 'Read files', parameters: { type: 'object' } }],
  };
  const rendered = messageEntry({ ...system, miraPrompt: prompt } as never, bootstrap.id);
  const entries: SessionEntry[] = [bootstrap, rendered];
  return { entries, prompt, system };
}
function checkpoint(entries: SessionEntry[], extra: object): CompactionEntry {
  return { type: 'compaction', id: 'checkpoint', parentId: entries.at(-1)!.id,
    timestamp: '2026-10-08T10:00:00.000Z', summary: 'Summary', firstKeptEntryId: entries[0]!.id,
    tokensBefore: 2000, ...extra };
}

test('checkpoint refresh replaces only Memory and retains frozen prompt inputs and skills', () => {
  const { entries, prompt, system } = fixture();
  const before = structuredClone({ entries, system });
  const memory = '</memory_state>{{CURRENT_TIME}} & new Memory';
  const refreshed = refreshMiraMemory(system, entries, memory);
  const expected = structuredClone(system);
  expected.sections![MIRA_PROMPT_SECTION] = renderMiraPrompt({ ...prompt.values, MEMORY_STATE: memory }) + prompt.skills;
  assert.deepEqual(refreshed.systemMessage, expected);
  assert.deepEqual(refreshed.miraPrompt, { ...prompt, values: { ...prompt.values, MEMORY_STATE: memory } });
  assert.deepEqual({ entries, system }, before);
  const committed = [...entries, checkpoint(entries, refreshed)];
  assert.equal(currentMemory(committed), memory);
  assert.deepEqual(currentPrompt(committed), refreshed.miraPrompt);
  assert.equal(currentMemory(decodeRecords(committed.map(encodeEntry))), memory);
});

test('latest checkpoint snapshot survives another refresh and all raw metadata stays off provider view', () => {
  const { entries, system } = fixture('initial');
  const first = refreshMiraMemory(system, entries, 'first refresh');
  const once = [...entries, checkpoint(entries, first)];
  const second = refreshMiraMemory(first.systemMessage, once, 'latest refresh');
  const nextCheckpoint = { ...checkpoint(once, second), id: 'second-checkpoint' };
  const committed = [...once, nextCheckpoint];
  assert.equal(currentMemory(committed), 'latest refresh');
  const projected = projectMiraPrompt(committed);
  assert.doesNotMatch(JSON.stringify(projected), /miraMemory|miraPrompt/);
  assert.equal(projected.filter(entry => {
    const message = entry.type === 'message' && entry.message.role === 'system' ? entry.message : entry.type === 'compaction' ? entry.systemMessage : undefined;
    return message?.sections?.[MIRA_PROMPT_SECTION] !== undefined;
  }).length, 1);
  assert.equal(currentMemory(committed), 'latest refresh');
  const copy = currentPrompt(committed)!;
  copy.values.MEMORY_STATE = 'caller mutation';
  assert.equal(currentPrompt(committed)!.values.MEMORY_STATE, 'latest refresh');
});

test('empty bootstrap can acquire Memory through checkpoint before first prompt rendering', () => {
  const boot = messageEntry({ role: 'system', content: '', timestamp: 0, miraMemory: '', miraMemoryConfigured: true } as never, null);
  const entries = [boot];
  const refreshed = refreshMiraMemory(undefined, entries, 'created later');
  assert.deepEqual(refreshed, { miraMemory: 'created later', miraMemoryConfigured: true });
  assert.equal(currentMemory([...entries, checkpoint(entries, refreshed)]), 'created later');
});

test('missing or forged checkpoint snapshot and frozen prompt changes fail closed', () => {
  const { entries, system } = fixture('initial');
  const refreshed = refreshMiraMemory(system, entries, 'fresh');
  assert.throws(() => currentMemory([...entries, checkpoint(entries, { systemMessage: system })]), /Missing checkpoint Memory snapshot/);
  const forged = structuredClone(refreshed);
  forged.miraPrompt!.values.CURRENT_AUTHORIZATION_CONTEXT = 'forged';
  forged.systemMessage!.sections![MIRA_PROMPT_SECTION] = renderMiraPrompt(forged.miraPrompt!.values) + forged.miraPrompt!.skills;
  assert.throws(() => currentMemory([...entries, checkpoint(entries, forged)]), /Checkpoint prompt state differs/);
  const changedIdentity = structuredClone(refreshed);
  changedIdentity.miraPrompt!.templateSha256 = '3e0e1ea9a70f134d158ce77c6e242c909aedb5a871b299d2065dac51aec2d7e0';
  assert.throws(() => currentMemory([...entries, checkpoint(entries, changedIdentity)]), /Checkpoint prompt state differs/);
  const badText = structuredClone(refreshed);
  badText.systemMessage!.sections![MIRA_PROMPT_SECTION] += 'forged suffix';
  assert.throws(() => encodeEntry(checkpoint(entries, badText)), /snapshot differs/);
  const badMemory = structuredClone(refreshed);
  badMemory.miraMemory = 'different';
  assert.throws(() => encodeEntry(checkpoint(entries, badMemory)), /does not use current Memory/);
  assert.throws(() => currentMemory([checkpoint(entries, refreshed)]), /Invalid checkpoint Memory snapshot/);
});

test('invalid renderer shape, metadata placement, and stale natural prompt snapshots fail closed', () => {
  const { entries, system, prompt } = fixture('initial');
  for (const miraPrompt of [null, [], {}, { values: prompt.values, skills: 4 }, { ...prompt, extra: true },
    { ...prompt, values: { ...prompt.values, SECRET: 'extra' } }]) {
    assert.throws(() => encodeEntry(messageEntry({ ...system, miraPrompt } as never, entries.at(-1)!.id)), /Invalid Mira prompt snapshot/);
  }
  assert.throws(() => encodeEntry(messageEntry({ role: 'user', content: 'hi', timestamp: 1, miraMemory: 'wrong place' } as never, null)), /metadata placement/);
  const nested = checkpoint(entries, { miraMemory: 'initial', miraMemoryConfigured: true, miraPrompt: prompt, systemMessage: { ...system, miraMemory: 'initial', miraMemoryConfigured: true } });
  assert.throws(() => encodeEntry(nested), /Invalid checkpoint system message/);
  const stale = { ...prompt, values: { ...prompt.values, MEMORY_STATE: 'stale' } };
  const rendered = messageEntry({ ...system, sections: { [MIRA_PROMPT_SECTION]: renderMiraPrompt(stale.values) + stale.skills }, miraPrompt: stale } as never, entries.at(-1)!.id);
  assert.throws(() => currentMemory([...entries, rendered]), /does not use current Memory/);
});

test('bootstrap and checkpoints record loader configuration and rejects absent, malformed, or misplaced markers', () => {
  const { entries, system } = fixture('initial');
  assert.equal(memoryConfigured(entries), true);
  assert.equal(memoryConfigured([]), undefined);
  const empty = messageEntry({ role: 'system', content: '', timestamp: 0, miraMemory: '', miraMemoryConfigured: false } as never, null);
  assert.equal(memoryConfigured([empty]), false);
  assert.equal(currentMemory([empty]), '');
  for (const flag of [undefined, null, 'true', 1, {}]) {
    assert.throws(() => encodeEntry(messageEntry({ role: 'system', content: '', timestamp: 0, miraMemory: '', miraMemoryConfigured: flag } as never, null)), /Invalid initial Memory snapshot/);
  }
  assert.throws(() => encodeEntry(messageEntry({ role: 'system', content: '', timestamp: 0, miraMemoryConfigured: true } as never, null)), /Invalid initial Memory snapshot/);
  assert.throws(() => encodeEntry(messageEntry({ role: 'system', content: '', timestamp: 0, miraMemory: 'nonempty', miraMemoryConfigured: false } as never, null)), /Invalid initial Memory snapshot/);
  const late = messageEntry({ role: 'system', content: '', timestamp: 1, miraMemory: '', miraMemoryConfigured: true } as never, entries.at(-1)!.id);
  assert.throws(() => currentMemory([...entries, late]), /Invalid initial Memory snapshot/);
  assert.throws(() => encodeEntry(checkpoint(entries, { ...refreshMiraMemory(system, entries, 'new'), miraMemoryConfigured: undefined })), /Invalid checkpoint Memory snapshot/);
  assert.throws(() => encodeEntry(messageEntry({ role: 'user', content: 'hi', timestamp: 0, miraMemoryConfigured: true } as never, null)), /metadata placement/);
  assert.doesNotMatch(JSON.stringify(projectMiraPrompt(entries)), /miraMemoryConfigured/);
});


test('source mode can become configured at a checkpoint but never silently downgrade', () => {
  const boot = messageEntry({ role: 'system', content: '', timestamp: 0, miraMemory: '', miraMemoryConfigured: false } as never, null);
  const entries = [boot];
  const adopted = refreshMiraMemory(undefined, entries, '', true);
  const committed = [...entries, checkpoint(entries, adopted)];
  assert.equal(memoryConfigured(committed), true);
  assert.equal(currentMemory(committed), '');
  assert.throws(() => refreshMiraMemory(undefined, committed, '', false), /Invalid checkpoint Memory snapshot/);
  const downgraded = { ...checkpoint(committed, { miraMemory: '', miraMemoryConfigured: false }), id: 'downgrade' };
  assert.throws(() => currentMemory([...committed, downgraded]), /Invalid checkpoint Memory snapshot/);
  assert.throws(() => refreshMiraMemory(undefined, entries, 'nonempty', false), /Invalid checkpoint Memory snapshot/);
  assert.deepEqual(refreshMiraMemory(undefined, committed, 'new Memory'), { miraMemory: 'new Memory', miraMemoryConfigured: true });
});
