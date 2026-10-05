import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import type { AgentTool, AgentToolCall } from '@earendil-works/pi-agent-core';
import { Type, getCurrentTools, toToolDeclaration, type AssistantMessage, type TranscriptContext } from '@earendil-works/pi-ai';
import { decodeRecords, PiDurableRuntime } from '@mira/runtime-pi';
import { allow, assistant, deferred, input, MemoryWriter, model, result, runtime, streamOf } from '../recovery/fixtures.mts';

function tool(name: string, execute: AgentTool['execute'], parameters = Type.Object({})): AgentTool {
  return { name, label: name, description: `${name} synthetic tool`, parameters, execute };
}
function calls(...requests: Array<[string, string, AgentToolCall['arguments']?]>): AssistantMessage {
  return { ...assistant(), stopReason: 'toolUse', content: requests.map(([id, name, args]) => ({ type: 'toolCall', id, name, arguments: args ?? {} })) };
}
function declarations(writer: MemoryWriter, context: TranscriptContext, tools: AgentTool[]): void {
  const expected = tools.map(toToolDeclaration);
  assert.deepEqual(getCurrentTools(context.messages), expected);
  const messages = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
  assert.deepEqual(getCurrentTools(messages), expected, 'provider declarations have already been durably persisted');
}

test('same run loads a tool at the settled-batch boundary and the next model calls its declared executable', async () => {
  const writer = new MemoryWriter();
  const atLastResult = deferred(), releaseLastResult = deferred(), atPreparation = deferred(), activate = deferred();
  let pending = false, disposed = false, prepared = 0, requests = 0;
  const effects: string[] = [];
  const authorizations: Array<{ call: AgentToolCall; args: unknown }> = [];
  const added = { ...tool('new_tool', async (_id, args) => {
    assert.deepEqual(args, { count: 7 }); effects.push('new'); return result;
  }, Type.Object({ count: Type.Number() })), constrainedSampling: { type: 'json_schema' as const, strict: 'require' as const } };
  const load = tool('load_extension', async () => { pending = true; effects.push('load'); return result; });
  const old = tool('old_tool', async () => { assert.equal(disposed, false); effects.push('old'); return result; });
  writer.beforeAppend = async record => {
    const entry = decodeRecords([record], record.parentId)[0]!;
    if (entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolCallId === 'old-call') {
      atLastResult.resolve(); await releaseLastResult.promise;
    }
  };
  const instance = runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) { declarations(writer, context, [load, old]); return streamOf(calls(['load-call', load.name], ['old-call', old.name])); }
    declarations(writer, context, [added]);
    if (requests === 2) {
      assert.equal(context.messages.filter(message => message.role === 'toolResult').length, 2);
      return streamOf(calls(['new-call', added.name, { count: '7' }]));
    }
    assert.equal(requests, 3);
    return streamOf(assistant('Finished in this run'));
  }, {
    tools: [tool('unused_static_fallback', async () => { assert.fail('dynamic callback is the full registry'); })],
    prepareTools: async signal => {
      assert.equal(signal.aborted, false); prepared++;
      if (!pending) return [load, old];
      atPreparation.resolve(); await activate.promise;
      signal.throwIfAborted(); disposed = true;
      return [added];
    },
    authorize: async (call, args) => { authorizations.push({ call, args }); return { allowed: true, evidence: { synthetic: 'same user authorization path' } }; },
  });
  const work = instance.run(input());
  await atLastResult.promise; await setImmediate();
  assert.deepEqual(effects, ['load', 'old']); assert.equal(prepared, 1); assert.equal(requests, 1); assert.equal(disposed, false);
  releaseLastResult.resolve(); await atPreparation.promise; await setImmediate();
  assert.equal(prepared, 2); assert.equal(requests, 1); assert.equal(disposed, false);
  assert.equal(writer.state.executions.filter(execution => execution.outcome).length, 2);
  activate.resolve();
  const recovered = await work;
  assert.deepEqual(effects, ['load', 'old', 'new']); assert.equal(requests, 3); assert.equal(prepared, 3);
  assert.deepEqual(authorizations.map(item => [item.call.id, item.args]), [['load-call', {}], ['old-call', {}], ['new-call', { count: 7 }]]);
  const execution = writer.state.executions.find(item => item.intent.callId === 'new-call')!;
  assert.deepEqual(execution.intent.requestedArguments, { count: '7' });
  assert.deepEqual(execution.intent.arguments, { count: 7 });
  assert.deepEqual(execution.intent.authorization, { synthetic: 'same user authorization path' });
  assert.ok(execution.outcome);
  assert.equal(recovered.messages.at(-1)?.role, 'assistant');
  assert.ok(recovered.entries.every(entry => entry.type === 'message'), 'uses existing Pi declaration history only');
  await assert.rejects(instance.run(), /Cannot continue from message role: assistant/);
  assert.equal(requests, 3, 'a terminal reply is never reopened');
});

