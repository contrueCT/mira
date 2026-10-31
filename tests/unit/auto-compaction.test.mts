import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import { convertToLlm } from '@earendil-works/pi-coding-agent';
import type { PiRuntimeOptions } from '@mira/runtime-pi';
import { contextPressure, cjkCharacters, estimateRequestTokens } from '../../packages/runtime-pi/src/budget.ts';
import { compactionReductions } from '../../packages/runtime-pi/src/compaction-fit.ts';
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

function summaryInput(context: TranscriptContext): Record<string, any> {
  const user = context.messages.find(message => message.role === 'user');
  return JSON.parse(typeof user?.content === 'string' ? user.content : '');
}
test('an oversized SDK summarization request is reduced to fit before calling the injected stream and declares what was omitted', async () => {
  const writer = new MemoryWriter(); await seedLargeHistory(writer); let calls = 0; let request: Record<string, any> | undefined;
  const state = await runtime(writer, (_model, context, options) => {
    calls++; request = summaryInput(context);
    // Regression: this request used to be rejected outright before any dispatch.
    assert.ok(estimateRequestTokens(context.messages) + options!.maxTokens! <= model.contextWindow);
    return streamOf(assistant('Reduced checkpoint'));
  }).compact({ keepRecentTokens: 1 });
  assert.equal(calls, 1);
  assert.match(JSON.stringify(request!.input_reductions.steps), /oldest_source_messages_omitted/);
  assert.match(request!.input_reductions.notice, /do not invent/);
  // The boundary still names every summarized History ID, including omitted ones.
  assert.ok(request!.boundary.source_history_ids.length > request!.source_messages.length);
  assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 1);
});

test('a provider overflow of the summary request retries once with a smaller bounded request', async () => {
  const writer = new MemoryWriter(); await seedLargeHistory(writer); const sizes: number[] = [];
  const roomy = { ...model, contextWindow: 65_536 };
  const state = await runtime(writer, (_model, context) => {
    sizes.push(JSON.stringify(context.messages).length);
    if (sizes.length === 1) return streamOf({ ...assistant(''), content: [], stopReason: 'error', errorMessage: 'prompt is too long: 70000 tokens > 65536 maximum' });
    assert.ok(summaryInput(context).input_reductions, 'the retry declares its reductions');
    return streamOf(assistant('Checkpoint after overflow retry'));
  }, { model: roomy }).compact({ keepRecentTokens: 1 });
  assert.equal(sizes.length, 2); assert.ok(sizes[1]! < sizes[0]!);
  assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 1);
});

test('repeated summary overflows stop after three bounded attempts without publishing a checkpoint', async () => {
  const writer = new MemoryWriter(); await seedLargeHistory(writer); const before = await writer.load(); let calls = 0;
  await assert.rejects(runtime(writer, () => { calls++; return streamOf({ ...assistant(''), content: [], stopReason: 'error', errorMessage: 'Your input exceeds the context window of this model' }); }, { model: { ...model, contextWindow: 65_536 } }).compact({ keepRecentTokens: 1 }),
    /overflowed the provider context after bounded reductions/);
  assert.equal(calls, 3); assert.deepEqual(await writer.load(), before);
});

test('compaction reductions bound the retained tail, then trim old tool results head+tail, then drop the oldest sources', () => {
  const big = (label: string) => `${label}-HEAD ${'x'.repeat(20_000)} ${label}-TAIL`;
  const input = { mode: 'initial', source_messages: [
    { history_id: 'a', role: 'user', content: 'oldest question' },
    { history_id: 'b', role: 'toolResult', content: [{ type: 'text', text: big('tool') }] },
    { history_id: 'c', role: 'assistant', content: [{ type: 'text', text: 'newest source answer' }] },
  ], retained_tail: { purpose: 'reference_only_not_summarized', messages: Array.from({ length: 30 }, (_, index) => ({ history_id: `t${index}`, role: 'user', content: big(`tail${index}`) })) } };
  const steps = [...compactionReductions(input as never, 40_000)];
  assert.deepEqual(steps[0]!.input, input, 'the first candidate is unchanged');
  const tail = steps[1]!.input.retained_tail;
  assert.deepEqual(steps[1]!.reductions, ['retained_tail_excerpted']);
  assert.equal(tail['excerpted'], true); assert.ok(Number(tail['omitted_older_messages']) > 0);
  assert.equal(tail.messages.at(-1)!['history_id'], 't29', 'the newest tail message survives');
  assert.ok(JSON.stringify(tail.messages).length <= 8_000);
  const trimmed = steps.find(step => step.reductions.some(item => item.startsWith('tool_results_trimmed_to_2000')))!;
  const tool = JSON.stringify(trimmed.input.source_messages[1]);
  assert.match(tool, /tool-HEAD/); assert.match(tool, /tool-TAIL/); assert.match(tool, /omitted for compaction/);
  const last = steps.at(-1)!;
  assert.deepEqual(last.input.source_messages.map(message => message['history_id']), ['c']);
  assert.match(last.reductions.at(-1)!, /oldest_source_messages_omitted:2/);
  for (let index = 1; index < steps.length; index++) assert.ok(JSON.stringify(steps[index]!.input).length < JSON.stringify(steps[index - 1]!.input).length + 400);
});

