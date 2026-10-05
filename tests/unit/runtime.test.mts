import assert from 'node:assert/strict';
import test from 'node:test';
import type { WakeWriter } from '@mira/life';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setImmediate } from 'node:timers/promises';
import { Type, createAssistantMessageEventStream, getCurrentTools, toToolDeclaration, type TranscriptContext } from '@earendil-works/pi-ai';
import { decodeRecords, encodeEntry, jsonValue, messageEntry, PiDurableRuntime } from '@mira/runtime-pi';
import { assistant, deferred, effectTool, model, result, scripted, streamOf, toolCalls, MemoryWriter, allow, input, runtime, seed, compactionMessages } from '../recovery/fixtures.mts';

test('structured JSON roundtrip retains system sections, images, tool fields and opaque provider fields', async () => {
  const writer = new MemoryWriter();
  const messages = compactionMessages();
  messages[0] = { role: 'system', content: [{ type: 'text', text: 'base' }], sections: { identity: '<identity>Synthetic</identity>', state: null }, timestamp: 1000 };
  messages[1] = { role: 'user', content: [{ type: 'text', text: 'Synthetic image input' }, { type: 'image', mimeType: 'image/png', data: 'c3ludGhldGlj' }], timestamp: 1000 };
  const special = { ...assistant(), content: [{ type: 'thinking', thinking: '', thinkingSignature: 'encrypted-synthetic', redacted: true }, { type: 'text', text: 'answer', textSignature: 'opaque-synthetic' }], providerExtras: { nested: [1, null, { binary: 'synthetic' }] } };
  await seed(writer, [...messages, special as ReturnType<typeof assistant>]);
  const restored = await runtime(writer).recover();
  assert.deepEqual(restored.messages, [...messages, special]);
  assert.deepEqual(JSON.parse(JSON.stringify(writer.state)), writer.state);
  assert.throws(() => jsonValue({ value: BigInt(1) }), /Non-JSON/);
  assert.throws(() => jsonValue([undefined]), /Non-JSON/);
  assert.throws(() => jsonValue({ bad: Infinity }), /Non-JSON/);
});

test('unknown envelope/runtime versions and mismatched entry metadata fail closed', async () => {
  for (const change of [ { formatVersion: 2 }, { runtimeVersion: 'future' }, { runtime: 'other' }, { id: 'different' } ]) {
    const writer = new MemoryWriter();
    await seed(writer, [input()]);
    Object.assign(writer.state.records[0]!, change);
    let requests = 0;
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()));
    assert.equal(requests, 0);
  }
});

test('agent authorization deferral records its reason and continues cognition without intent or effect', async () => {
  const writer = new MemoryWriter();
  assert.throws(() => new PiDurableRuntime({ writer, model, streamFn: scripted([]) } as never), /Authorization/);
  let effects = 0, requests = 0, authorizations = 0;
  const instance = runtime(writer, (_model, context) => {
    requests++;
    if (requests === 2) assert.match(JSON.stringify(context), /Please clarify which destination/);
    return streamOf(requests === 1 ? toolCalls('a', 'b') : assistant('Which destination do you mean?'));
  }, {
    tools: [effectTool(async () => { effects++; return result; })],
    authorize: async () => { authorizations++; return { allowed: false, reason: 'Please clarify which destination' }; },
  });
  const recovered = await instance.run(input());
  assert.equal(effects, 0); assert.equal(requests, 2); assert.equal(authorizations, 1);
  assert.equal(writer.state.executions.length, 0);
  assert.equal(recovered.recovery.operations[0]?.reason, 'Please clarify which destination');
  const reloaded = await runtime(writer).recover();
  assert.deepEqual(reloaded.recovery, recovered.recovery);
});

test('awaited assistant append and first result append are real sequential execution barriers', async () => {
  const writer = new MemoryWriter();
  const atCall = deferred(), releaseCall = deferred(), atResult = deferred(), releaseResult = deferred();
  const trace: string[] = []; let requests = 0;
  writer.beforeAppend = async record => {
    const entry = decodeRecords([record], record.parentId)[0]!;
    if (entry.type !== 'message') return;
    if (entry.message.role === 'assistant' && entry.message.stopReason === 'toolUse') { atCall.resolve(); await releaseCall.promise; trace.push('calls'); }
    if (entry.message.role === 'toolResult') {
      if (entry.message.toolCallId === 'a') { atResult.resolve(); await releaseResult.promise; }
      trace.push(`result:${entry.message.toolCallId}`);
    }
  };
  const instance = runtime(writer, () => { requests++; return streamOf(requests === 1 ? toolCalls('a', 'b') : assistant()); }, {
    tools: [effectTool(async id => { trace.push(`effect:${id}`); return result; })],
  });
  const work = instance.run(input());
  await atCall.promise; await setImmediate(); assert.deepEqual(trace, []);
  releaseCall.resolve(); await atResult.promise; await setImmediate();
  assert.deepEqual(trace, ['calls', 'effect:a']); assert.equal(requests, 1);
  assert.equal(writer.state.executions[0]?.outcome?.callId, 'a');
  releaseResult.resolve(); await work;
  assert.deepEqual(trace, ['calls', 'effect:a', 'result:a', 'effect:b', 'result:b']);
  assert.equal(requests, 2);
});