test('same-name schema replacement and removal use one registry per complete batch', async () => {
  const writer = new MemoryWriter(); let generation = 0, requests = 0;
  const effects: string[] = [];
  const newer = tool('replaceable', async (_id, args) => { assert.deepEqual(args, { count: 9 }); effects.push('new'); generation = 2; return result; }, Type.Object({ count: Type.Number() }));
  newer.description = 'replaceable generation 2';
  const older = tool('replaceable', async (_id, args) => { assert.deepEqual(args, { text: 'old' }); effects.push('old'); generation = 1; return result; }, Type.Object({ text: Type.String() }));
  await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) { declarations(writer, context, [older]); return streamOf(calls(['old-a', older.name, { text: 'old' }], ['old-b', older.name, { text: 'old' }])); }
    if (requests === 2) { declarations(writer, context, [newer]); return streamOf(calls(['new-a', newer.name, { count: '9' }])); }
    declarations(writer, context, []); return streamOf(assistant());
  }, { prepareTools: async () => generation === 0 ? [older] : generation === 1 ? [newer] : [] }).run(input());
  assert.equal(requests, 3); assert.deepEqual(effects, ['old', 'old', 'new']);
  const deltas = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
  assert.equal(deltas.length, 3);
  assert.deepEqual(deltas[1]!.toolsRemoved, [{ name: 'replaceable' }]);
  assert.deepEqual(deltas[1]!.toolsAdded, [toToolDeclaration(newer)]);
  assert.deepEqual(deltas[2]!.toolsRemoved, [{ name: 'replaceable' }]);
  assert.deepEqual(getCurrentTools((await runtime(writer).recover()).messages), []);
});

test('code-only generation changes are visible through the source description revision', async () => {
  const writer = new MemoryWriter(); let generation = 0, requests = 0;
  const effects: number[] = [];
  const versions = [0, 1].map(version => ({ ...tool('same_schema', async () => { effects.push(version); generation = 1; return result; }), description: `same tool; extension generation ${version}` }));
  await runtime(writer, (_model, context) => {
    declarations(writer, context, [versions[generation]!]);
    requests++; return streamOf(requests < 3 ? calls([`version-${requests}`, 'same_schema']) : assistant());
  }, { prepareTools: async () => [versions[generation]!] }).run(input());
  assert.deepEqual(effects, [0, 1]);
  const states = decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'system' ? [entry.message] : []);
  assert.equal(states.length, 2); assert.deepEqual(states[1]!.toolsAdded, [toToolDeclaration(versions[1]!)]);
});

for (const invalid of ['duplicate', 'prepareArguments'] as const) {
  for (const phase of ['initial', 'next'] as const) test(`dynamic ${invalid} rejects at ${phase} preparation before a mismatched request/effect`, async () => {
    const writer = new MemoryWriter(); let preparations = 0, requests = 0, effects = 0;
    const valid = tool('existing', async () => { effects++; return result; });
    const registry = invalid === 'duplicate' ? [valid, valid] : [{ ...valid, prepareArguments: (args: unknown) => args }];
    const instance = runtime(writer, () => { requests++; return streamOf(calls(['first', valid.name])); }, {
      prepareTools: async () => ++preparations === 1 && phase === 'next' ? [valid] : registry,
    });
    await assert.rejects(instance.run(input()), invalid === 'duplicate' ? /Duplicate registered tool/ : /prepareArguments/);
    assert.equal(requests, phase === 'initial' ? 0 : 1); assert.equal(effects, requests);
    await assert.rejects(instance.recover(), invalid === 'duplicate' ? /Duplicate registered tool/ : /prepareArguments/);
  });
}

test('dynamic preparation failure after a durable batch does not manufacture an outcome or reopen the model', async () => {
  const writer = new MemoryWriter(); let requests = 0, preparations = 0;
  const existing = tool('existing', async () => result);
  const instance = runtime(writer, () => { requests++; return streamOf(calls(['known', existing.name])); }, {
    prepareTools: async () => { if (++preparations > 1) throw Error('activation failed'); return [existing]; },
  });
  await assert.rejects(instance.run(input()), /activation failed/);
  assert.equal(requests, 1); assert.equal(writer.state.executions.length, 1); assert.ok(writer.state.executions[0]!.outcome);
  const recovered = await runtime(writer).recover();
  assert.equal(recovered.recovery.status, 'complete'); assert.equal(recovered.messages.at(-1)?.role, 'toolResult');
});

