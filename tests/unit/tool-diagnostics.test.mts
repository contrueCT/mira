import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { DurableOperationError } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import { decodeRecords, type RecoveryOperation } from '@mira/runtime-pi';
import { normalizeToolResult } from '../../packages/runtime-pi/src/records.ts';
import { observationText } from '../../packages/runtime-pi/src/observations.ts';
import { PersistenceFailureNotice } from '../../apps/server/src/persistence-errors.ts';
import { assistant, effectTool, input, result, runtime, scripted, seed, streamOf, toolCalls, MemoryWriter } from '../recovery/fixtures.mts';

const secret = 'synthetic-tool-secret-do-not-save';

test('tool rejection records only a fixed diagnostic before continuing, survives restart, and never replays siblings', async () => {
  const writer = new MemoryWriter(); const effects: string[] = []; let requests = 0;
  const recovered = await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) return streamOf(toolCalls('a', 'b'));
    assert.match(JSON.stringify(context.messages), /execution-rejected/);
    assert.ok(!JSON.stringify(context.messages).includes(secret));
    assert.ok(!context.messages.some(message => message.role === 'toolResult'));
    return streamOf(assistant('Check the remote state before deciding whether to retry'));
  }, { tools: [effectTool(async id => {
    effects.push(id);
    throw new Error(`Authorization: Bearer ${secret}`, { cause: { headers: { cookie: secret }, arguments: { secret } } });
  })] }).run(input());
  assert.equal(requests, 2); assert.deepEqual(effects, ['a']);
  assert.deepEqual(recovered.recovery.operations[0]?.diagnostic,
    { phase: 'execute', category: 'execution-rejected' });
  assert.ok(!Object.hasOwn(recovered.recovery.operations[1]!, 'diagnostic'));
  assert.equal(writer.state.executions[0]?.outcome, null);
  assert.ok(!JSON.stringify(writer.state).includes(secret));
  const restarted = await runtime(writer).recover();
  assert.deepEqual(restarted.recovery, recovered.recovery);
});

for (const value of [Infinity, -Infinity, NaN]) test(`nonfinite tool result ${String(value)} records an honest diagnostic without outcome`, async () => {
  const writer = new MemoryWriter(); const effects: string[] = [];
  const recovered = await runtime(writer, scripted([toolCalls('a', 'b'), assistant('The returned result was unusable')]), {
    tools: [effectTool(async id => { effects.push(id); return { ...result, details: { measurement: value, secret } }; })],
  }).run(input());
  assert.deepEqual(effects, ['a']);
  assert.equal(writer.state.executions[0]?.outcome, null);
  assert.deepEqual(recovered.recovery.operations[0]?.diagnostic,
    { phase: 'result', category: 'non-finite-result' });
  assert.ok(!JSON.stringify(writer.state).includes(secret));
  assert.ok(!Object.hasOwn(recovered.recovery.operations[1]!, 'diagnostic'));
  assert.deepEqual((await runtime(writer).recover()).recovery, recovered.recovery);
});

