import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type { PiRuntimeOptions } from '@mira/runtime-pi';
import { assistant, deferred, effectTool, input, MemoryWriter, model, result, runtime, seed, streamOf, toolCalls } from '../recovery/fixtures.mts';

const prompt = {
  memoryRoot: '/synthetic-memory', extensionsRoot: '/synthetic-extensions',
  environmentContext: 'Isolated synthetic automatic compaction test', authorizationContext: 'No external actions',
  now: () => new Date('2026-10-08T09:00:00Z'),
};
function systemText(context: Pick<TranscriptContext, 'messages'>): string {
  const system = getCurrentSystemMessage(context.messages);
  return system ? getSystemMessageText(system) : '';
}
const disabled = { enabled: false };
// Full-persona Memory fixtures exercise checkpoint integrity, not the 8K limit.
// Keep the shared small model and all explicit budget-rejection cases unchanged.
const memoryModel = { ...model, contextWindow: 16_384 };

async function preparedMemoryWriter() {
  const writer = new MemoryWriter();
  await runtime(writer, () => streamOf(assistant('Older response '.repeat(250))), {
    model: memoryModel, autoCompaction: disabled, miraPrompt: { ...prompt, loadMemory: async () => 'OLD_MEMORY' },
  }).run(input('Older question '.repeat(250)));
  await runtime(writer, () => streamOf(assistant('Recent answer')), { model: memoryModel, autoCompaction: disabled }).run(input('Recent question'));
  return writer;
}