test('dynamic unknown effects retain recovery evidence after registry removal without replay', async () => {
  const writer = new MemoryWriter(); let generation = 0, requests = 0, effects = 0;
  const loaded = tool('loaded_effect', async () => { effects++; generation = 2; throw Error('lost receipt after effect'); });
  const load = tool('load_extension', async () => { generation = 1; return result; });
  const recovered = await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) { declarations(writer, context, [load]); return streamOf(calls(['load', load.name])); }
    if (requests === 2) { declarations(writer, context, [loaded]); return streamOf(calls(['unknown', loaded.name], ['never-started', loaded.name])); }
    declarations(writer, context, []);
    assert.match(JSON.stringify(context.messages), /may already have executed/);
    assert.match(JSON.stringify(context.messages), /Execution did not start/);
    assert.equal(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'unknown'), false);
    return streamOf(assistant('Check the unknown operation before deciding what to do next'));
  }, { prepareTools: async () => generation === 0 ? [load] : generation === 1 ? [loaded] : [] }).run(input());
  assert.equal(requests, 3); assert.equal(effects, 1);
  assert.deepEqual(recovered.recovery.operations.map(operation => [operation.callId, operation.status]), [['unknown', 'outcome-unknown'], ['never-started', 'not-started']]);
  assert.equal(writer.state.executions.find(execution => execution.intent.callId === 'unknown')!.outcome, null);
  assert.deepEqual((await runtime(writer).recover()).recovery, recovered.recovery);
});

test('a removed tool cannot dispatch through a stale dynamic registry and recovery records not-started', async () => {
  const writer = new MemoryWriter(); let removed = false, requests = 0, effects = 0;
  const existing = tool('removed', async () => { effects++; removed = true; return result; });
  await assert.rejects(runtime(writer, (_model, context) => {
    declarations(writer, context, removed ? [] : [existing]);
    return streamOf(calls([`call-${++requests}`, existing.name]));
  }, { prepareTools: async () => removed ? [] : [existing] }).run(input()), /did not produce a durable outcome/);
  assert.equal(requests, 2); assert.equal(effects, 1);
  const recovered = await runtime(writer).recover();
  assert.deepEqual(recovered.recovery.operations.map(operation => [operation.callId, operation.status]), [['call-2', 'not-started']]);
});

test('cancellation while activation is pending prevents declarations and inference', async () => {
  const writer = new MemoryWriter(); const entered = deferred(), release = deferred(); const controller = new AbortController(); let requests = 0;
  const instance = new PiDurableRuntime({ writer, model, authorize: allow,
    streamFn: () => { requests++; return streamOf(assistant()); },
    prepareTools: async signal => { entered.resolve(); await release.promise; assert.equal(signal.aborted, true); return [tool('never', async () => result)]; },
  });
  const work = instance.run(input(), controller.signal); await entered.promise;
  controller.abort(Error('cancel pending activation')); release.resolve();
  await assert.rejects(work, /cancel pending activation/);
  assert.equal(requests, 0); assert.deepEqual(writer.state.records, []);
});

for (const phase of ['terminal', 'initial-preparation', 'next-preparation', 'provider'] as const) test(`final registry lease is released once and awaited after ${phase}`, async () => {
  const writer = new MemoryWriter(); const cleanup = deferred(), released = deferred();
  let preparations = 0, finishes = 0, requests = 0, completed = false;
  const existing = tool('existing', async () => result);
  const instance = runtime(writer, () => {
    requests++;
    if (phase === 'provider') return streamOf({ ...assistant(), stopReason: 'error', errorMessage: 'provider failed' });
    return streamOf(phase === 'next-preparation' ? calls(['complete-batch', existing.name]) : assistant());
  }, {
    prepareTools: async () => {
      preparations++;
      if (phase === 'initial-preparation' || (phase === 'next-preparation' && preparations === 2)) throw Error('preparation failed');
      return [existing];
    },
    finishTools: async () => { finishes++; cleanup.resolve(); await released.promise; },
  });
  const work = instance.run(input());
  const completion = work.then(() => { completed = true; }, () => { completed = true; });
  await cleanup.promise; await setImmediate(); assert.equal(finishes, 1); assert.equal(completed, false);
  assert.equal(requests, phase === 'initial-preparation' ? 0 : 1);
  released.resolve();
  if (phase === 'terminal') await work;
  else await assert.rejects(work, /preparation failed|provider failed/);
  await completion; assert.equal(finishes, 1);
});

