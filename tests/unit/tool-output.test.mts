import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaceTools, extensionTools } from '@mira/server';
import { type ToolResultMessage } from '@earendil-works/pi-ai';
import { createHistoryTools } from '@mira/runtime-pi';
import { FixtureHistoryReader, fixtureMiraId, fixtureHistoryIds } from '../../scripts/tool-usability-fixtures.mts';
import type { HistoryTextPage } from '@mira/life';
import { TOOL_OUTPUT_TEXT_BYTES } from '../../packages/runtime-pi/src/tool-output.ts';
import { assistant, effectTool, input, model, runtime, scripted, seed, streamOf, toolCalls, MemoryWriter } from '../recovery/fixtures.mts';
import { fullOutput, largeToolText, outputPath, outputSpool } from '../recovery/tool-output-fixtures.mts';

const textBytes = (message: ToolResultMessage) => message.content.reduce((n, block) => n + (block.type === 'text' ? Buffer.byteLength(block.text) : 0), 0);
const largeModel = { ...model, contextWindow: 200_000 };

test('actual extension result.text is bounded before the next model request; original file pages remain readable after recovery', async () => {
  const root = await mkdtemp('/tmp/mira-tool-output-');
  try {
    const writer = new MemoryWriter(); let calls = 0, effects = 0; let savedPath = '';
    const tools = [...createWorkspaceTools(root), ...extensionTools([{ extensionId: 'large', activation: 'test', tool: {
      name: 'effect', description: 'Return synthetic large text', parameters: { type: 'object', properties: {} },
      execute: async () => { effects++; return { text: largeToolText, details: { receipt: 'original' } }; },
    } }])];
    const writeOverflowInput = outputSpool(path.join(root, 'spool'));
    const recovered = await runtime(writer, async (_model, context) => {
      calls++;
      if (calls === 1) return streamOf(toolCalls('extension-large'));
      const output = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'extension-large');
      assert.ok(output?.role === 'toolResult');
      assert.ok(textBytes(output) <= TOOL_OUTPUT_TEXT_BYTES);
      assert.ok(!JSON.stringify(output.content).includes('FULL_ORIGINAL_TAIL'));
      const full = await fullOutput(output);
      assert.equal(full.content[0]?.type === 'text' && full.content[0].text, largeToolText);
      assert.deepEqual(writer.state.executions[0]?.outcome?.payload, full);
      savedPath = outputPath(output);
      if (calls === 2) return streamOf({ ...toolCalls('read-original-page'), content: [{ type: 'toolCall', id: 'read-original-page', name: 'read', arguments: { path: savedPath, offset: 2, limit: 2 } }] });
      assert.equal(calls, 3);
      const page = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'read-original-page');
      assert.ok(page?.role === 'toolResult'); assert.match(JSON.stringify(page.content), /single-line/);
      assert.ok(textBytes(page) <= TOOL_OUTPUT_TEXT_BYTES);
      return streamOf(assistant('Read an explicit original page, remaining text is not yet reviewed.'));
    }, { model: largeModel, tools, writeOverflowInput }).run(input());
    assert.equal(effects, 1);
    const before = structuredClone(writer.state), originalFile = await readFile(savedPath, 'utf8');
    await rm(savedPath);
    const fresh = await runtime(writer, undefined, { model: largeModel, tools, writeOverflowInput }).recover();
    assert.equal(await readFile(savedPath, 'utf8'), originalFile);
    assert.deepEqual(fresh.messages, recovered.messages); assert.deepEqual(writer.state, before);
    assert.equal(effects, 1, 'rebuilding disposable evidence never repeats the extension');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all result fields, images, multiple text blocks and known error status survive the real durable boundary', async () => {
  const root = await mkdtemp('/tmp/mira-tool-output-metadata-');
  try {
    const writer = new MemoryWriter();
    const returned = { content: [{ type: 'text' as const, text: largeToolText, textSignature: 'opaque' }, { type: 'image' as const, data: 'synthetic-image', mimeType: 'image/png' }, { type: 'text' as const, text: 'SECOND_BLOCK_END' }],
      details: { nested: ['unchanged'] }, structuredContent: { exact: 42 }, opaque: { other: true }, usage: assistant().usage, terminate: false, isError: true };
    const state = await runtime(writer, scripted([toolCalls('all-fields'), assistant()]), { model: largeModel,
      tools: [effectTool(async () => returned)], writeOverflowInput: outputSpool(path.join(root, 'spool')) }).run(input());
    const output = state.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
    const full = await fullOutput(output);
    for (const [key, value] of Object.entries(returned)) assert.deepEqual((full as unknown as Record<string, unknown>)[key], value);
    assert.deepEqual(output.content[1], returned.content[1]); assert.equal(output.isError, true);
    assert.ok(textBytes(output) <= TOOL_OUTPUT_TEXT_BYTES);
    assert.deepEqual(state.snapshot.executions[0]?.outcome?.payload, full);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of ['missing-writer', 'writer-failed', 'wrong-bytes']) test(`spool ${failure} stops after saving the known result; retry never replays the effect`, async () => {
  const root = await mkdtemp('/tmp/mira-tool-output-failure-');
  try {
    const writer = new MemoryWriter(); let effects = 0, requests = 0;
    const tools = [effectTool(async () => { effects++; return { content: [{ type: 'text' as const, text: largeToolText }], details: {} }; })];
    const writeOverflowInput = failure === 'missing-writer' ? undefined : failure === 'writer-failed' ? async () => { throw Error('synthetic spool failure'); } : async () => ({ path: '/synthetic/file', bytes: 1 });
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(toolCalls('known-large')); }, { model: largeModel, tools,
      ...(writeOverflowInput ? { writeOverflowInput } : {}) }).run(input()), /spool|byte count/);
    assert.equal(effects, 1); assert.equal(requests, 1); assert.ok(writer.state.executions[0]?.outcome);
    const state = await runtime(writer, scripted([assistant('Recovered known result')]), { model: largeModel, tools,
      writeOverflowInput: outputSpool(path.join(root, 'spool')) }).run();
    assert.deepEqual(state.recovery.operations, []); assert.equal(effects, 1);
    assert.ok(state.messages.some(message => message.role === 'toolResult'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('outcome-before-transcript crash preserves exact known evidence and reconstructs its bounded projection', async () => {
  const root = await mkdtemp('/tmp/mira-tool-output-crash-');
  try {
    const writer = new MemoryWriter(); let effects = 0;
    const options = { model: largeModel, tools: [effectTool(async () => { effects++; return { content: [{ type: 'text' as const, text: largeToolText }], details: { receipt: 'committed' } }; })], writeOverflowInput: outputSpool(path.join(root, 'spool')) };
    writer.beforeAppend = async record => { if ((record.payload as { message?: { role?: string } }).message?.role === 'toolResult') throw Error('synthetic crash after outcome'); };
    await assert.rejects(runtime(writer, scripted([toolCalls('crash-large')]), options).run(input()), /synthetic crash/);
    const saved = structuredClone(writer.state.executions[0]?.outcome); assert.ok(saved);
    delete writer.beforeAppend;
    const state = await runtime(writer, undefined, options).recover();
    assert.deepEqual(state.snapshot.executions[0]?.outcome, saved);
    const output = state.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
    assert.deepEqual(await fullOutput(output), saved.payload); assert.equal(effects, 1);
    const target = outputPath(output); await chmod(target, 0o600); await writeFile(target, 'conflicting evidence');
    await assert.rejects(runtime(writer, undefined, options).recover(), /content conflict/);
    assert.equal(await readFile(target, 'utf8'), 'conflicting evidence'); assert.equal(effects, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('compaction sees bounded tool evidence and ordinary-file references while complete history remains unchanged', async () => {
  const root = await mkdtemp('/tmp/mira-tool-output-compact-');
  try {
    const writer = new MemoryWriter();
    await seed(writer, [input('older question'), toolCalls('old-large'), { role: 'toolResult', toolCallId: 'old-large', toolName: 'effect', content: [{ type: 'text', text: largeToolText }], isError: false, timestamp: 1001 }, assistant('Older answer'), input('Recent question'), assistant('Recent answer')]);
    const before = structuredClone(writer.state); let summaries = 0;
    const options = { model: largeModel, writeOverflowInput: outputSpool(path.join(root, 'spool')) };
    const state = await runtime(writer, (_model, context) => {
      summaries++; const text = JSON.stringify(context.messages);
      assert.ok(!text.includes('FULL_ORIGINAL_TAIL')); assert.match(text, /partial preview/); assert.match(text, /Original History ID/);
      return streamOf(assistant('Earlier tool evidence was partial; consult its original History record before exact quotations.'));
    }, options).compact({ keepRecentTokens: 256, reserveTokens: 512 });
    assert.equal(summaries, 1); assert.deepEqual(state.snapshot.records.slice(0, before.records.length), before.records);
    assert.deepEqual(state.snapshot.executions, before.executions);
    assert.deepEqual((await runtime(writer, undefined, options).recover()).messages, state.messages);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('exact-limit and multibyte boundaries count aggregate text bytes without modifying small results', async () => {
  const writer = new MemoryWriter();
  const content = [{ type: 'text' as const, text: '😀'.repeat(2_000) }, { type: 'text' as const, text: 'x'.repeat(TOOL_OUTPUT_TEXT_BYTES - 8_000) }];
  const state = await runtime(writer, scripted([toolCalls('exact-budget'), assistant()]), { model: largeModel,
    tools: [effectTool(async () => ({ content, details: { unchanged: true } }))],
    writeOverflowInput: async () => { throw Error('Exactly fitting evidence must not spool'); } }).run(input());
  const output = state.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
  assert.equal(textBytes(output), TOOL_OUTPUT_TEXT_BYTES); assert.deepEqual(output.content, content);
});

test('native bash keeps its existing full-output reference and truncation metadata inside complete evidence', async () => {
  const root = await mkdtemp('/tmp/mira-tool-output-bash-'); let nativePath: string | undefined;
  try {
    const writer = new MemoryWriter(); const tools = createWorkspaceTools(root);
    const state = await runtime(writer, scripted([{ ...toolCalls('native-bash'), content: [{ type: 'toolCall', id: 'native-bash', name: 'bash', arguments: { command: "for i in $(seq 1 3000); do printf 'native-line-%04d ----------------------------------------\\n' \"$i\"; done" } }] }, assistant()]), {
      model: largeModel, tools, writeOverflowInput: outputSpool(path.join(root, 'spool')) }).run(input());
    const output = state.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
    assert.ok(textBytes(output) <= TOOL_OUTPUT_TEXT_BYTES);
    const full = await fullOutput(output);
    assert.deepEqual(full, writer.state.executions[0]?.outcome?.payload);
    const details = full.details as { fullOutputPath?: string; truncation?: { truncated?: boolean } };
    assert.equal(details.truncation?.truncated, true); assert.ok(details.fullOutputPath);
    nativePath = details.fullOutputPath;
    const original = await readFile(nativePath, 'utf8');
    assert.match(original, /native-line-0001/); assert.match(original, /native-line-3000/);
    assert.ok(JSON.stringify(full.content).includes(nativePath));
  } finally { if (nativePath) await rm(nativePath, { force: true }); await rm(root, { recursive: true, force: true }); }
});


test('actual history_read dispatch pages an oversized fixture and rejects a stale revision as a known tool result', async () => {
  const writer = new MemoryWriter(); let requests = 0, first: HistoryTextPage | undefined;
  const id = fixtureHistoryIds.requirement;
  const reader = new FixtureHistoryReader([{ kind: 'event', id, miraId: fixtureMiraId, occurredAt: new Date(1000).toISOString(),
    event: { id: 'external', type: 'fixture', source: 'external', occurredAt: new Date(1000).toISOString(), payload: { text: largeToolText.repeat(5) + 'HISTORY_LAST_PAGE' } }, requestedWake: null }]);
  const tools = createHistoryTools(reader);
  const call = (callId: string, args: { id: string; offset?: number; revision?: string; maxBytes?: number }) => streamOf({ ...toolCalls(callId), content: [{ type: 'toolCall', id: callId, name: 'history_read', arguments: args }] });
  const state = await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) return call('paged-first', { id, offset: 0 });
    const prior = context.messages.filter(message => message.role === 'toolResult').at(-1); assert.ok(prior?.role === 'toolResult');
    const text = prior.content[0]; assert.ok(text?.type === 'text'); const page = JSON.parse(text.text);
    if (requests === 2) { first = page as HistoryTextPage; assert.ok(first.totalBytes > 1_048_576); return call('paged-tail', { id, offset: first.totalChars - 200, revision: first.revision }); }
    if (requests === 3) { assert.match(page.text, /HISTORY_LAST_PAGE/); assert.equal(page.nextOffset, null); return call('paged-stale', { id, offset: 10, revision: '0'.repeat(64) }); }
    assert.equal(requests, 4); assert.equal(page.error, 'invalid'); assert.match(page.message, /restart/);
    return streamOf(assistant('Only explicitly read pages were reviewed.'));
  }, { model: largeModel, tools }).run(input());
  assert.equal(state.snapshot.executions.length, 3); assert.ok(state.snapshot.executions.every(execution => execution.outcome));
  assert.deepEqual(state.recovery.operations, []);
});