test('context pressure anchors on provider usage and estimates only what was added since, with a CJK-aware floor', () => {
  const usage = (input: number, output: number) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
  const chinese = '这是一个用于验证上下文估算的中文句子。'.repeat(200);
  const first = { role: 'user' as const, content: chinese, timestamp: 1 };
  // chars/4 alone would count this 4,000-character CJK text as ~1,000 tokens.
  assert.ok(estimateRequestTokens([first]) >= cjkCharacters(chinese), 'CJK characters count at least one token each');
  const answered = { ...assistant('好的'), usage: usage(6_000, 20) };
  const added = { role: 'user' as const, content: 'follow-up '.repeat(100), timestamp: 2 };
  const pressure = contextPressure([first, answered, added], [], model);
  assert.equal(pressure.anchorIndex, 1);
  assert.ok(pressure.anchoredTokens! >= 6_020 + Math.floor(1_000 / 4), 'usage plus estimated growth');
  assert.ok(pressure.anchoredTokens! < 6_020 + 400);
  assert.equal(pressure.tokens, Math.max(pressure.estimatedTokens, pressure.anchoredTokens!));
  // Errors, another model and anything before a compaction summary are not anchors.
  assert.equal(contextPressure([first, { ...answered, stopReason: 'error' as const }], [], model).anchoredTokens, null);
  assert.equal(contextPressure([first, { ...answered, model: 'another-model' }], [], model).anchoredTokens, null);
  assert.equal(contextPressure([first, answered, { role: 'compactionSummary', summary: 's', tokensBefore: 1, timestamp: 3 } as never], [], model).anchoredTokens, null);
  // Underreported usage never lowers pressure below the heuristic.
  const low = contextPressure([first, { ...answered, usage: usage(1, 1) }], [], model);
  assert.equal(low.tokens, low.estimatedTokens);
});

