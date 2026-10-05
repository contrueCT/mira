import assert from 'node:assert/strict';
import test from 'node:test';
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

test('authorization is mandatory and denied tools never create intent or effect', async () => {
  const writer = new MemoryWriter();
  assert.throws(() => new PiDurableRuntime({ writer, model, streamFn: scripted([]) } as never), /Authorization/);
  let effects = 0, requests = 0, authorizations = 0;
  const instance = runtime(writer, () => { requests++; return streamOf(toolCalls('a', 'b')); }, {
    tools: [effectTool(async () => { effects++; return result; })],
    authorize: async () => { authorizations++; return { allowed: false, reason: 'synthetic denial' }; },
  });
  await assert.rejects(instance.run(input()), /authorization denied/);
  assert.equal(effects, 0); assert.equal(requests, 1); assert.equal(authorizations, 1);
  assert.equal(writer.state.executions.length, 0);
  await assert.rejects(instance.run(input()), /authorization denied/);
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
  await assert.rejects(runtime(writer).run(input()), /reconciliation required/);
});

test('thrown effect is conservatively unknown, never recorded as definitive failure or replayed', async () => {
  const writer = new MemoryWriter(); let effects = 0;
  await assert.rejects(runtime(writer, scripted([toolCalls('a', 'b')]), {
    tools: [effectTool(async () => { effects++; throw Error('lost receipt after effect'); })],
  }).run(input()), /lost receipt/);
  assert.equal(effects, 1); assert.equal(writer.state.executions[0]?.outcome, null);
  let requests = 0;
  await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run(input()), /unknown/);
  assert.equal(requests, 0);
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