test('assistant persistence failure is surfaced despite Pi resolving prompt and latches instance', async () => {
  const writer = new MemoryWriter(); let effects = 0;
  writer.beforeAppend = async record => { if (JSON.stringify(record.payload).includes('toolUse')) throw Error('assistant append failed'); };
  const instance = runtime(writer, scripted([toolCalls('a')]), { tools: [effectTool(async () => { effects++; return result; })] });
  await assert.rejects(instance.run(input()), /assistant append failed/);
  assert.equal(effects, 0); assert.equal(writer.state.executions.length, 0);
  await assert.rejects(instance.recover(), /assistant append failed/);
});

for (const phase of ['intent', 'outcome'] as const) test(`swallowed Pi ${phase === 'intent' ? 'before' : 'after'} hook failure cannot execute siblings or next model`, async () => {
  const writer = new MemoryWriter(); const effects: string[] = []; let requests = 0;
  if (phase === 'intent') writer.beforeIntent = async () => { throw Error('intent failed'); };
  else writer.beforeOutcome = async () => { throw Error('outcome failed'); };
  const instance = runtime(writer, () => { requests++; return streamOf(toolCalls('a', 'b')); }, { tools: [effectTool(async id => { effects.push(id); return result; })] });
  await assert.rejects(instance.run(input()), new RegExp(`${phase} failed`));
  assert.deepEqual(effects, phase === 'intent' ? [] : ['a']); assert.equal(requests, 1);
  const resumed = await runtime(writer).run(input());
  assert.deepEqual(resumed.recovery.operations.map(operation => operation.status), phase === 'intent' ? ['not-started', 'not-started'] : ['outcome-unknown', 'not-started']);
  assert.deepEqual(effects, phase === 'intent' ? [] : ['a']);
});

test('thrown effect becomes honest recovery evidence and cognition continues without replay or forged result', async () => {
  const writer = new MemoryWriter(); let effects = 0;
  const requests: TranscriptContext[] = [];
  const restored = await runtime(writer, scripted([toolCalls('a', 'b'), assistant('I need to check what happened')], (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant()); }), {
    tools: [effectTool(async () => { effects++; throw Error('lost receipt after effect'); })],
  }).run(input());
  assert.equal(effects, 1); assert.equal(writer.state.executions[0]?.outcome, null);
  assert.equal(requests.length, 2);
  assert.deepEqual(restored.recovery.operations.map(operation => [operation.callId, operation.status]), [['a', 'outcome-unknown'], ['b', 'not-started']]);
  assert.match(JSON.stringify(requests[1]), /may already have executed/);
  assert.match(JSON.stringify(requests[1]), /Execution did not start/);
  assert.equal(requests[1]!.messages.some(message => message.role === 'toolResult'), false);
  assert.equal(requests[1]!.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall')), false);
  const original = decodeRecords(writer.state.records).find(entry => entry.type === 'message' && entry.message.role === 'assistant');
  assert.ok(original?.type === 'message' && original.message.role === 'assistant');
  assert.deepEqual(original.message.content, toolCalls('a', 'b').content);
});

test('known outcome is reconstructed byte-for-JSON-byte after toolResult append fails; effect is never repeated', async () => {
  const writer = new MemoryWriter(); let effects = 0;
  writer.beforeAppend = async record => { if ((record.payload as { message?: { role: string } }).message?.role === 'toolResult') throw Error('result append crashed'); };
  await assert.rejects(runtime(writer, scripted([toolCalls('a')]), { tools: [effectTool(async () => { effects++; return result; })] }).run(input()), /result append crashed/);
  const saved = structuredClone(writer.state.executions[0]!.outcome!.payload);
  delete writer.beforeAppend;
  const fresh = runtime(writer, scripted([assistant()]), { tools: [effectTool(async () => { effects++; return result; })] });
  const recovered = await fresh.recover();
  assert.deepEqual(recovered.messages.at(-1), saved);
  await fresh.run();
  assert.equal(effects, 1); assert.equal(writer.state.executions.length, 1);
});

test('duplicate call IDs rejected across wakes and within a batch despite replay never', async () => {
  const writer = new MemoryWriter(); let effects = 0;
  const tools = [effectTool(async () => { effects++; return result; })];
  await runtime(writer, scripted([toolCalls('same'), assistant()]), { tools }).run(input());
  const before = writer.state.records.length;
  await assert.rejects(runtime(writer, scripted([toolCalls('same')]), { tools }).run(input()), /Duplicate tool-call/);
  assert.equal(effects, 1); assert.equal(writer.state.records.length, before + 1);
  await assert.rejects(runtime(new MemoryWriter(), scripted([toolCalls('twice', 'twice')]), { tools }).run(input()), /Duplicate tool-call/);
  assert.equal(effects, 1);
});