test('provider usage alone triggers automatic compaction even when chars/4 says the context is small', async () => {
  const writer = new MemoryWriter();
  const usage = { input: 7_000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 7_010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await seed(writer, [input('中文历史问题。'.repeat(150)), { ...assistant('中文回答。'.repeat(150)), usage }, input('Retained question'), { ...assistant('Retained answer'), usage }]);
  let summaries = 0;
  await runtime(writer, (_model, context) => {
    if (isSummary(context)) { summaries++; return streamOf(assistant('Usage-triggered checkpoint')); }
    return streamOf(assistant('Answered after compaction'));
  }, { autoCompaction: { enabled: true, threshold: 0.8, reserveTokens: 512, keepRecentTokens: 1 } }).run(input('Next'));
  assert.equal(summaries, 1, 'reported 7,010 of 7,680 input tokens crosses the 80% threshold');
});

test('8K Mira requests count a prepared prompt once across time updates and runtime restart', async () => {
  const writer = new MemoryWriter(); let calls = 0; let tick = 0; let memoryLoads = 0;
  const miraPrompt = { ...prompt, now: () => new Date(1_000 + tick++), loadMemory: async () => { memoryLoads++; return 'Frozen Memory'; } };
  const selected = { ...model, contextWindow: 8_192 };
  const stream: PiRuntimeOptions['streamFn'] = (_model, context) => {
    calls++;
    const measured = estimateRequestTokens(context.messages, [], selected);
    assert.ok(measured < 6_500, `short requests fit the 8K model, got ${measured}`);
    return streamOf({ ...assistant('hello'), usage: { input: measured, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: measured + 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  };
  const instance = runtime(writer, stream, { model: selected, miraPrompt });
  await instance.run(input('one'));
  await instance.run(input('two'));
  await runtime(writer, stream, { model: selected, miraPrompt }).run(input('three after restart'));
  assert.equal(calls, 3); assert.equal(memoryLoads, 1, 'request budget recovery keeps the frozen Memory snapshot');
});

test('usage source mapping survives an omitted recovered tool-only assistant without replay', async () => {
  const writer = new MemoryWriter(); let calls = 0; let effects = 0; let tick = 0;
  const miraPrompt = { ...prompt, now: () => new Date(1_000 + tick++) };
  const tools = [effectTool(async () => { effects++; throw Error('Synthetic receipt lost'); })];
  const stream: PiRuntimeOptions['streamFn'] = (_model, context) => {
    calls++;
    assert.ok(context.messages.every(message => message.role !== 'assistant' || message.content.length > 0));
    if (calls === 1) return streamOf(toolCalls('unknown-budget-effect'));
    const measured = estimateRequestTokens(context.messages, tools, model);
    return streamOf({ ...assistant('Unknown effect acknowledged'), usage: { input: measured, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: measured + 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  };
  await runtime(writer, stream, { miraPrompt, tools }).run(input('Do the synthetic operation'));
  const state = await runtime(writer, stream, { miraPrompt, tools }).run(input('Follow up after the unknown effect'));
  assert.equal(calls, 3); assert.equal(effects, 1); assert.equal(state.recovery.operations.length, 1);
});

for (const change of ['environment', 'tools'] as const) test(`provider anchor still accounts for genuine ${change} system growth after prompt replacement`, async () => {
  const writer = new MemoryWriter(); let calls = 0; let tick = 0; let grown = false;
  const miraPrompt = { ...prompt, now: () => new Date(1_000 + tick++) };
  const selected = { ...model, contextWindow: 16_384 };
  const registry = () => grown && change === 'tools' ? [{ ...effectTool(async () => result), description: 'Added tool metadata '.repeat(500) }] : [];
  const stream: PiRuntimeOptions['streamFn'] = () => {
    calls++;
    return streamOf({ ...assistant('hello'), usage: { input: 13_000, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 13_002,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  };
  await runtime(writer, stream, { model: selected, miraPrompt, prepareTools: async () => registry(), autoCompaction: disabled }).run(input('one'));
  grown = true;
  if (change === 'environment') miraPrompt.environmentContext += 'Added environment context '.repeat(500);
  await assert.rejects(runtime(writer, stream, { model: selected, miraPrompt, prepareTools: async () => registry(), autoCompaction: disabled }).run(input('two')), /input budget/);
  assert.equal(calls, 1, 'real growth is checked before dispatch even when the full-request heuristic alone fits');
});

test('retained pre-checkpoint usage cannot anchor the compacted request with refreshed Memory', async () => {
  const writer = new MemoryWriter(); let memory = 'OLD_MEMORY';
  const miraPrompt = { ...prompt, loadMemory: async () => memory };
  const highUsage = { input: 30_000, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 30_002,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  await runtime(writer, () => streamOf({ ...assistant('Kept answer'), usage: highUsage }), { model: largeModel, miraPrompt, autoCompaction: disabled }).run(input('Kept question'));
  memory = 'NEW_MEMORY '.repeat(100);
  await runtime(writer, () => streamOf(assistant('Checkpoint summary')), { model: largeModel, miraPrompt, autoCompaction: disabled }).compact({ keepRecentTokens: 100 });
  let calls = 0;
  await runtime(writer, (_model, context) => {
    calls++; assert.match(systemText(context), /NEW_MEMORY/);
    return streamOf({ ...assistant('After checkpoint'), usage: { ...highUsage, input: 13_000, totalTokens: 13_002 } });
  }, { model: memoryModel, miraPrompt, autoCompaction: disabled }).run(input('Continue after compaction'));
  assert.equal(calls, 1, 'discard old provider usage rather than reject a request that fits after compaction');
  miraPrompt.environmentContext += 'Post-checkpoint environment growth '.repeat(400);
  await assert.rejects(runtime(writer, () => { calls++; return streamOf(assistant()); }, { model: memoryModel, miraPrompt, autoCompaction: disabled }).run(input('New request')), /input budget/);
  assert.equal(calls, 1, 'a response after the checkpoint becomes a valid anchor and still enforces subsequent growth');
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
  await runtime(writer, () => streamOf(assistant('Earlier response '.repeat(120))), { autoCompaction: disabled, miraPrompt }).run(input('Earlier question '.repeat(120)));
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