const invalidReturns: Array<[string, () => unknown, 'invalid-json-result' | 'non-finite-result']> = [
  ['null', () => null, 'invalid-json-result'],
  ['undefined', () => undefined, 'invalid-json-result'],
  ['bigint', () => 1n, 'invalid-json-result'],
  ['Infinity', () => Infinity, 'non-finite-result'],
  ['-Infinity', () => -Infinity, 'non-finite-result'],
  ['NaN', () => NaN, 'non-finite-result'],
  ['string', () => secret, 'invalid-json-result'],
  ['function', () => () => secret, 'invalid-json-result'],
  ['boolean', () => true, 'invalid-json-result'],
  ['finite number', () => 1, 'invalid-json-result'],
  ['array', () => [], 'invalid-json-result'],
  ['string content', () => ({ content: secret, details: {} }), 'invalid-json-result'],
  ['invalid content block', () => ({ content: [{ type: 'text', text: { secret } }], details: {} }), 'invalid-json-result'],
  ['nonboolean isError', () => ({ ...result, isError: secret }), 'invalid-json-result'],
  ['null isError', () => ({ ...result, isError: null }), 'invalid-json-result'],
  ['nonboolean terminate', () => ({ ...result, terminate: secret }), 'invalid-json-result'],
  ['invalid usage', () => ({ ...result, usage: { secret } }), 'invalid-json-result'],
];
for (const key of ['isError', 'content', 'details', 'usage', 'structuredContent', 'terminate']) {
  for (const enumerable of [false, true]) invalidReturns.push([`throwing ${enumerable ? 'enumerable' : 'non-enumerable'} ${key} accessor`, () => Object.defineProperty({ ...result }, key, {
    enumerable, get() { throw new Error(`Authorization: Bearer ${secret}`, { cause: { secret } }); },
  }), 'invalid-json-result']);
}
for (const [label, returned, category] of invalidReturns) test(`invalid root tool return (${label}) is rejected before Pi can synthesize an outcome`, async () => {
  const writer = new MemoryWriter(); const effects: string[] = []; let requests = 0;
  const recovered = await runtime(writer, (_model, context) => {
    requests++;
    if (requests === 1) return streamOf(toolCalls('a', 'b'));
    assert.equal(requests, 2, 'recovery continues cognition without replaying the batch');
    assert.match(JSON.stringify(context.messages), new RegExp(category));
    assert.ok(!context.messages.some(message => message.role === 'toolResult'));
    assert.ok(!JSON.stringify(context.messages).includes(secret));
    return streamOf(assistant('Inspect the external state before a deliberate new call'));
  }, { tools: [effectTool(async id => {
    effects.push(id);
    // Deliberately untyped extension return at the real public Pi execution boundary.
    return returned() as AgentToolResult;
  })] }).run(input());
  assert.equal(requests, 2); assert.deepEqual(effects, ['a']);
  assert.equal(writer.state.executions.length, 1);
  assert.equal(writer.state.executions[0]?.outcome, null);
  assert.deepEqual(recovered.recovery.operations.map(operation => operation.status), ['outcome-unknown', 'not-started']);
  assert.deepEqual(recovered.recovery.operations[0]?.diagnostic, { phase: 'result', category });
  assert.ok(!Object.hasOwn(recovered.recovery.operations[1]!, 'diagnostic'));
  assert.ok(!JSON.stringify(writer.state).includes(secret));
  assert.deepEqual((await runtime(writer).recover()).recovery, recovered.recovery);
  assert.deepEqual(effects, ['a'], 'fresh recovery never replays the unknown effect or its sibling');
});

for (const enumerable of [false, true]) test(`Pi receives a single canonical snapshot of successful ${enumerable ? 'enumerable' : 'non-enumerable'} result accessors`, async () => {
  const writer = new MemoryWriter(); const reads = new Map<string, number>();
  const usage = assistant().usage;
  const returned = { ...result, usage, isError: false, terminate: false,
    structuredContent: { receipt: 'programmatic result' } };
  for (const [key, value] of Object.entries(returned)) Object.defineProperty(returned, key, {
    enumerable, get() {
      const count = (reads.get(key) ?? 0) + 1; reads.set(key, count);
      if (count > 1) throw new Error(`Repeated result accessor exposed ${secret}`);
      return value;
    },
  });
  const recovered = await runtime(writer, scripted([toolCalls('a'), assistant()]), {
    tools: [effectTool(async () => returned)],
  }).run(input());
  assert.deepEqual(recovered.recovery.operations, []);
  assert.deepEqual([...reads.values()], Array.from({ length: 6 }, () => 1));
  const saved = writer.state.executions[0]?.outcome?.payload;
  assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved));
  assert.deepEqual(saved['content'], result.content);
  assert.deepEqual(saved['details'], result.details);
  assert.deepEqual(saved['usage'], usage);
  assert.equal(saved['isError'], false);
  assert.ok(!JSON.stringify(writer.state).includes(secret));
});

for (const content of [undefined, null]) test(`ordinary results retain Pi's ${String(content)} content normalization`, async () => {
  const writer = new MemoryWriter();
  const returned = { content, details: { receipt: 'empty-content result' }, usage: assistant().usage, isError: true };
  const recovered = await runtime(writer, scripted([toolCalls('a'), assistant()]), {
    tools: [effectTool(async () => returned as unknown as AgentToolResult)],
  }).run(input());
  assert.deepEqual(recovered.recovery.operations, []);
  const saved = writer.state.executions[0]?.outcome?.payload;
  assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved));
  assert.deepEqual(saved['content'], []);
  assert.deepEqual(saved['details'], returned.details);
  assert.deepEqual(saved['usage'], returned.usage);
  assert.equal(saved['isError'], true);
});

