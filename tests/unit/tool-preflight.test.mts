import assert from 'node:assert/strict';
import test from 'node:test';
import { Type } from '@earendil-works/pi-ai';
import { observationText, validatePreparationDiagnostic } from '../../packages/runtime-pi/src/observations.ts';
import { toolPreflight } from '../../packages/runtime-pi/src/tool-preflight.ts';
import { assistant, effectTool, input, result, runtime, streamOf, MemoryWriter, seed, scripted } from '../recovery/fixtures.mts';

for (const limit of [12000, 10000, 9000]) test(`argument rejection ${limit} explains the 8192 limit and continues cognition with a corrected new call`, async () => {
  const writer = new MemoryWriter(); const effects: string[] = []; let requests = 0;
  const tool = effectTool(async id => { effects.push(id); return result; });
  tool.parameters = Type.Object({ max_output_bytes: Type.Integer({ minimum: 4, maximum: 8192 }) });
  const recovered = await runtime(writer, (_model, context) => {
    if (++requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
      { type: 'toolCall', id: 'done-before', name: 'effect', arguments: { max_output_bytes: 100 } },
      { type: 'toolCall', id: 'bad', name: 'effect', arguments: { max_output_bytes: limit } },
      { type: 'toolCall', id: 'unstarted-sibling', name: 'effect', arguments: { max_output_bytes: 100 } },
    ] });
    const messages = JSON.stringify(context.messages);
    assert.match(messages, /invalid-arguments/); assert.match(messages, /maximum/); assert.match(messages, /8192/);
    assert.match(messages, /No execution started/);
    if (requests === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'corrected-new-call', name: 'effect', arguments: { max_output_bytes: 8192 } }] });
    assert.equal(requests, 3); return streamOf(assistant('The corrected operation completed'));
  }, { tools: [tool] }).run(input());
  assert.deepEqual(effects, ['done-before', 'corrected-new-call']);
  assert.deepEqual(writer.state.executions.map(e => e.intent.callId), effects);
  assert.deepEqual(recovered.recovery.operations.map(op => op.status), ['not-started', 'not-started']);
  assert.deepEqual(recovered.recovery.operations[0]!.diagnostic, { phase: 'prepare', category: 'invalid-arguments', issues: [{ path: '/max_output_bytes', keyword: 'maximum', limit: 8192 }] });
  assert.equal(recovered.recovery.operations[1]!.diagnostic, undefined);
  assert.deepEqual((await runtime(writer).recover()).recovery, recovered.recovery);
});

test('an unavailable tool is explained before execution and Mira can choose an available tool', async () => {
  const writer = new MemoryWriter(); let requests = 0, effects = 0;
  const recovered = await runtime(writer, (_model, context) => {
    if (++requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'missing', name: 'absent', arguments: {} }] });
    assert.match(JSON.stringify(context.messages), /tool-not-found/);
    if (requests === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'available', name: 'effect', arguments: {} }] });
    return streamOf(assistant());
  }, { tools: [effectTool(async () => { effects++; return result; })] }).run(input());
  assert.equal(requests, 3); assert.equal(effects, 1);
  assert.deepEqual(recovered.recovery.operations[0]!.diagnostic, { phase: 'prepare', category: 'tool-not-found' });
});

test('preflight preserves public SDK coercion and does not mutate requested arguments', () => {
  const tool = effectTool(async () => result); tool.parameters = Type.Object({ count: Type.Integer(), note: Type.Optional(Type.String()) });
  const call = { type: 'toolCall' as const, id: 'normalized', name: 'effect', arguments: { count: '3', note: null } };
  assert.equal(toolPreflight([tool], call), undefined); assert.deepEqual(call.arguments, { count: '3', note: null });
});

test('diagnostics contain only bounded schema constraints, never received values or dynamic property names', () => {
  const secret = 'synthetic-private-secret'; const tool = effectTool(async () => result);
  tool.parameters = Type.Object({ nested: Type.Object({ value: Type.Integer({ maximum: 4 }) }, { additionalProperties: false }), choice: Type.Union([Type.Literal('a'), Type.Literal('b')]) });
  const diagnostic = toolPreflight([tool], { type: 'toolCall', id: 'invalid', name: 'effect', arguments: { nested: { [secret]: secret, value: 10 }, choice: secret } })!;
  validatePreparationDiagnostic(diagnostic);
  assert.ok(!JSON.stringify(diagnostic).includes(secret)); assert.ok(JSON.stringify(diagnostic).length <= 2048);
  assert.match(JSON.stringify(diagnostic), /maximum/);
  assert.ok(!observationText([{ callId: 'invalid', assistantRecordId: 'record', toolName: 'effect', requestedArguments: {}, status: 'not-started', diagnostic }]).includes(secret));
});