test('writer loss and explicit abort gate model/tool paths and latch the runtime', async () => {
  const writer = new MemoryWriter(); const entered = deferred(), release = deferred(); let effects = 0;
  const instance = runtime(writer, scripted([toolCalls('a')]), {
    tools: [effectTool(async () => { effects++; return result; })],
    authorize: async () => { entered.resolve(); await release.promise; return { allowed: true, evidence: {} }; },
  });
  const work = instance.run(input()); await entered.promise;
  writer.controller.abort(Error('writer connection lost')); release.resolve();
  await assert.rejects(work, /writer connection lost/); assert.equal(effects, 0);
  const other = runtime(new MemoryWriter()); const controller = new AbortController(); controller.abort(Error('cancel now'));
  await assert.rejects(other.run(input(), controller.signal), /cancel now/);
});

test('continued requests are rebuilt from authoritative structured records, preserving exact prefix', async () => {
  const writer = new MemoryWriter();
  await runtime(writer).run(input('first thought'));
  const before = structuredClone(writer.state.records); const requests: TranscriptContext[] = [];
  await runtime(writer, (_m, c) => { requests.push(structuredClone(c)); return streamOf(assistant('next thought')); }).run(input('that earlier one'));
  assert.deepEqual(writer.state.records.slice(0, before.length), before);
  assert.equal(requests.length, 1);
  assert.match(JSON.stringify(requests[0]), /first thought/);
  assert.match(JSON.stringify(requests[0]), /that earlier one/);
});

test('disposable full SDK compaction preserves raw history and tool tail, then repeats after system update', async () => {
  const writer = new MemoryWriter(); await seed(writer, compactionMessages());
  const requests: TranscriptContext[] = [];
  const firstRaw = structuredClone(writer.state.records);
  const first = await runtime(writer, (_m, c) => { requests.push(structuredClone(c)); return streamOf(assistant('First checkpoint')); }).compact({ keepRecentTokens: 1 });
  assert.equal(first.entries.at(-1)?.type, 'compaction');
  assert.deepEqual(writer.state.records.slice(0, firstRaw.length), firstRaw);
  assert.deepEqual(first.messages.slice(2), compactionMessages().slice(4));
  await seed(writer, compactionMessages('second'));
  const beforeSecond = structuredClone(writer.state.records);
  const second = await runtime(writer, (_m, c) => { requests.push(structuredClone(c)); return streamOf(assistant('Second checkpoint')); }).compact({ keepRecentTokens: 1 });
  assert.equal(second.entries.filter(e => e.type === 'compaction').length, 2);
  assert.deepEqual(writer.state.records.slice(0, beforeSecond.length), beforeSecond);
  assert.deepEqual(second.messages.slice(2), compactionMessages('second').slice(4));
  assert.match(JSON.stringify(second.messages[0]), /second system/);
  assert.ok(requests.some(r => JSON.stringify(r).includes('<previous-summary>') && JSON.stringify(r).includes('First checkpoint')));
});

test('compaction cancellation and length-limited summary never publish a checkpoint', async () => {
  for (const kind of ['cancel', 'length'] as const) {
    const writer = new MemoryWriter(); await seed(writer, compactionMessages());
    const before = structuredClone(writer.state); const entered = deferred(); const controller = new AbortController();
    const instance = runtime(writer, (_m, _c, options) => {
      if (kind === 'length') return streamOf({ ...assistant('partial'), stopReason: 'length' });
      const stream = createAssistantMessageEventStream();
      const abort = () => { const error = { ...assistant(''), stopReason: 'aborted' as const }; stream.push({ type: 'error', reason: 'aborted', error }); stream.end(); };
      if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true });
      entered.resolve(); return stream;
    });
    const work = instance.compact({ keepRecentTokens: 1, signal: controller.signal });
    if (kind === 'cancel') { await entered.promise; controller.abort(Error('cancel compaction')); }
    await assert.rejects(work, /cancel|abort|incomplete/i);
    assert.deepEqual(writer.state, before);
  }
});

test('compaction CAS refuses stale checkpoint without overwriting newer input', async () => {
  const writer = new MemoryWriter(); await seed(writer, compactionMessages());
  const entered = deferred(), release = deferred();
  const work = runtime(writer, async () => { entered.resolve(); await release.promise; return streamOf(assistant('stale summary')); }).compact({ keepRecentTokens: 1 });
  await entered.promise;
  await seed(writer, [input('concurrently accepted')]); const newer = structuredClone(writer.state);
  release.resolve(); await assert.rejects(work, /version conflict/);
  assert.deepEqual(writer.state, newer);
});

test('malformed provider-facing messages and tool evidence corruption fail closed before inference', async () => {
  for (const mutate of [
    (writer: MemoryWriter) => { (writer.state.records[0]!.payload as { message: { content: unknown } }).message.content = 123; },
    (writer: MemoryWriter) => { const record = writer.state.records.find(r => (r.payload as { message: { role: string } }).message.role === 'assistant')!; delete (record.payload as { message: { usage?: unknown } }).message.usage; },
    (writer: MemoryWriter) => { writer.state.executions[0]!.intent.requestedArguments = { substituted: true }; },
    (writer: MemoryWriter) => { writer.state.executions = []; },
  ]) {
    const writer = new MemoryWriter(); await seed(writer, compactionMessages()); mutate(writer); let requests = 0;
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()));
    assert.equal(requests, 0);
  }
});