test('result snapshots retain all defined JSON fields and detach nested content, details, usage and structured content', () => {
  const returned = { content: [
    { type: 'text', text: 'known result', textSignature: 'opaque-text-signature' },
    { type: 'image', data: 'synthetic-image-data', mimeType: 'image/png' },
  ], details: { receipt: 'known receipt' }, usage: assistant().usage,
    structuredContent: { programmatic: { value: 3 } }, isError: true, terminate: true,
    opaque: { retained: true }, optional: undefined };
  const saved = normalizeToolResult(returned);
  assert.deepEqual(saved, JSON.parse(JSON.stringify(returned)));
  assert.notEqual(saved.content, returned.content);
  assert.notEqual(saved.details, returned.details);
  assert.notEqual(saved.usage, returned.usage);
  assert.notEqual(saved.structuredContent, returned.structuredContent);
  returned.content[0]!.text = secret;
  returned.details.receipt = secret;
  returned.usage.input = Infinity;
  returned.structuredContent.programmatic.value = NaN;
  assert.ok(!JSON.stringify(saved).includes(secret));
  assert.deepEqual(saved, normalizeToolResult(saved));
});

for (const isError of [false, true]) test(`canonical results preserve Pi's terminate hint for a known ${isError ? 'error' : 'success'}`, async () => {
  const writer = new MemoryWriter(); let requests = 0;
  const recovered = await runtime(writer, () => { requests++; return streamOf(toolCalls('a')); }, {
    tools: [effectTool(async () => ({ ...result, usage: assistant().usage,
      structuredContent: { receipt: 'programmatic result' }, isError, terminate: true }))],
  }).run(input());
  assert.equal(requests, 1, 'the canonical snapshot retains the native early-termination behavior');
  assert.deepEqual(recovered.recovery.operations, []);
  const saved = structuredClone(writer.state.executions[0]?.outcome);
  assert.ok(saved);
  assert.equal((saved.payload as { isError: boolean }).isError, isError);
  assert.deepEqual((await runtime(writer).recover()).snapshot.executions[0]?.outcome, saved);
});

test('failed recovery-observation append stays fatal and a later restart does not invent a diagnostic', async () => {
  const writer = new MemoryWriter(); let effects = 0, requests = 0;
  writer.beforeAppend = async record => { if ((record.payload as { type?: string }).type === 'custom_message') throw Error('synthetic observation write failed'); };
  const instance = runtime(writer, () => { requests++; return streamOf(toolCalls('a', 'b')); }, {
    tools: [effectTool(async () => { effects++; throw Error(secret); })],
  });
  await assert.rejects(instance.run(input()), error => {
    assert.equal(DurableOperationError.categoryOf(error), 'persistence-write-failure');
    assert.match(PersistenceFailureNotice.text(PersistenceFailureNotice.from(error))!, /temporary server notice; no durable tool diagnostic is confirmed/);
    return error instanceof Error && /observation write failed/.test(error.message);
  });
  assert.equal(requests, 1); assert.equal(effects, 1);
  assert.equal(writer.state.executions[0]?.outcome, null);
  assert.ok(!writer.state.records.some(record => (record.payload as { type?: string }).type === 'custom_message'));
  delete writer.beforeAppend;
  const restarted = await runtime(writer).recover();
  assert.deepEqual(restarted.recovery.operations.map(operation => operation.status), ['outcome-unknown', 'not-started']);
  assert.ok(restarted.recovery.operations.every(operation => !Object.hasOwn(operation, 'diagnostic')));
});

test('only real trusted scoped persistence instances select the event-content-conflict diagnostic', async () => {
  const ordinary = new PersistenceError('invalid', secret);
  const trusted = new PersistenceError('duplicate', secret, 'event-content-conflict');
  assert.equal(ordinary.name, 'PersistenceError'); assert.equal(ordinary.code, 'invalid');
  assert.equal(DurableOperationError.categoryOf(ordinary), undefined);
  const unreadable = new Error('hidden');
  Object.defineProperty(unreadable, 'message', { get() { throw Error('Raw external message must not be read'); } });
  const values: Array<[unknown, string]> = [
    [trusted, 'event-content-conflict'], [ordinary, 'execution-rejected'],
    [{ name: 'PersistenceError', code: 'duplicate', category: 'event-content-conflict', message: secret }, 'execution-rejected'],
    [Object.create(PersistenceError.prototype) as unknown, 'execution-rejected'],
    [new Error('Event ID was reused with different data or wake'), 'execution-rejected'],
    [new Error('Non-JSON nonfinite runtime number'), 'execution-rejected'],
    [new Error(secret, { cause: trusted }), 'execution-rejected'],
    [unreadable, 'execution-rejected'], [secret.repeat(100_000), 'execution-rejected'],
  ];
  for (const [error, category] of values) {
    const writer = new MemoryWriter(); let effects = 0;
    const recovered = await runtime(writer, scripted([toolCalls('a', 'b'), assistant()]), {
      tools: [effectTool(async () => { effects++; throw error; })],
    }).run(input());
    assert.equal(effects, 1); assert.equal(writer.state.executions[0]?.outcome, null);
    assert.deepEqual(recovered.recovery.operations[0]?.diagnostic, { phase: 'execute', category });
    assert.ok(!JSON.stringify(writer.state).includes(secret));
  }
});