test('manual compaction refreshes an initially empty Memory file atomically and ordinary restart freezes the refresh', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-compaction-memory-'));
  try {
    const file = path.join(directory, 'MEMORY.md'); await writeFile(file, '');
    let loads = 0;
    const miraPrompt = { ...prompt, memoryRoot: directory, loadMemory: async () => { loads++; return readFile(file, 'utf8'); } };
    const writer = new MemoryWriter();
    await runtime(writer, () => streamOf(assistant('Older response '.repeat(250))), { model: memoryModel, autoCompaction: disabled, miraPrompt }).run(input('Older question '.repeat(250)));
    await writeFile(file, 'NEW_MEMORY_AFTER_EMPTY');
    await runtime(writer, (_model, context) => {
      assert.doesNotMatch(systemText(context), /NEW_MEMORY_AFTER_EMPTY/);
      return streamOf(assistant('Recent response'));
    }, { model: memoryModel, autoCompaction: disabled, miraPrompt }).run(input('Recent question'));
    assert.equal(loads, 1);
    const before = await writer.load();
    // The full persona plus the dedicated summary instructions exceed this fixture's 8k model.
    const compacted = await runtime(writer, () => streamOf(assistant('Synthetic summary')), { model: largeModel, autoCompaction: disabled, miraPrompt }).compact({ keepRecentTokens: 1 });
    assert.equal(loads, 2);
    assert.equal(compacted.snapshot.version, before.version + 1, 'Memory refresh and checkpoint share one atomic append');
    assert.deepEqual(compacted.snapshot.records.slice(0, before.records.length), before.records);
    assert.match(systemText({ messages: convertToLlm(compacted.messages) }), /NEW_MEMORY_AFTER_EMPTY/);
    await writeFile(file, 'LATER_DISK_CHANGE');
    await runtime(writer, (_model, context) => {
      assert.match(systemText(context), /NEW_MEMORY_AFTER_EMPTY/);
      assert.doesNotMatch(systemText(context), /LATER_DISK_CHANGE/);
      return streamOf(assistant());
    }, { autoCompaction: disabled, miraPrompt }).run(input('Ordinary restart'));
    assert.equal(loads, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const fault of ['summary', 'memory', 'cancel', 'cas'] as const) {
  test(`compaction ${fault} failure cannot publish refreshed Memory or a checkpoint`, async () => {
    const writer = await preparedMemoryWriter(); const before = await writer.load();
    const entered = deferred(), release = deferred(); const controller = new AbortController();
    let memoryLoads = 0, summaries = 0;
    const instance = runtime(writer, async () => {
      summaries++;
      if (fault === 'summary') return streamOf({ ...assistant('partial'), stopReason: 'length' });
      entered.resolve(); await release.promise; return streamOf(assistant('Candidate summary'));
    }, { model: largeModel, autoCompaction: disabled, miraPrompt: { ...prompt, loadMemory: async () => {
      memoryLoads++; if (fault === 'memory') throw Error('synthetic Memory read failure'); return 'UNPUBLISHED_MEMORY';
    } } });
    const work = instance.compact({ keepRecentTokens: 1, signal: controller.signal });
    if (fault === 'cancel' || fault === 'cas') {
      await entered.promise;
      if (fault === 'cancel') controller.abort(Error('cancel synthetic compaction'));
      else await seed(writer, [input('Concurrent accepted input')]);
    }
    release.resolve();
    await assert.rejects(work);
    assert.equal(memoryLoads, 1, 'one frozen Memory candidate is read before summary generation');
    assert.equal(summaries, fault === 'memory' ? 0 : 1);
    const after = await writer.load();
    assert.deepEqual(after.records.slice(0, before.records.length), before.records);
    assert.equal(after.records.length, before.records.length + (fault === 'cas' ? 1 : 0));
    assert.doesNotMatch(JSON.stringify(after), /UNPUBLISHED_MEMORY|Candidate summary/);
    const recovered = await runtime(writer, undefined, { autoCompaction: disabled }).recover();
    assert.match(systemText({ messages: convertToLlm(recovered.messages) }), /OLD_MEMORY/);
  });
}

function isSummary(context: TranscriptContext): boolean {
  return systemText(context).startsWith('你负责压缩 Mira 的 Working Context');
}
const largeModel = { ...model, contextWindow: 65536 };
const automatic: NonNullable<PiRuntimeOptions['autoCompaction']> = { enabled: true, threshold: 0.3, reserveTokens: 512, keepRecentTokens: 1 };

// The last assistant's usage is deliberately conservative. The large fresh user
// input additionally exercises growth after the most recent provider accounting.
async function seedLargeHistory(writer: MemoryWriter) {
  await seed(writer, [input('Older question '.repeat(4000)), assistant('Earlier answer '.repeat(4000)), input('Retained latest question'), assistant('Retained latest answer')]);
}

test('run automatically compacts before a real request and keeps raw history immutable', async () => {
  const writer = new MemoryWriter(); await seedLargeHistory(writer); const before = await writer.load();
  let summaries = 0, requests = 0;
  const state = await runtime(writer, (_model, context, options) => {
    if (isSummary(context)) { summaries++; return streamOf(assistant('Synthetic automatic checkpoint')); }
    requests++;
    assert.ok((options?.maxTokens ?? Infinity) <= 512, 'request output cannot exceed its reserved budget');
    assert.match(JSON.stringify(context.messages), /Synthetic automatic checkpoint/);
    assert.match(JSON.stringify(context.messages), /New natural input/);
    return streamOf(assistant('Final natural answer'));
  }, { autoCompaction: automatic, model: largeModel }).run(input('New natural input'));
  assert.ok(summaries >= 1); assert.equal(requests, 1);
  assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 1);
  assert.deepEqual(state.snapshot.records.slice(0, before.records.length), before.records);
});

test('disabled automatic compaction refuses an impossible request without calling a summarizer', async () => {
  const writer = new MemoryWriter(); await seedLargeHistory(writer); let requests = 0;
  await assert.rejects(runtime(writer, () => {
    requests++; return streamOf(assistant());
  }, { autoCompaction: disabled }).run(input('No automatic compaction requested')), /budget|context|window/i);
  assert.equal(requests, 0);
  assert.equal((await runtime(writer).recover()).entries.filter(entry => entry.type === 'compaction').length, 0);
});

test('automatic compaction after a settled tool batch preserves exact paired tail and never repeats the effect', async () => {
  const writer = new MemoryWriter();
  await seed(writer, [input('Older question '.repeat(100)), assistant('Earlier answer '.repeat(100))]);
  let effects = 0, requests = 0, summaries = 0;
  const state = await runtime(writer, (_model, context) => {
    if (isSummary(context)) {
      assert.equal(effects, 1, 'summary starts only after the effect and durable result have settled');
      const outcome = writer.state.executions.find(execution => execution.intent.callId === 'large-result')?.outcome;
      assert.ok(outcome);
      summaries++;
      return streamOf(assistant('Older question and answer summary'));
    }
    requests++;
    if (requests === 1) return streamOf(toolCalls('large-result'));
    const call = context.messages.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall' && block.id === 'large-result'));
    const toolResult = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'large-result');
    assert.ok(call); assert.ok(toolResult);
    return streamOf(assistant('Tool continuation finished'));
  }, {
    autoCompaction: { ...automatic, threshold: 0.3 },
    tools: [effectTool(async () => { effects++; return { ...result, content: [{ type: 'text', text: 'large result '.repeat(700) }] }; })],
  }).run(input('Perform the synthetic effect'));
  assert.equal(effects, 1); assert.equal(requests, 2); assert.ok(summaries >= 1);
  assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 1);
  assert.equal(state.snapshot.executions.length, 1);
});

