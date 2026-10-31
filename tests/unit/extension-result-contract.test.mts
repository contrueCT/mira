import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import type { Json } from '@mira/extension-sdk';
import { ExtensionHost } from '@mira/extension-host';
import { extensionReceiver, extensionTools } from '@mira/server';
import { decodeRecords } from '@mira/runtime-pi';
import numericExample from '../../skills/mira-extension-authoring/examples/finite-sum.ts';
import { assistant, input, MemoryWriter, runtime, streamOf } from '../recovery/fixtures.mts';

const entry = path.resolve('skills/mira-extension-authoring/examples/finite-sum.ts');

async function assertKnownResult(values: number[], expected: Json, isError: boolean): Promise<void> {
  const writer = new MemoryWriter();
  const host = new ExtensionHost({ entries: [{ id: 'numeric-example', path: entry }], receive: extensionReceiver(writer) });
  let requests = 0;
  try {
    await host.start();
    assert.equal(host.inspect()[0]!.status, 'active');
    const instance = runtime(writer, (_model, context) => {
      if (++requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'sum-call', name: 'sum_finite', arguments: { values } },
      ] });
      assert.equal(requests, 2);
      const message = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'sum-call');
      assert.ok(message?.role === 'toolResult');
      assert.equal(message.isError, isError, 'Pi stores the extension isError flag on the tool result');
      assert.deepEqual(message.details, expected);
      assert.ok(message.content[0]?.type === 'text');
      assert.deepEqual(JSON.parse(message.content[0].text), expected, 'text and details describe the same result');
      return streamOf(assistant('Synthetic numeric result inspected'));
    }, {
      prepareTools: async () => extensionTools(await host.prepare()), finishTools: () => host.finish(),
    });
    const completed = await instance.run(input('Compute this local synthetic sum'));
    assert.equal(requests, 2);
    assert.deepEqual(completed.recovery.operations, []);
    assert.equal(writer.state.executions.length, 1);
    const execution = writer.state.executions[0]!;
    assert.deepEqual(execution.intent.requestedArguments, { values });
    assert.deepEqual(execution.intent.arguments, { values });
    assert.ok(execution.outcome, 'a returned result is a durable known outcome');
    const payload = execution.outcome.payload;
    assert.ok(payload !== null && typeof payload === 'object' && !Array.isArray(payload));
    assert.equal(payload['isError'], isError, 'the durable outcome keeps Pi isError');
    const message = completed.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'sum-call');
    assert.ok(message?.role === 'toolResult');
    assert.deepEqual(execution.outcome.payload, message, 'the exact provider-visible outcome is saved');
    assert.equal(execution.outcome.occurredAt, new Date(message.timestamp).toISOString());
    assert.deepEqual(JSON.parse(JSON.stringify(execution.outcome.payload)), execution.outcome.payload, 'the complete result round-trips as JSON');
    const saved = structuredClone(writer.state);
    const recovered = await runtime(writer, () => { throw Error('Recovery must not call a model or repeat the sum'); }).recover();
    assert.deepEqual(recovered.snapshot, saved);
    assert.deepEqual(recovered.recovery.operations, []);
    const transcript = decodeRecords(recovered.snapshot.records).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
    assert.deepEqual(transcript.find(message => message.role === 'toolResult' && message.toolCallId === 'sum-call'), message);
  } finally { await host.close(); await writer.close(); }
}

test('authoring numeric example preserves valid finite outputs through the real host and Pi runtime', { timeout: 15_000 }, async () => {
  assert.equal(numericExample.name, 'finite-sum'); // Also typecheck the actual example, not only a dynamic import path.
  assert.deepEqual(numericExample.inject, []);
  for (const [values, total] of [
    [[], 0], [[1, 2, -0.5], 2.5], [[Number.MAX_VALUE], Number.MAX_VALUE],
  ] satisfies Array<[number[], number]>) await assertKnownResult(values, { ok: true, total }, false);
});

test('finite inputs can overflow; the authoring example returns a known failed outcome', { timeout: 15_000 }, async () => {
  for (const values of [[Number.MAX_VALUE, Number.MAX_VALUE], [-Number.MAX_VALUE, -Number.MAX_VALUE]]) {
    assert.ok(values.every(Number.isFinite), 'the regression uses valid finite inputs');
    assert.equal(Number.isFinite(values.reduce((sum, value) => sum + value, 0)), false);
    await assertKnownResult(values, { ok: false, reason: 'numeric-overflow' }, true);
  }
});