test('JSON rejection categories use trusted result validation and never copy the rejected value', async () => {
  const cyclic: Record<string, unknown> = { secret }; cyclic['self'] = cyclic;
  const symbol = { secret, [Symbol('secret')]: secret };
  const sparse = [1, , 2];
  const values = [1n, () => secret, new Date(), cyclic, symbol, sparse, new Map([[secret, secret]])];
  for (const value of values) {
    const writer = new MemoryWriter(); const effects: string[] = [];
    const recovered = await runtime(writer, scripted([toolCalls('a', 'b'), assistant()]), {
      tools: [effectTool(async id => { effects.push(id); return { ...result, details: value }; })],
    }).run(input());
    assert.deepEqual(effects, ['a']); assert.equal(writer.state.executions[0]?.outcome, null);
    assert.deepEqual(recovered.recovery.operations[0]?.diagnostic, { phase: 'result', category: 'invalid-json-result' });
    assert.ok(!JSON.stringify(writer.state).includes(secret));
  }
});

test('a trusted persistence failure from inside a tool remains fatal with only a volatile safe notice', async () => {
  const writer = new MemoryWriter(); let requests = 0, effects = 0;
  const failure = new DurableOperationError('persistence-write-failure', secret, { cause: { headers: { Authorization: secret } } });
  const instance = runtime(writer, () => { requests++; return streamOf(toolCalls('a', 'b')); }, {
    tools: [effectTool(async () => { effects++; throw failure; })],
  });
  await assert.rejects(instance.run(input()), error => error === failure);
  assert.equal(effects, 1); assert.equal(requests, 1);
  assert.equal(writer.state.executions[0]?.outcome, null);
  assert.ok(!writer.state.records.some(record => (record.payload as { type?: string }).type === 'custom_message'));
  assert.ok(!PersistenceFailureNotice.text(PersistenceFailureNotice.from(failure))!.includes(secret));
  assert.equal(PersistenceFailureNotice.from({ category: 'persistence-write-failure', message: secret }), null);
  assert.equal(PersistenceFailureNotice.text(Object.create(PersistenceFailureNotice.prototype)), undefined);
  const restarted = await runtime(writer).recover();
  assert.ok(restarted.recovery.operations.every(operation => !operation.diagnostic));
});

for (const committed of [false, true]) test(`finishTool write failure (${committed ? 'after' : 'before'} commit) never saves a guessed diagnostic or executes siblings`, async () => {
  const writer = new MemoryWriter(); let requests = 0; const effects: string[] = [];
  const finish = writer.finishTool.bind(writer);
  writer.finishTool = async outcome => { if (committed) await finish(outcome); throw Error(secret); };
  const instance = runtime(writer, () => { requests++; return streamOf(toolCalls('a', 'b')); }, {
    tools: [effectTool(async id => { effects.push(id); return result; })],
  });
  await assert.rejects(instance.run(input()), error => DurableOperationError.categoryOf(error) === 'persistence-write-failure');
  assert.equal(requests, 1); assert.deepEqual(effects, ['a']);
  assert.ok(!writer.state.records.some(record => (record.payload as { type?: string }).type === 'custom_message'));
  const saved = structuredClone(writer.state.executions[0]?.outcome);
  assert.equal(!!saved, committed);
  const restarted = await runtime(writer).recover();
  assert.deepEqual(writer.state.executions[0]?.outcome, saved);
  assert.ok(restarted.recovery.operations.every(operation => !operation.diagnostic));
  if (saved) assert.deepEqual(restarted.messages.find(message => message.role === 'toolResult'), saved.payload);
});