for (const fault of ['summary', 'cancel', 'cas'] as const) {
  test(`automatic compaction ${fault} failure stops the pending natural request without a checkpoint`, async () => {
    const writer = new MemoryWriter(); await seedLargeHistory(writer);
    const entered = deferred(), release = deferred(); const controller = new AbortController();
    let naturalRequests = 0;
    const work = runtime(writer, async (_model, context) => {
      if (!isSummary(context)) { naturalRequests++; return streamOf(assistant('Must not be requested')); }
      entered.resolve(); await release.promise;
      return streamOf(fault === 'summary' ? { ...assistant('Incomplete candidate'), stopReason: 'length' } : assistant('Unpublished automatic candidate'));
    }, { autoCompaction: automatic, model: largeModel }).run(input('Input accepted before automatic compaction'), controller.signal);
    await entered.promise;
    if (fault === 'cas') await seed(writer, [input('Newer durable input')]);
    const authoritative = await writer.load();
    if (fault === 'cancel') controller.abort(Error('cancel automatic compaction'));
    release.resolve(); await assert.rejects(work);
    assert.equal(naturalRequests, 0);
    assert.deepEqual(await writer.load(), authoritative);
    const recovered = await runtime(writer).recover();
    assert.equal(recovered.entries.filter(entry => entry.type === 'compaction').length, 0);
    assert.match(JSON.stringify(recovered.messages), /Input accepted before automatic compaction/);
  });
}

test('fresh Memory that exceeds the input budget is never partially committed by automatic compaction', async () => {
  const writer = new MemoryWriter();
  let memoryLoads = 0;
  const miraPrompt = { ...prompt, loadMemory: async () => { memoryLoads++; return memoryLoads === 1 ? 'INITIAL_MEMORY' : 'OVERSIZED_FRESH_MEMORY '.repeat(20000); } };
  await runtime(writer, () => streamOf(assistant('Older answer '.repeat(4000))), { model: largeModel, autoCompaction: disabled, miraPrompt }).run(input('Older question '.repeat(4000)));
  await runtime(writer, () => streamOf(assistant('Recent answer')), { model: largeModel, autoCompaction: disabled, miraPrompt }).run(input('Recent question'));
  const prefix = await writer.load(); let naturalRequests = 0;
  await assert.rejects(runtime(writer, (_model, context) => {
    if (isSummary(context)) return streamOf(assistant('Unused candidate summary'));
    naturalRequests++; return streamOf(assistant());
  }, { model: largeModel, autoCompaction: automatic, miraPrompt }).run(input('Trigger automatic compaction')), /budget/i);
  assert.equal(naturalRequests, 0); assert.equal(memoryLoads, 2);
  const recovered = await runtime(writer).recover();
  assert.deepEqual(recovered.snapshot.records.slice(0, prefix.records.length), prefix.records);
  assert.equal(recovered.entries.filter(entry => entry.type === 'compaction').length, 0);
  assert.doesNotMatch(JSON.stringify(recovered.snapshot), /OVERSIZED_FRESH_MEMORY/);
  assert.match(systemText({ messages: convertToLlm(recovered.messages) }), /INITIAL_MEMORY/);
});

test('default automatic compaction leaves a small ordinary request unmodified and makes no extra model call', async () => {
  const writer = new MemoryWriter(); let requests = 0;
  const state = await runtime(writer, (_model, context, options) => {
    requests++; assert.equal(isSummary(context), false);
    assert.match(JSON.stringify(context.messages), /Short ordinary question/);
    assert.ok((options?.maxTokens ?? Infinity) <= model.maxTokens);
    return streamOf(assistant('Short ordinary answer'));
  }).run(input('Short ordinary question'));
  assert.equal(requests, 1); assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 0);
});