test('prepublication cancellation during awaited append rolls back candidate checkpoint', async () => {
  const writer = new MemoryWriter(); await seed(writer, compactionMessages()); const before = structuredClone(writer.state);
  const entered = deferred(), release = deferred(), controller = new AbortController();
  writer.beforeAppend = async record => { if (record.kind === 'checkpoint') { entered.resolve(); await release.promise; } };
  const work = runtime(writer, () => streamOf(assistant('candidate'))).compact({ keepRecentTokens: 1, signal: controller.signal });
  await entered.promise; controller.abort(Error('cancel before publication')); release.resolve();
  await assert.rejects(work, /cancel/); assert.deepEqual(writer.state, before);
});


test('authorized converted arguments and exact original requested arguments are independently retained', async () => {
  const writer = new MemoryWriter(); let executed: unknown, authorized: unknown;
  const call = toolCalls('coerced');
  call.content = [{ type: 'toolCall', id: 'coerced', name: 'effect', arguments: { count: '3', note: null } }];
  const tool = { ...effectTool(async (_id, args) => { executed = args; return result; }), parameters: Type.Object({ count: Type.Number(), note: Type.Optional(Type.String()) }) };
  await runtime(writer, scripted([call, assistant()]), {
    tools: [tool], authorize: async (_call, args) => { authorized = structuredClone(args); return { allowed: true, evidence: { synthetic: true } }; },
  }).run(input());
  assert.deepEqual(executed, { count: 3 }); assert.deepEqual(authorized, executed);
  const execution = writer.state.executions[0]!;
  assert.deepEqual(execution.intent.requestedArguments, { count: '3', note: null });
  assert.deepEqual(execution.intent.arguments, { count: 3 });
  await runtime(writer).recover();
});

test('corrupt checkpoints cannot point forward, orphan a tool result, or inject malformed system state', async () => {
  for (const corrupt of ['orphan', 'future', 'system'] as const) {
    const writer = new MemoryWriter(); await seed(writer, compactionMessages());
    await runtime(writer, () => streamOf(assistant('checkpoint'))).compact({ keepRecentTokens: 1 });
    const checkpoint = writer.state.records.at(-1)!.payload as { firstKeptEntryId: string; systemMessage?: unknown };
    if (corrupt === 'orphan') checkpoint.firstKeptEntryId = writer.state.records.at(-2)!.id;
    if (corrupt === 'future') checkpoint.firstKeptEntryId = 'not-yet-written';
    if (corrupt === 'system') checkpoint.systemMessage = { role: 'system', content: 123, timestamp: 1000 };
    let requests = 0;
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()), /Checkpoint|content/);
    assert.equal(requests, 0);
  }
});


test('a live call mutated while assistant append awaits cannot cross the durable intent boundary', async () => {
  const writer = new MemoryWriter(); const call = toolCalls('mutable'); let effects = 0;
  writer.beforeAppend = async record => {
    if ((record.payload as { message?: { stopReason?: string } }).message?.stopReason === 'toolUse') {
      const block = call.content[0]!;
      if (block.type === 'toolCall') block.arguments['changedAfterSnapshot'] = true;
    }
  };
  await assert.rejects(runtime(writer, scripted([call]), { tools: [effectTool(async () => { effects++; return result; })] }).run(input()), /durably recorded/);
  assert.equal(effects, 0); assert.equal(writer.state.executions.length, 0);
});


test('every split-turn summary must contain nonempty text before any checkpoint is published', async () => {
  for (const position of [0, 1]) for (const invalid of ['', ' \n\t ', null]) {
    const writer = new MemoryWriter(); await seed(writer, compactionMessages()); const before = structuredClone(writer.state);
    let requests = 0;
    const instance = runtime(writer, () => {
      const message = assistant('valid summary');
      if (requests++ === position) message.content = invalid === null ? [{ type: 'thinking', thinking: 'synthetic internal-only output' }] : [{ type: 'text', text: invalid }];
      return streamOf(message);
    });
    await assert.rejects(instance.compact({ keepRecentTokens: 1 }), /nonempty text/);
    assert.ok(requests > position); assert.deepEqual(writer.state, before);
  }
});


test('stored checkpoint summaries cannot be empty or whitespace during fresh recovery', async () => {
  for (const summary of ['', ' \n\t ']) {
    const writer = new MemoryWriter(); await seed(writer, compactionMessages());
    await runtime(writer, () => streamOf(assistant('valid checkpoint'))).compact({ keepRecentTokens: 1 });
    (writer.state.records.at(-1)!.payload as { summary: string }).summary = summary;
    const before = structuredClone(writer.state); let requests = 0;
    const instance = runtime(writer, () => { requests++; return streamOf(assistant()); });
    await assert.rejects(instance.recover(), /Invalid Pi checkpoint/);
    await assert.rejects(instance.run(input()), /Invalid Pi checkpoint/);
    assert.equal(requests, 0); assert.deepEqual(writer.state, before);
  }
});