test('validator configuration failures stay fatal', () => {
  const tool = effectTool(async () => result);
  Object.defineProperty(tool, 'parameters', { get() { throw Error('synthetic validator configuration fault'); } });
  assert.throws(() => toolPreflight([tool], { type: 'toolCall', id: 'invalid-schema', name: 'effect', arguments: {} }), /configuration fault/);
});

for (const issues of [ [{ path: '/x', keyword: 'maximum', limit: Infinity }], [{ path: '/x', keyword: 'type', expected: 'secret' }], [{ path: '/x', keyword: 'maximum', message: 'secret' }], Array.from({length: 9}, () => ({path: '/x', keyword: 'maximum', limit: 1})) ]) test('malformed preparation diagnostics fail strict recovery validation', () => {
  assert.throws(() => validatePreparationDiagnostic({ phase: 'prepare', category: 'invalid-arguments', issues }));
});

test('failed rejection-observation publication stays fatal and never executes or infers again', async () => {
  const writer = new MemoryWriter(); let requests = 0, effects = 0;
  writer.beforeAppend = async record => { if ((record.payload as { type?: string }).type === 'custom_message') throw Error('synthetic persistence fault'); };
  const tool = effectTool(async () => { effects++; return result; }); tool.parameters = Type.Object({ n: Type.Number() });
  await assert.rejects(runtime(writer, () => { requests++; return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{type:'toolCall',id:'bad',name:'effect',arguments:{n:'invalid'}}] }); }, {tools:[tool]}).run(input()), /synthetic persistence fault/);
  assert.equal(requests, 1); assert.equal(effects, 0); assert.equal(writer.state.executions.length, 0);
});


test('compaction retains an unfinished turn’s preparation reasons and exact original history without replay', async () => {
  const writer = new MemoryWriter();
  await assert.rejects(runtime(writer, scripted([
    { ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'missing', name: 'absent', arguments: {} }] },
    { ...assistant(), content: [], stopReason: 'error', errorMessage: 'Synthetic interruption before final' },
  ])).run(input('Older context '.repeat(300))), /Synthetic interruption before final/);
  const original = await runtime(writer).recover();
  await seed(writer, [input('Supplemental details '.repeat(300))]);
  const records = structuredClone(writer.state.records);
  const compacted = await runtime(writer, (_model, context) => { assert.match(JSON.stringify(context.messages), /tool-not-found/); return streamOf(assistant('Short summary')); }).compact({keepRecentTokens:1});
  assert.deepEqual(compacted.snapshot.records.slice(0, records.length), records);
  assert.deepEqual(compacted.recovery, original.recovery);
  assert.match(JSON.stringify(compacted.messages), /tool-not-found/);
  assert.deepEqual((await runtime(writer).recover()).recovery, original.recovery);
});

test('task-scoped child continues and completes after a preparation rejection', async () => {
  const { TaskMemoryWriter } = await import('../recovery/task-input-fixture.mts');
  const writer = new TaskMemoryWriter(); let requests = 0, effects = 0;
  const tool = effectTool(async () => { effects++; return result; }); tool.parameters = Type.Object({ n: Type.Number() });
  await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{type:'toolCall',id:'bad',name:'effect',arguments:{n:'invalid'}}] });
    assert.match(JSON.stringify(context.messages), /invalid-arguments/);
    if (requests === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{type:'toolCall',id:'corrected',name:'effect',arguments:{n:1}}] });
    return streamOf(assistant('Task completed'));
  }, { tools: [tool], compactionScope: 'task' }).continueTaskTurn({ id: writer.task.id, input: 'Delegated synthetic task', onInput: writer.onInput });
  assert.equal(requests, 3); assert.equal(effects, 1); assert.ok(writer.task.finalRecordId);
  assert.equal(writer.state.executions[0]!.intent.callId, 'corrected');
});