for (const repeated of [false, true]) {
  test(`provider context overflow ${repeated ? 'is bounded after one recovery attempt' : 'recovers with one compaction and resumes'} without replaying a settled effect`, async () => {
    const writer = new MemoryWriter();
    await seed(writer, [input('Older question '.repeat(150)), assistant('Earlier answer '.repeat(150))]);
    let effects = 0, requests = 0, summaries = 0;
    const work = runtime(writer, (_model, context) => {
      if (isSummary(context)) { summaries++; return streamOf(assistant('Overflow recovery summary')); }
      requests++;
      if (requests === 1) return streamOf(toolCalls('before-overflow'));
      if (requests === 2 || repeated) return streamOf({ ...assistant(''), stopReason: 'error', errorMessage: 'maximum context length exceeded' });
      assert.match(JSON.stringify(context.messages), /Overflow recovery summary/);
      const results = context.messages.filter(message => message.role === 'toolResult' && message.toolCallId === 'before-overflow');
      assert.equal(results.length, 1);
      return streamOf(assistant('Reply after context overflow recovery'));
    }, { autoCompaction: { threshold: 1, keepRecentTokens: 1 }, tools: [effectTool(async () => { effects++; return result; })] }).run(input('Unique overflow request'));
    if (repeated) await assert.rejects(work, /overflow/i); else await work;
    assert.equal(effects, 1); assert.equal(requests, 3); assert.ok(summaries >= 1);
    const recovered = await runtime(writer).recover();
    assert.equal(recovered.entries.filter(entry => entry.type === 'compaction').length, 1);
    assert.equal(recovered.snapshot.executions.length, 1);
    assert.equal(recovered.entries.filter(entry => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'Unique overflow request').length, 1);
    assert.doesNotMatch(JSON.stringify(recovered.snapshot), /maximum context length exceeded/);
  });
}

test('a long conversation automatically compacts more than once across real sequential run calls', async () => {
  const writer = new MemoryWriter(); let requests = 0, summaries = 0;
  for (let turn = 0; turn < 20; turn++) {
    const prefix = (await writer.load()).records;
    const state = await runtime(writer, (_model, context) => {
      if (isSummary(context)) { summaries++; return streamOf(assistant(`Synthetic conversation checkpoint ${summaries}`)); }
      requests++;
      assert.match(JSON.stringify(context.messages), new RegExp(`Natural question number ${turn}\\b`));
      return streamOf(assistant(`Natural answer number ${turn}. ${'Recent answer detail '.repeat(100)}`));
    }).run(input(`Natural question number ${turn}. ${'Question context detail '.repeat(100)}`));
    assert.deepEqual(state.snapshot.records.slice(0, prefix.length), prefix);
    assert.equal(state.messages.at(-1)?.role, 'assistant');
  }
  assert.equal(requests, 20); assert.ok(summaries >= 2);
  const recovered = await runtime(writer).recover();
  assert.ok(recovered.entries.filter(entry => entry.type === 'compaction').length >= 2);
  assert.equal(recovered.entries.filter(entry => entry.type === 'message' && entry.message.role === 'user').length, 20);
});

test('a non-reducing automatic checkpoint is rejected once without publishing or requesting a natural response', async () => {
  const writer = new MemoryWriter();
  await seed(writer, [input('Older question '.repeat(100)), assistant('Earlier answer '.repeat(100)), input('Recent question'), assistant('Recent answer')]);
  let summaries = 0, requests = 0;
  await assert.rejects(runtime(writer, (_model, context) => {
    if (isSummary(context)) { summaries++; return streamOf(assistant('Non-reducing summary '.repeat(1000))); }
    requests++; return streamOf(assistant());
  }, { autoCompaction: { ...automatic, threshold: 0.05 } }).run(input('Request after a non-reducing summary')), /reduce/i);
  assert.equal(summaries, 1, 'one Mira summary request, including a split-turn prefix, without repeated attempts');
  assert.equal(requests, 0);
  assert.equal((await runtime(writer).recover()).entries.filter(entry => entry.type === 'compaction').length, 0);
});