test('stored checkpoints must retain the exact public-SDK-derived preceding system state', async () => {
  for (const corrupt of ['missing', 'content', 'sections', 'tools'] as const) {
    const writer = new MemoryWriter(); const messages = compactionMessages();
    messages[0] = { role: 'system', content: 'Synthetic foundation', sections: { identity: 'Mira synthetic' }, toolsAdded: [{ name: 'effect', description: 'Synthetic counter', parameters: Type.Object({}) }], timestamp: 1000 };
    await seed(writer, messages);
    await runtime(writer, () => streamOf(assistant('valid checkpoint'))).compact({ keepRecentTokens: 1 });
    const checkpoint = writer.state.records.at(-1)!.payload as { systemMessage?: { content: string; sections?: unknown; toolsAdded?: unknown } };
    if (corrupt === 'missing') delete checkpoint.systemMessage;
    else if (corrupt === 'content') checkpoint.systemMessage!.content = 'Substituted foundation';
    else if (corrupt === 'sections') delete checkpoint.systemMessage!.sections;
    else delete checkpoint.systemMessage!.toolsAdded;
    const before = structuredClone(writer.state); let requests = 0;
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()), /Checkpoint system state/);
    assert.equal(requests, 0); assert.deepEqual(writer.state, before);
  }
});

test('malformed toolsRemoved strings fail closed instead of silently keeping an advertised tool', async () => {
  const writer = new MemoryWriter();
  await seed(writer, [
    { role: 'system', content: 'Synthetic tools', toolsAdded: [{ name: 'effect', description: 'Synthetic counter', parameters: Type.Object({}) }], timestamp: 1000 },
    { role: 'system', content: '', toolsRemoved: [{ name: 'effect' }], timestamp: 1001 },
    input(),
  ]);
  const valid = await runtime(writer).recover(); assert.equal(valid.messages.length, 3);
  (writer.state.records[1]!.payload as { message: { toolsRemoved: unknown } }).message.toolsRemoved = ['effect'];
  let requests = 0;
  await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()), /Invalid removed tools/);
  assert.equal(requests, 0);
});


test('first provider sees durably declared registered tools without a preseeded system message', async () => {
  const writer = new MemoryWriter(); const tool = effectTool(async () => result); const requests: TranscriptContext[] = [];
  await runtime(writer, (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant()); }, { tools: [tool] }).run(input());
  assert.equal(requests.length, 1);
  assert.deepEqual(getCurrentTools(requests[0]!.messages), [toToolDeclaration(tool)]);
  const stored = await runtime(writer).recover();
  assert.deepEqual(getCurrentTools(stored.messages), [toToolDeclaration(tool)]);
  assert.ok(stored.entries.some(entry => entry.type === 'message' && entry.message.role === 'system' && entry.message.toolsAdded?.some(t => t.name === 'effect')));
});

test('fresh runtimes durably advertise registry additions, changes and removals to actual provider contexts', async () => {
  const writer = new MemoryWriter(); const original = effectTool(async () => result);
  const changed = { ...original, description: 'Changed synthetic signature', parameters: Type.Object({ count: Type.Number() }) };
  const other = { ...original, name: 'other', label: 'other' };
  for (const tools of [[original], [changed, other], []]) {
    const requests: TranscriptContext[] = [];
    await runtime(writer, (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant()); }, { tools }).run(input());
    assert.equal(requests.length, 1);
    assert.deepEqual(getCurrentTools(requests[0]!.messages), tools.map(toToolDeclaration));
    const state = await runtime(writer).recover();
    assert.deepEqual(getCurrentTools(state.messages), tools.map(toToolDeclaration));
  }
});

test('wrapped tools retain constrainedSampling in durable declarations and actual provider contexts', async () => {
  for (const preseedSystem of [false, true]) {
    const writer = new MemoryWriter();
    if (preseedSystem) await seed(writer, [{ role: 'system', content: 'Synthetic foundation', timestamp: 1000 }]);
    const tool = { ...effectTool(async () => result), constrainedSampling: { type: 'json_schema' as const, strict: 'require' as const } };
    const requests: TranscriptContext[] = [];
    await runtime(writer, (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant()); }, { tools: [tool] }).run(input());
    assert.equal(requests.length, 1);
    assert.deepEqual(getCurrentTools(requests[0]!.messages), [toToolDeclaration(tool)]);
    assert.deepEqual(getCurrentTools(requests[0]!.messages)[0]?.constrainedSampling, tool.constrainedSampling);
    const state = await runtime(writer).recover();
    assert.deepEqual(getCurrentTools(state.messages)[0]?.constrainedSampling, tool.constrainedSampling);
  }
});


test('JSON array role discriminators fail fresh recovery instead of disappearing from provider context', async () => {
  const writer = new MemoryWriter(); await seed(writer, [{ role: 'user', content: [{ type: 'text', text: 'Preserve this prior instruction' }], timestamp: 1000 }]);
  (writer.state.records[0]!.payload as { message: { role: unknown } }).message.role = ['user'];
  const before = structuredClone(writer.state); const requests: TranscriptContext[] = [];
  await assert.rejects(runtime(writer).recover(), /Unsupported Pi message/);
  await assert.rejects(runtime(writer, (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant()); }).run(input()), /Unsupported Pi message/);
  assert.deepEqual(requests, []); assert.deepEqual(writer.state, before);
});