test('preflight uses the declared generation even if the caller changes a dynamic tool schema during assistant publication', async () => {
  const writer = new MemoryWriter(); let requests = 0; const effects: string[] = [];
  const tool = effectTool(async id => { effects.push(id); return result; });
  tool.parameters = Type.Object({ n: Type.Integer({maximum:8192}) });
  writer.beforeAppend = async record => {
    if (JSON.stringify(record.payload).includes('old-call')) tool.parameters = Type.Object({n:Type.Integer({maximum:16384})});
  };
  const recovered = await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{type:'toolCall',id:'old-call',name:'effect',arguments:{n:9000}}] });
    assert.match(JSON.stringify(context.messages), /8192/);
    if (requests === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{type:'toolCall',id:'new-generation-call',name:'effect',arguments:{n:9000}}] });
    return streamOf(assistant());
  }, { prepareTools: async () => [tool] }).run(input());
  assert.equal(requests, 3); assert.deepEqual(effects, ['new-generation-call']);
  assert.deepEqual(recovered.recovery.operations[0]!.diagnostic, { phase: 'prepare', category: 'invalid-arguments', issues: [{path:'/n',keyword:'maximum',limit:8192}] });
});

for (const optional of [undefined, null]) test('rejected coerced integer reports the normalized numeric limit and omits accepted optional-null fields', () => {
  const tool = effectTool(async () => result); tool.parameters = Type.Object({ n: Type.Integer({ maximum: 8192 }), optional: Type.Optional(Type.String()) });
  const diagnostic = toolPreflight([tool], {type:'toolCall',id:'coerced-rejection',name:'effect',arguments:{n:'9000',...(optional === null ? {optional:null} : {})}});
  assert.deepEqual(diagnostic, {phase:'prepare',category:'invalid-arguments',issues:[{path:'/n',keyword:'maximum',limit:8192}]});
});

for (const [before, after] of [[16384,8192], [8192,16384]] as const) test(`natural registry refresh ${before} to ${after} uses the exact current declaration in the same Agent`, async () => {
  const writer = new MemoryWriter(); let requests = 0, generations = 0; const effects: string[] = [];
  const tool = effectTool(async id => { effects.push(id); return result; });
  const recovered = await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) return streamOf({...assistant(),stopReason:'toolUse',content:[{type:'toolCall',id:'first',name:'effect',arguments:{n:1}}]});
    if (requests === 2) return streamOf({...assistant(),stopReason:'toolUse',content:[{type:'toolCall',id:'second',name:'effect',arguments:{n:9000}}]});
    if (after === 8192) assert.match(JSON.stringify(context.messages), /invalid-arguments/);
    return streamOf(assistant());
  }, {prepareTools: async () => [{...tool, parameters:Type.Object({n:Type.Integer({maximum:++generations === 1 ? before : after})})}]}).run(input());
  assert.equal(requests,3);
  assert.deepEqual(effects, after === 8192 ? ['first'] : ['first','second']);
  assert.equal(recovered.recovery.operations.length, after === 8192 ? 1 : 0);
});

for (const value of [
  {phase:'prepare',category:['tool-not-found']},
  {phase:'prepare',category:'invalid-arguments',issues:[{path:'/n',keyword:['maximum'],limit:8192}]},
  {phase:'prepare',category:'invalid-arguments',issues:[{path:'/n',keyword:'type',expected:['integer']}]},
]) test('preparation diagnostic discriminator arrays are rejected instead of string-coerced', () => {
  assert.throws(() => validatePreparationDiagnostic(value));
});

test('tuple or reference constraints are not attached to a truncated parent path', () => {
  const tool = effectTool(async () => result); tool.parameters = Type.Object({ values:Type.Tuple([Type.Integer({maximum:4})]) });
  const diagnostic = toolPreflight([tool], {type:'toolCall',id:'tuple',name:'effect',arguments:{values:[10]}})!;
  assert.equal(diagnostic.category,'invalid-arguments');
  assert.ok(!JSON.stringify(diagnostic).includes('maximum'), 'unsupported nested paths retain a generic rejection');
});

for (const nested of [false, true]) test('ambiguous SDK labels from dotted property names never blame a valid nested field', () => {
  const shape = Type.Object({'a.b':Type.Integer({maximum:4}), a:Type.Object({b:Type.Integer({maximum:4})})});
  const tool = effectTool(async () => result); tool.parameters = nested ? Type.Object({outer:shape}) : shape;
  const args = {'a.b':10,a:{b:1}};
  const diagnostic = toolPreflight([tool], {type:'toolCall',id:'ambiguous',name:'effect',arguments:nested?{outer:args}:args});
  assert.deepEqual(diagnostic,{phase:'prepare',category:'invalid-arguments'});
});

test('the root label is ambiguous when the schema declares a property named root', () => {
  const tool = effectTool(async () => result); tool.parameters = Type.Object({root:Type.Object({n:Type.Number()})});
  assert.deepEqual(toolPreflight([tool], {type:'toolCall',id:'root-label',name:'effect',arguments:{root:1}}),{phase:'prepare',category:'invalid-arguments'});
});
