import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, chmod, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspaceTools, extensionTools } from '@mira/server';
import { type ToolResultMessage } from '@earendil-works/pi-ai';
import { createHistoryTools } from '@mira/runtime-pi';
import { FixtureHistoryReader, fixtureMiraId, fixtureHistoryIds } from '../../scripts/tool-usability-fixtures.mts';
import type { HistoryTextPage } from '@mira/life';
import { TOOL_OUTPUT_TEXT_BYTES } from '../../packages/runtime-pi/src/tool-output.ts';
import { assistant, effectTool, input, model, runtime, scripted, seed, streamOf, toolCalls, MemoryWriter, overrideWriter } from '../recovery/fixtures.mts';
import { fullOutput, largeToolText, outputPath, outputSpool } from '../recovery/tool-output-fixtures.mts';

const textBytes = (message: ToolResultMessage) => Buffer.byteLength(message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
const largeModel = { ...model, contextWindow: 200_000 };

test('large tool output under a writable ancestor remains readable by the model and after recovery', async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-'));
  await chmod(root, 0o777);
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

for (const length of [4_047, 4_050]) test(`bounded spool keys preserve readable evidence and restart for a ${length}-character Mira ID`, async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-long-id-'));
  try {
    const writer = new MemoryWriter(), miraId = 'm'.repeat(length);
    writer.state.miraId = miraId;
    const boundWriter = overrideWriter(writer, { miraId });
    const spool = outputSpool(path.join(root, 'spool')), keys = new Set<string>();
    let effects = 0, requests = 0, savedPath = '';
    const tools = [...createWorkspaceTools(root), effectTool(async () => { effects++; return { content: [{ type: 'text' as const, text: largeToolText }], details: {} }; })];
    const options = { model: largeModel, tools, writeOverflowInput: async (key: string, content: string) => {
      assert.ok(key.length <= 4_096); keys.add(key); return spool(key, content);
    } };
    const state = await runtime(boundWriter, async (_model, context) => {
      requests++;
      if (requests === 1) return streamOf(toolCalls('long-id-result'));
      const output = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'long-id-result');
      assert.ok(output?.role === 'toolResult'); assert.ok(textBytes(output) <= TOOL_OUTPUT_TEXT_BYTES);
      savedPath = outputPath(output);
      assert.deepEqual(await fullOutput(output), writer.state.executions[0]?.outcome?.payload);
      if (requests === 2) return streamOf({ ...toolCalls('read-long-id'), content: [{ type: 'toolCall', id: 'read-long-id', name: 'read', arguments: { path: savedPath, offset: 1, limit: 2 } }] });
      const page = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'read-long-id');
      assert.ok(page?.role === 'toolResult'); assert.match(JSON.stringify(page.content), /mira-tool-result-json-chunks-v1/);
      return streamOf(assistant('Original page read.'));
    }, options).run(input());
    assert.equal(requests, 3); assert.equal(effects, 1); assert.equal(keys.size, 1);
    const entry = writer.state.records.find(record => (record.payload as { message?: { toolCallId?: string } }).message?.toolCallId === 'long-id-result');
    assert.ok(entry);
    const expectedKey = length === 4_047 ? `tool-output:${miraId}:${entry.id}`
      : `tool-output-sha256:${createHash('sha256').update(JSON.stringify([miraId, entry.id])).digest('hex')}`;
    assert.deepEqual([...keys], [expectedKey]);
    const before = structuredClone(writer.state), originalFile = await readFile(savedPath, 'utf8');
    await rm(savedPath);
    const restored = await runtime(boundWriter, undefined, options).recover();
    assert.equal(await readFile(savedPath, 'utf8'), originalFile);
    assert.deepEqual(restored.messages, state.messages); assert.deepEqual(writer.state, before); assert.equal(effects, 1);
    if (length === 4_050) {
      const otherId = 'n' + miraId.slice(1), otherWriter = new MemoryWriter();
      otherWriter.state = structuredClone(before); otherWriter.state.miraId = otherId;
      const other = await runtime(overrideWriter(otherWriter, { miraId: otherId }), undefined, options).recover();
      const output = other.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'long-id-result');
      assert.ok(output?.role === 'toolResult');
      assert.notEqual(outputPath(output), savedPath, 'distinct Mira namespaces cannot alias the same History UUID');
      assert.equal(await readFile(outputPath(output), 'utf8'), originalFile); assert.equal(keys.size, 2); assert.equal(effects, 1);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('all result fields, images, multiple text blocks and known error status survive the real durable boundary', async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-metadata-'));
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
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-failure-'));
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
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-crash-'));
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
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-compact-'));
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
  const content = [{ type: 'text' as const, text: '😀'.repeat(2_000) }, { type: 'text' as const, text: 'x'.repeat(TOOL_OUTPUT_TEXT_BYTES - 8_000 - 1) }];
  const state = await runtime(writer, scripted([toolCalls('exact-budget'), assistant()]), { model: largeModel,
    tools: [effectTool(async () => ({ content, details: { unchanged: true } }))],
    writeOverflowInput: async () => { throw Error('Exactly fitting evidence must not spool'); } }).run(input());
  const output = state.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
  assert.equal(textBytes(output), TOOL_OUTPUT_TEXT_BYTES); assert.deepEqual(output.content, content);
});

test('native bash keeps its existing full-output reference and truncation metadata inside complete evidence', async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-bash-')); let nativePath: string | undefined;
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


test('fresh recovery reconstructs fully compacted-out tool files once; active references still revalidate on every recovery', async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-archived-'));
  try {
    const writer = new MemoryWriter(); const writes: string[] = [];
    const spool = outputSpool(path.join(root, 'spool'));
    const writeOverflowInput = async (id: string, content: string) => { writes.push(id); return spool(id, content); };
    await seed(writer, [input('old question'), toolCalls('archived-large'), { role: 'toolResult', toolCallId: 'archived-large', toolName: 'effect', content: [{ type: 'text', text: largeToolText }], isError: false, timestamp: 1001 }, assistant('old answer'), input('recent question'), assistant('recent answer')]);
    const options = { model: largeModel, writeOverflowInput };
    const active = runtime(writer, undefined, options);
    const original = (await active.recover()).messages.find(message => message.role === 'toolResult'); assert.ok(original?.role === 'toolResult');
    const target = outputPath(original), file = await readFile(target, 'utf8');
    const afterFirst = writes.length;
    await rm(target); await active.recover(); assert.equal(writes.length, afterFirst + 1); assert.equal(await readFile(target, 'utf8'), file);
    await chmod(target, 0o600); await writeFile(target, 'active conflict');
    await assert.rejects(active.recover(), /content conflict/);
    await rm(target);
    const compacted = await runtime(writer, scripted([assistant(`Earlier result remains available at ${target}`)]), options).compact({ keepRecentTokens: 256, reserveTokens: 512 });
    assert.ok(!compacted.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'archived-large'));
    assert.match(JSON.stringify(compacted.messages), /batch.txt/);
    const canonical = structuredClone(writer.state); await rm(target);
    const fresh = runtime(writer, scripted([assistant('Continue without rereading old evidence'), assistant('Another continuation')]), options);
    const beforeFresh = writes.length;
    await fresh.recover(); assert.equal(writes.length, beforeFresh + 1); assert.equal(await readFile(target, 'utf8'), file);
    assert.deepEqual(writer.state, canonical);
    await fresh.recover(); await fresh.run(input('continue')); await fresh.run(input('continue again'));
    assert.equal(writes.length, beforeFresh + 1, 'archived lifetime evidence is not repeatedly read/written on natural requests');
    await chmod(target, 0o600); await writeFile(target, 'archived conflict');
    await assert.rejects(runtime(writer, undefined, options).recover(), /content conflict/);
    assert.equal(await readFile(target, 'utf8'), 'archived conflict');
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const mode of ['unsupported', 'native', 'media-budget'] as const) test(`final ${mode} hydration stays inside the text cap and preserves exact canonical evidence and media slots`, async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-hydrated-'));
  try {
    const writer = new MemoryWriter(), bytes = Buffer.from('synthetic-native-video-do-not-persist');
    const reference = { id: randomUUID(), name: 'clip.mp4', mimeType: 'video/mp4', size: mode === 'media-budget' ? 13 * 1024 * 1024 : bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), path: '/private/clip.mp4' };
    const references = mode === 'native' ? [reference, { ...reference, id: randomUUID(), name: 'second.mp4', path: '/private/second.mp4' }] : [reference];
    const originalText = 'a'.repeat(mode === 'native' ? 30_000 : 16_300);
    let requests = 0, resolves = 0;
    const selected = mode === 'unsupported' ? largeModel : { ...largeModel, api: 'google-generative-ai' as const, provider: 'google', id: 'gemini-synthetic-budget' };
    const options = { model: selected, writeOverflowInput: outputSpool(path.join(root, 'spool')),
      tools: [{ ...effectTool(async () => ({ content: [{ type: 'text' as const, text: originalText }], details: { version: 1, type: 'attachment-read', attachments: references } })), name: 'read' }],
      resolveAttachment: async () => { resolves++; assert.equal(mode, 'native'); return bytes; } };
    const state = await runtime(writer, async (_model, context) => {
      requests++;
      if (requests === 1) return streamOf({ ...toolCalls('hydrated-read'), content: [{ type: 'toolCall', id: 'hydrated-read', name: 'read', arguments: {} }] });
      const output = context.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
      assert.ok(textBytes(output) <= TOOL_OUTPUT_TEXT_BYTES);
      if (mode === 'unsupported') assert.match(JSON.stringify(output.content), /The selected model cannot consume native video\. Video bytes were NOT provided/);
      else if (mode === 'media-budget') assert.match(JSON.stringify(output.content), /video bytes were NOT provided because this tool result exceeds the remaining 12 MiB/);
      else {
        const videos = (output as typeof output & { miraNativeVideos: Array<{ contentIndex: number; data: string; attachmentId: string }> }).miraNativeVideos;
        assert.equal(videos.length, 2);
        for (const [index, video] of videos.entries()) {
          assert.equal(video.data, bytes.toString('base64')); assert.equal(video.attachmentId, references[index]!.id);
          const slot = output.content[video.contentIndex]; assert.ok(slot?.type === 'text'); assert.match(slot.text, new RegExp(references[index]!.id));
        }
      }
      const full = await fullOutput(output); assert.equal(full.content[0]?.type === 'text' && full.content[0].text, originalText);
      assert.ok(!JSON.stringify(full).includes('miraNativeVideos')); assert.ok(!JSON.stringify(full).includes(bytes.toString('base64')));
      assert.ok(!(await readFile(outputPath(output), 'utf8')).includes(bytes.toString('base64')));
      assert.deepEqual(full, writer.state.executions[0]?.outcome?.payload);
      return streamOf(assistant('Only the actual supplied media and text were reviewed.'));
    }, options).run(input());
    assert.equal(requests, 2); assert.equal(resolves, mode === 'native' ? 2 : 0);
    assert.ok(!JSON.stringify(state.snapshot).includes('miraNativeVideos'));
    assert.deepEqual((await runtime(writer, undefined, options).recover()).messages, state.messages);
    if (mode === 'unsupported') {
      const original = state.messages.find(message => message.role === 'toolResult'); assert.ok(original?.role === 'toolResult');
      const target = outputPath(original), file = await readFile(target, 'utf8');
      const compacting = runtime(writer, scripted([assistant('Recent answer'), assistant(`Earlier result is available at ${target}`)]), options);
      await compacting.run(input('A newer question'));
      const compacted = await compacting.compact({ keepRecentTokens: 256, reserveTokens: 512 });
      assert.ok(!compacted.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'hydrated-read'));
      await rm(target);
      await runtime(writer, undefined, { ...options, model: { ...largeModel, api: 'google-generative-ai', provider: 'google', id: 'gemini-after-restart' } }).recover();
      assert.equal(await readFile(target, 'utf8'), file, 'near-limit media originals remain reconstructible outside the tail and after model change');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('media annotations that cannot fit fail before provider dispatch without dropping slots or persisting hydrated bytes', async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-media-too-large-'));
  try {
    const writer = new MemoryWriter(), bytes = Buffer.from('private-native-byte'); let requests = 0;
    const references = Array.from({ length: 8 }, (_, index) => ({ id: randomUUID(), name: `clip-${index}.mp4`, mimeType: 'video/mp4', size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), path: '/' + 'p'.repeat(3_000) + index }));
    const options = { model: { ...largeModel, api: 'google-generative-ai' as const, provider: 'google', id: 'gemini-oversized-annotations' },
      writeOverflowInput: outputSpool(path.join(root, 'spool')), resolveAttachment: async () => bytes,
      tools: [{ ...effectTool(async () => ({ content: [{ type: 'text' as const, text: 'original small read' }], details: { version: 1, type: 'attachment-read', attachments: references } })), name: 'read' }] };
    await assert.rejects(runtime(writer, () => { requests++; return streamOf({ ...toolCalls('huge-media-notes'), content: [{ type: 'toolCall', id: 'huge-media-notes', name: 'read', arguments: {} }] }); }, options).run(input()), /media annotations.*exceed/);
    assert.equal(requests, 1); assert.ok(writer.state.executions[0]?.outcome);
    assert.ok(!JSON.stringify(writer.state).includes('miraNativeVideos')); assert.ok(!JSON.stringify(writer.state).includes(bytes.toString('base64')));
    const state = await runtime(writer, undefined, options).recover(); assert.deepEqual(state.recovery.operations, []);
    const result = state.messages.find(message => message.role === 'toolResult'); assert.ok(result?.role === 'toolResult');
    assert.deepEqual(await fullOutput(result), writer.state.executions[0]?.outcome?.payload);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('unmergeable opaque text separators fail before dispatch without losing canonical blocks or replaying effects', async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-tool-output-opaque-separators-'));
  try {
    const writer = new MemoryWriter(), spool = outputSpool(path.join(root, 'spool'));
    const content = Array.from({ length: 25_000 }, (_, index) => ({ type: 'text' as const, text: '', opaque: { index } }));
    let effects = 0, requests = 0, target = '';
    const options = { model: largeModel, tools: [effectTool(async () => { effects++; return { content, details: { complete: true } }; })],
      writeOverflowInput: async (key: string, file: string) => { const artifact = await spool(key, file); target = artifact.path; return artifact; } };
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(toolCalls('opaque-blocks')); }, options).run(input()), /unmergeable text separators exceed/);
    assert.equal(requests, 1); assert.equal(effects, 1);
    const canonical = writer.state.executions[0]?.outcome?.payload as unknown as ToolResultMessage;
    assert.deepEqual(canonical.content, content);
    const lines = (await readFile(target, 'utf8')).trimEnd().split('\n').slice(1).map(line => JSON.parse(line).text);
    assert.deepEqual(JSON.parse(lines.join('')), canonical);
    const before = structuredClone(writer.state); await rm(target);
    await assert.rejects(runtime(writer, undefined, options).recover(), /unmergeable text separators exceed/);
    assert.deepEqual(writer.state, before); assert.equal(effects, 1);
    assert.deepEqual(JSON.parse((await readFile(target, 'utf8')).trimEnd().split('\n').slice(1).map(line => JSON.parse(line).text).join('')), canonical);
  } finally { await rm(root, { recursive: true, force: true }); }
});