test('assistant stopReason discriminators must be literal strings when encoding and recovering', async () => {
  const malformed = { ...assistant(), stopReason: ['stop'] };
  assert.throws(() => encodeEntry(messageEntry(malformed as never, null)), /Invalid completed assistant metadata/);
  const writer = new MemoryWriter(); await seed(writer, [input(), assistant()]);
  (writer.state.records.at(-1)!.payload as { message: { stopReason: unknown } }).message.stopReason = ['stop'];
  let requests = 0;
  await assert.rejects(runtime(writer).recover(), /Invalid completed assistant metadata/);
  await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()), /Invalid completed assistant metadata/);
  assert.equal(requests, 0);
});


test('compaction never resolves ambient credentials for recognized providers or probes auth files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mira-auth-isolation-'));
  try {
    const worker = new URL('../recovery/ambient-auth-worker.mts', import.meta.url).pathname;
    const guard = new URL('../deny-model-network.mts', import.meta.url).pathname;
    const child = await promisify(execFile)(process.execPath, ['--import', guard, worker], {
      timeout: 30_000,
      env: { PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
        OPENAI_API_KEY: 'synthetic-ambient-key-openai', ANTHROPIC_API_KEY: 'synthetic-ambient-key-anthropic',
        AWS_PROFILE: 'synthetic-test-profile', AWS_CONFIG_FILE: join(home, 'aws-config'), AWS_SHARED_CREDENTIALS_FILE: join(home, 'aws-credentials'),
        GOOGLE_CLOUD_PROJECT: 'synthetic-project', GOOGLE_APPLICATION_CREDENTIALS: join(home, 'synthetic-google-adc.json'),
      },
    });
    const result = JSON.parse(child.stdout) as { checks: Array<{ provider: string; requests: number }>; fileAttempts: string[] };
    assert.deepEqual(result.checks, ['openai', 'anthropic', 'amazon-bedrock', 'google-vertex'].map(provider => ({ provider, requests: 2 })));
    assert.deepEqual(result.fileAttempts, []);
  } finally { await rm(home, { recursive: true, force: true }); }
});


test('main model completions must be assistant messages before any response is persisted', async () => {
  for (const role of ['user', 'system', 'toolResult']) {
    const writer = new MemoryWriter(); let requests = 0;
    const invalid = { ...assistant('Malformed model response'), role, toolCallId: 'foreign-call', toolName: 'effect', isError: false };
    const instance = runtime(writer, () => { requests++; return streamOf(invalid as ReturnType<typeof assistant>); });
    await assert.rejects(instance.run(input('Only legitimate user input')), /completion must have assistant role/);
    assert.equal(requests, 1); assert.equal(writer.state.records.length, 1);
    assert.deepEqual((writer.state.records[0]!.payload as { message: unknown }).message, input('Only legitimate user input'));
    await assert.rejects(instance.run(input()), /completion must have assistant role/);
  }
});

test('compaction model completions cannot masquerade as user, system or tool-result messages', async () => {
  for (const role of ['user', 'system', 'toolResult']) {
    const writer = new MemoryWriter(); await seed(writer, compactionMessages()); const before = structuredClone(writer.state);
    const invalid = { ...assistant('Invalid role summary'), role, toolCallId: 'foreign-call', toolName: 'effect', isError: false };
    await assert.rejects(runtime(writer, () => streamOf(invalid as ReturnType<typeof assistant>)).compact({ keepRecentTokens: 1 }), /completion must have assistant role/);
    assert.deepEqual(writer.state, before);
  }
});

test('partial batch keeps exact resolved pairs and narrative while new read-only work continues', async () => {
  const writer = new MemoryWriter(); const effects: string[] = []; const requests: TranscriptContext[] = [];
  const batch = toolCalls('resolved', 'uncertain', 'unstarted');
  batch.content.unshift({ type: 'text', text: 'I will first inspect the current state.', textSignature: 'keep-narrative' });
  const query = { ...toolCalls('query-status'), content: [{ type: 'toolCall' as const, id: 'query-status', name: 'query', arguments: {} }] };
  const restored = await runtime(writer, scripted([batch, query, assistant()], (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant()); }), {
    tools: [effectTool(async id => { effects.push(id); if (id === 'uncertain') throw Error('lost response'); return result; }),
      { name: 'query', label: 'query', description: 'Read-only synthetic status lookup', parameters: Type.Object({}), execute: async id => { effects.push(id); return result; } }],
  }).run(input());
  assert.deepEqual(effects, ['resolved', 'uncertain', 'query-status']);
  const second = requests[1]!.messages;
  const projectedBatch = second.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'text' && block.text === 'I will first inspect the current state.'));
  assert.ok(projectedBatch?.role === 'assistant');
  assert.deepEqual(projectedBatch.content.filter(block => block.type === 'toolCall').map(block => block.id), ['resolved']);
  assert.deepEqual(second.find(message => message.role === 'toolResult'), writer.state.executions[0]!.outcome!.payload);
  const original = restored.entries.find(entry => entry.type === 'message' && entry.message.role === 'assistant');
  assert.ok(original?.type === 'message'); assert.deepEqual(original.message, batch);
});