test('interrupted dynamic attempts release their own generation before recovery acquires the next', async () => {
  const writer = new MemoryWriter(); const trace: string[] = []; let requests = 0;
  const existing = tool('existing', async () => { trace.push('unknown-effect'); throw Error('unknown remote result'); });
  await runtime(writer, () => streamOf(++requests === 1 ? calls(['unknown', existing.name]) : assistant()), {
    prepareTools: async () => { trace.push('prepare'); return [existing]; },
    finishTools: async () => { trace.push('finish'); },
  }).run(input());
  assert.deepEqual(trace, ['prepare', 'unknown-effect', 'finish', 'prepare', 'finish']);
});

test('newly loaded tool authorization deferral creates no intent/effect and retains its reason', async () => {
  const writer = new MemoryWriter(); let loaded = false, requests = 0, effects = 0;
  const added = tool('requires_decision', async () => { effects++; return result; });
  const load = tool('load_extension', async () => { loaded = true; return result; });
  const recovered = await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) return streamOf(calls(['load', load.name]));
    declarations(writer, context, [added]);
    if (requests === 2) return streamOf(calls(['deferred', added.name]));
    assert.match(JSON.stringify(context), /Need a destination from the user/);
    return streamOf(assistant('Which destination?'));
  }, {
    prepareTools: async () => loaded ? [added] : [load],
    authorize: async call => call.name === added.name ? { allowed: false, reason: 'Need a destination from the user' } : { allowed: true, evidence: { synthetic: true } },
  }).run(input());
  assert.equal(requests, 3); assert.equal(effects, 0);
  assert.deepEqual(writer.state.executions.map(execution => execution.intent.callId), ['load']);
  assert.equal(recovered.recovery.operations[0]!.status, 'not-started');
  assert.equal(recovered.recovery.operations[0]!.reason, 'Need a destination from the user');
});

test('mutating the source schema after declaration cannot change validation in the published batch', async () => {
  const writer = new MemoryWriter(); let requests = 0;
  const observed: unknown[] = [];
  const schema = Type.Object({ count: Type.String() });
  const source: AgentTool = { ...tool('mutable', async (_id, args) => { observed.push(args); return result; }, schema), constrainedSampling: { type: 'json_schema', strict: 'require' } };
  await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) {
      const declared = getCurrentTools(context.messages)[0]!;
      assert.equal((declared.parameters as unknown as { properties: { count: { type: string } } }).properties.count.type, 'string');
      // Mutate the original definition only after provider/declaration publication.
      (schema.properties as Record<string, unknown>)['count'] = Type.Number();
      source.constrainedSampling = { type: 'json_schema', strict: 'prefer' };
      return streamOf(calls(['old-schema', 'mutable', { count: '7' }]));
    }
    const declaration = getCurrentTools(context.messages)[0]!;
    assert.equal((declaration.parameters as unknown as { properties: { count: { type: string } } }).properties.count.type, 'number');
    assert.deepEqual(declaration.constrainedSampling, { type: 'json_schema', strict: 'prefer' });
    if (requests === 2) return streamOf(calls(['new-schema', 'mutable', { count: '8' }]));
    return streamOf(assistant());
  }, { prepareTools: async () => [source] }).run(input());
  assert.deepEqual(observed, [{ count: '7' }, { count: 8 }]);
  assert.deepEqual(writer.state.executions.map(item => item.intent.arguments), observed);
});

for (const dynamic of [false, true]) test(`${dynamic ? 'dynamic' : 'static'} class tools retain prototype metadata and original private receiver`, async () => {
  const writer = new MemoryWriter(); let requests = 0;
  class ClassTool implements AgentTool {
    #calls = 0;
    get name() { return 'class_tool'; }
    get label() { return 'Class tool'; }
    get description() { return 'Prototype description'; }
    get parameters() { return Type.Object({}); }
    async execute() { this.#calls++; return { content: [{ type: 'text' as const, text: `private count ${this.#calls}` }], details: {} }; }
    calls() { return this.#calls; }
  }
  const source = new ClassTool();
  await runtime(writer, (_model, context) => {
    requests++;
    assert.equal(getCurrentTools(context.messages)[0]!.name, 'class_tool');
    assert.equal(getCurrentTools(context.messages)[0]!.description, 'Prototype description');
    if (requests === 1) return streamOf(calls(['class-call', 'class_tool']));
    return streamOf(assistant());
  }, dynamic ? { prepareTools: async () => [source] } : { tools: [source] }).run(input());
  assert.equal(source.calls(), 1);
  assert.equal(writer.state.executions.length, 1);
  assert.ok(writer.state.executions[0]!.outcome);
  assert.equal((await runtime(writer).recover()).recovery.status, 'complete');
});