test('returned known success and error outcomes are unchanged and have no diagnostic', async () => {
  const writer = new MemoryWriter();
  const recovered = await runtime(writer, scripted([toolCalls('a', 'b'), assistant()]), {
    tools: [effectTool(async id => ({ ...result, isError: id === 'b' }))],
  }).run(input());
  assert.deepEqual(recovered.recovery.operations, []);
  const saved = structuredClone(writer.state.executions.map(execution => execution.outcome));
  assert.deepEqual(saved.map(outcome => (outcome?.payload as { isError: boolean }).isError), [false, true]);
  await runtime(writer).recover();
  assert.deepEqual(writer.state.executions.map(execution => execution.outcome), saved);
});

test('compaction and fresh recovery retain the exact diagnostic even when summary wording omits it', async () => {
  const writer = new MemoryWriter();
  const recovered = await runtime(writer, scripted([toolCalls('a'), assistant('Inspect the external state')]), {
    tools: [effectTool(async () => { throw Error(secret); })],
  }).run(input('Older context '.repeat(300)));
  await seed(writer, [input('Later discussion '.repeat(300)), assistant('Later reply '.repeat(300))]);
  const original = structuredClone(writer.state.records);
  let summaries = 0;
  const compacted = await runtime(writer, (_model, context) => {
    summaries++; assert.match(JSON.stringify(context.messages), /execution-rejected/);
    return streamOf(assistant('A summary that deliberately omits the runtime diagnostic'));
  }).compact({ keepRecentTokens: 1 });
  assert.ok(summaries > 0);
  assert.deepEqual(compacted.snapshot.records.slice(0, original.length), original);
  assert.deepEqual(compacted.recovery, recovered.recovery);
  assert.match(JSON.stringify(compacted.messages), /execution-rejected/);
  assert.deepEqual((await runtime(writer).recover()).recovery, recovered.recovery);
  assert.equal(writer.state.executions[0]?.outcome, null);
});

test('restart validates diagnostic keys, sizes, allowlist, phase and exact unknown-intent linkage before inference', async () => {
  const writer = new MemoryWriter();
  await runtime(writer, scripted([toolCalls('a', 'b'), assistant()]), { tools: [effectTool(async () => { throw Error(secret); })] }).run(input());
  const saved = structuredClone(writer.state);
  const changes: Array<(operations: RecoveryOperation[], state: typeof saved) => void> = [
    operations => { (operations[0] as unknown as { diagnostic: unknown }).diagnostic = { phase: 'execute', category: 'execution-rejected', message: secret }; },
    operations => { (operations[0] as unknown as { diagnostic: unknown }).diagnostic = { phase: 'execute', category: secret.repeat(1000) }; },
    operations => { (operations[0] as unknown as { diagnostic: unknown }).diagnostic = { phase: 'execute', category: 'non-finite-result' }; },
    operations => { (operations[0] as unknown as { diagnostic: unknown }).diagnostic = { phase: 'execute', category: 'persistence-write-failure' }; },
    operations => { (operations[0] as unknown as { diagnostic: unknown }).diagnostic = ['execute', 'execution-rejected']; },
    operations => { (operations[0] as unknown as { diagnostic: unknown }).diagnostic = null; },
    operations => { operations[1]!.diagnostic = operations[0]!.diagnostic!; },
    operations => { operations[0]!.callId = 'absent'; },
    operations => { operations[0]!.assistantRecordId = 'absent'; },
    (_operations, state) => { state.executions.length = 0; },
    (_operations, state) => { state.executions[0]!.outcome = { callId: 'a', occurredAt: new Date(1000).toISOString(), payload: { role: 'toolResult', toolCallId: 'a', toolName: 'effect', content: [], isError: false, timestamp: 1000 } }; },
  ];
  for (const change of changes) {
    writer.state = structuredClone(saved);
    const record = writer.state.records.find(record => (record.payload as { type?: string }).type === 'custom_message')!;
    const notice = record.payload as unknown as { content: string; details: { operations: RecoveryOperation[] } };
    change(notice.details.operations, writer.state);
    // Canonical-looking text cannot excuse untrusted or mislinked evidence.
    notice.content = observationText(notice.details.operations);
    let requests = 0;
    await assert.rejects(runtime(writer, () => { requests++; return streamOf(assistant()); }).run());
    assert.equal(requests, 0);
  }
  writer.state = structuredClone(saved);
  const records = structuredClone(writer.state.records);
  assert.doesNotThrow(() => decodeRecords(records));
  await runtime(writer).recover();
  assert.deepEqual(writer.state.records, records, 'valid restart does not add duplicate observations');
});