test('matching uncertain arguments are advisory and deliberate new-ID retry records natural-language rationale', async () => {
  const writer = new MemoryWriter(); const effects: string[] = []; const contexts: Parameters<import('@mira/runtime-pi').PiRuntimeOptions['authorize']>[3][] = [];
  const retry = toolCalls('deliberate-retry');
  retry.content.unshift({ type: 'text', text: 'The user asked to try again despite the missing receipt.' });
  await runtime(writer, scripted([toolCalls('first-attempt'), retry, assistant()]), {
    tools: [effectTool(async id => { effects.push(id); if (id === 'first-attempt') throw Error('receipt lost'); return result; })],
    authorize: async (_call, _args, _signal, context) => {
      contexts.push(structuredClone(context));
      return { allowed: true, evidence: { rationale: context.assistantNarrative || 'Initial requested operation' } };
    },
  }).run(input());
  assert.deepEqual(effects, ['first-attempt', 'deliberate-retry']);
  assert.equal(contexts[1]?.priorOperations[0]?.callId, 'first-attempt');
  assert.equal(contexts[1]?.assistantNarrative, 'The user asked to try again despite the missing receipt.');
  assert.deepEqual(writer.state.executions[1]!.intent.authorization, { rationale: contexts[1]!.assistantNarrative });
  assert.equal(writer.state.executions[0]!.outcome, null);
});

test('recovery observations are idempotent, strictly validated, and cannot hide mismatched evidence', async () => {
  const originalWriter = new MemoryWriter();
  await runtime(originalWriter, scripted([toolCalls('missing', 'unstarted'), assistant()]), {
    tools: [effectTool(async () => { throw Error('unknown'); })],
  }).run(input());
  const state = structuredClone(originalWriter.state);
  const recovered = await runtime(originalWriter).recover();
  assert.equal(recovered.snapshot.records.length, state.records.length);
  const corruptions = [
    (entry: Record<string, unknown>) => { entry['customType'] = 'mira.recovery-observation.v2'; },
    (entry: Record<string, unknown>) => { entry['content'] = 'Pretend it succeeded'; },
    (entry: Record<string, unknown>) => { (entry['details'] as { version: number }).version = 2; },
    (entry: Record<string, unknown>) => { (entry['details'] as { operations: { callId: string }[] }).operations[0]!.callId = 'different'; },
  ];
  for (const corrupt of corruptions) {
    const writer = new MemoryWriter(); writer.state = structuredClone(state);
    const notice = writer.state.records.find(record => (record.payload as { type: string }).type === 'custom_message')!;
    corrupt(notice.payload as Record<string, unknown>);
    let requests = 0;
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()));
    assert.equal(requests, 0); assert.equal(writer.state.records.length, state.records.length);
  }
  const writer = new MemoryWriter(); writer.state = structuredClone(state);
  writer.state.executions[0]!.intent.assistantRecordId = 'wrong-assistant';
  await assert.rejects(runtime(writer).recover(), /Execution does not match/);
});

test('full SDK compaction uses sanitized operations and rehydrates uncertainty after summary omission', async () => {
  const writer = new MemoryWriter();
  await runtime(writer, scripted([toolCalls('still-unknown'), assistant('Earlier discussion '.repeat(100))]), {
    tools: [effectTool(async () => { throw Error('lost receipt'); })],
  }).run(input('Old request '.repeat(100)));
  await runtime(writer, scripted([assistant('Recent response '.repeat(30))])).run(input('Latest request '.repeat(40)));
  const raw = structuredClone(writer.state.records);
  const requests: TranscriptContext[] = [];
  const state = await runtime(writer, (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant('A summary that accidentally omits the unresolved operation')); }).compact({ keepRecentTokens: 1 });
  assert.deepEqual(writer.state.records.slice(0, raw.length), raw);
  assert.ok(requests.length > 0); assert.ok(requests.every(context => JSON.stringify(context).includes('still-unknown')));
  assert.match(JSON.stringify(state.messages), /may already have executed/);
  assert.equal(state.messages.some(message => message.role === 'assistant' && message.content.some(block => block.type === 'toolCall')), false);
  await runtime(writer, scripted([assistant('More recent discussion '.repeat(30))])).run(input('More work '.repeat(40)));
  const again = await runtime(writer, () => streamOf(assistant('Another summary omitting uncertainty'))).compact({ keepRecentTokens: 1 });
  assert.match(JSON.stringify(again.messages), /still-unknown/);
  let sawWarning = false;
  await runtime(writer, (_model, context) => { sawWarning = JSON.stringify(context).includes('may already have executed'); return streamOf(assistant()); }).run(input('Continue checking'));
  assert.equal(sawWarning, true);
});

/** Offline atomic-publication fault fixture. Real SQL atomicity is checked by
 * tests/recovery/wake-runtime.test.mts, not inferred from this in-memory class. */