test('an oversized SDK summarization request is rejected before calling the injected stream', async () => {
  const writer = new MemoryWriter(); await seedLargeHistory(writer); const before = await writer.load(); let calls = 0;
  await assert.rejects(runtime(writer, () => { calls++; return streamOf(assistant()); }).compact({ keepRecentTokens: 1 }), /budget|context|window/i);
  assert.equal(calls, 0); assert.deepEqual(await writer.load(), before);
});

test('invalid automatic compaction settings fail before any persistence or provider request', () => {
  const invalid: NonNullable<PiRuntimeOptions['autoCompaction']>[] = [
    { threshold: NaN }, { threshold: Infinity }, { threshold: 0 }, { threshold: -1 }, { threshold: 1.01 },
    { reserveTokens: NaN }, { reserveTokens: Infinity }, { reserveTokens: 0 }, { reserveTokens: model.maxTokens + 1 }, { reserveTokens: 1.5 },
    { keepRecentTokens: NaN }, { keepRecentTokens: Infinity }, { keepRecentTokens: 0 }, { keepRecentTokens: model.contextWindow }, { keepRecentTokens: 1.5 },
  ];
  const writer = new MemoryWriter(); let calls = 0;
  for (const autoCompaction of invalid) assert.throws(() => runtime(writer, () => { calls++; return streamOf(assistant()); }, { autoCompaction }), /budget/i);
  assert.equal(calls, 0); assert.equal(writer.state.version, 0);
});

test('compacting a durable Memory context requires its configured Memory loader rather than silently freezing old Memory', async () => {
  const writer = await preparedMemoryWriter(); const before = await writer.load();
  await assert.rejects(runtime(writer, () => streamOf(assistant('Candidate without Memory configuration')), { autoCompaction: disabled }).compact({ keepRecentTokens: 1 }), /Memory|configuration|configured/i);
  assert.deepEqual(await writer.load(), before);
});

for (const initial of ['', 'COMMITTED_MEMORY']) test(`a missing loader cannot erase a configured ${initial ? 'nonempty' : 'initially empty'} Memory snapshot`, async () => {
  const writer = new MemoryWriter();
  const miraPrompt = { ...prompt, loadMemory: async () => initial };
  await runtime(writer, () => streamOf(assistant('Earlier response '.repeat(150))), { autoCompaction: disabled, miraPrompt }).run(input('Earlier question '.repeat(150)));
  await runtime(writer, () => streamOf(assistant('Recent response')), { autoCompaction: disabled, miraPrompt }).run(input('Recent question'));
  const before = await writer.load(); let calls = 0;
  await assert.rejects(runtime(writer, () => { calls++; return streamOf(assistant('Must not summarize')); }, { autoCompaction: disabled, miraPrompt: prompt }).compact({ keepRecentTokens: 1 }), /configured Memory loader/i);
  assert.equal(calls, 0);
  assert.deepEqual(await writer.load(), before);
});

for (const invalid of [undefined, null, 42]) test(`an invalid Memory loader result ${String(invalid)} cannot clear the committed snapshot`, async () => {
  const writer = await preparedMemoryWriter(); const before = await writer.load(); let calls = 0;
  await assert.rejects(runtime(writer, () => { calls++; return streamOf(assistant('Unpublished summary')); }, {
    autoCompaction: disabled, miraPrompt: { ...prompt, loadMemory: async () => invalid as unknown as string },
  }).compact({ keepRecentTokens: 1 }), /Memory snapshot/i);
  assert.equal(calls, 0, 'invalid Memory must fail before summary generation');
  assert.deepEqual(await writer.load(), before);
});

test('a one-token output reserve stays positive for every SDK summary request', async () => {
  const writer = new MemoryWriter();
  await seed(writer, [input('Older question '.repeat(100)), assistant('Earlier answer '.repeat(100)), input('Recent question'), assistant('Recent answer')]);
  const limits: number[] = [];
  await runtime(writer, (_model, _context, options) => {
    assert.equal(options?.maxTokens, 1); limits.push(options.maxTokens);
    return streamOf(assistant('Summary'));
  }, { autoCompaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 } }).compact();
  assert.ok(limits.length >= 1);
});