class AtomicWakeWriter extends MemoryWriter implements WakeWriter {
  wake: import('@mira/life').WakeRun = { id: 'wake-run', claimedAt: '2026-10-05T01:00:00.000Z', status: 'running', requests: [], inputRecordId: null, finalRecordId: null };
  afterInput = false;
  afterFinal = false;
  async claimWakeBatch() { return this.wake.status === 'running' ? structuredClone(this.wake) : null; }
  async loadWakeRun(id: string) { assert.equal(id, this.wake.id); return structuredClone(this.wake); }
  async appendWakeInput(id: string, version: number, record: import('@mira/context').RuntimeRecord, signal?: AbortSignal) {
    assert.equal(id, this.wake.id); assert.equal(this.wake.inputRecordId, null);
    const next = await super.append(version, record, signal); this.wake.inputRecordId = record.id;
    if (this.afterInput) { this.afterInput = false; throw Error('lost response after input commit'); }
    return next;
  }
  async appendWakeFinal(id: string, version: number, record: import('@mira/context').RuntimeRecord, signal?: AbortSignal) {
    assert.equal(id, this.wake.id); assert.ok(this.wake.inputRecordId); assert.equal(this.wake.finalRecordId, null);
    const next = await super.append(version, record, signal); this.wake.finalRecordId = record.id;
    if (this.afterFinal) { this.afterFinal = false; throw Error('lost response after final commit'); }
    return next;
  }
  async completeWakeRun(id: string) { assert.equal(id, this.wake.id); assert.ok(this.wake.inputRecordId); assert.ok(this.wake.finalRecordId); this.wake.status = 'completed'; }
}
function turn(writer: AtomicWakeWriter): import('@mira/cognition').CognitionTurn {
  return { id: writer.wake.id, input: 'One durable coalesced wake input', occurredAt: writer.wake.claimedAt, inputRecordId: null, finalRecordId: null };
}

test('cognition atomically links input before model and terminal reply in its awaited subscriber', async () => {
  const writer = new AtomicWakeWriter(); let requests = 0;
  await runtime(writer, () => { requests++; assert.ok(writer.wake.inputRecordId); return streamOf(assistant('Done with this wake')); }).continueTurn(turn(writer));
  assert.equal(requests, 1); assert.ok(writer.wake.finalRecordId);
  assert.equal(writer.state.records.filter(record => (record.payload as { message?: { role: string } }).message?.role === 'user').length, 1);
  assert.equal(writer.state.records.at(-1)!.id, writer.wake.finalRecordId);
});

for (const boundary of ['input', 'final'] as const) test(`cognition recovers ${boundary} commit with lost response using authoritative links`, async () => {
  const writer = new AtomicWakeWriter(); let requests = 0;
  if (boundary === 'input') writer.afterInput = true; else writer.afterFinal = true;
  const stream = () => { requests++; return streamOf(assistant()); };
  await assert.rejects(runtime(writer, stream).continueTurn(turn(writer)), new RegExp(`after ${boundary} commit`));
  const before = writer.state.records.length;
  await runtime(writer, stream).continueTurn({ ...turn(writer), inputRecordId: 'untrusted-input', finalRecordId: 'untrusted-final' });
  assert.equal(requests, 1); assert.ok(writer.wake.finalRecordId);
  assert.equal(writer.state.records.length, before + (boundary === 'input' ? 1 : 0));
  assert.equal(writer.state.records.filter(record => (record.payload as { message?: { role: string } }).message?.role === 'user').length, 1);
});

test('cognition resumes saved provider error without duplicate Wake input or false final association', async () => {
  const writer = new AtomicWakeWriter();
  await assert.rejects(runtime(writer, scripted([{ ...assistant(), stopReason: 'error', errorMessage: 'synthetic provider failure' }])).continueTurn(turn(writer)), /synthetic provider failure/);
  assert.equal(writer.wake.finalRecordId, null); assert.ok(writer.wake.inputRecordId);
  let requests = 0;
  await runtime(writer, (_model, context) => { requests++; assert.match(JSON.stringify(context), /Continue the current persisted Wake/); return streamOf(assistant()); }).continueTurn(turn(writer));
  assert.equal(requests, 1); assert.ok(writer.wake.finalRecordId);
  assert.equal(writer.state.records.filter(record => (record.payload as { message?: { role: string } }).message?.role === 'user').length, 1);
});

test('cognition completes the same Wake after tool uncertainty and records no fabricated failure', async () => {
  const writer = new AtomicWakeWriter(); let effects = 0;
  await runtime(writer, scripted([toolCalls('uncertain-wake-op'), assistant('I can continue while checking the receipt')]), {
    tools: [effectTool(async () => { effects++; throw Error('receipt unavailable'); })],
  }).continueTurn(turn(writer));
  assert.equal(effects, 1); assert.ok(writer.wake.finalRecordId);
  assert.equal(writer.state.executions[0]!.outcome, null);
  assert.equal(writer.state.records.some(record => (record.payload as { message?: { role: string } }).message?.role === 'toolResult'), false);
  await runtime(writer, () => { throw Error('must not request model after saved final'); }).continueTurn(turn(writer));
});


test('cognition rejects changed resumed input configuration and malformed final links before inference', async () => {
  const writer = new AtomicWakeWriter(); writer.afterInput = true;
  await assert.rejects(runtime(writer).continueTurn(turn(writer)), /after input commit/);
  let requests = 0;
  await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).continueTurn({ ...turn(writer), input: 'Changed spool path or inline layout' }), /differs from its durable input/);
  assert.equal(requests, 0); assert.equal(writer.wake.finalRecordId, null);
  writer.wake.finalRecordId = writer.wake.inputRecordId;
  await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).continueTurn({ ...turn(writer), input: '' }), /Wake final link/);
  assert.equal(requests, 0);
});
