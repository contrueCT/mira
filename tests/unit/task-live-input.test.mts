import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { PiDurableRuntime, decodeRecords } from '@mira/runtime-pi';
import { assistant, deferred, effectTool, model, result, streamOf, toolCalls } from '../recovery/fixtures.mts';
import { TaskMemoryWriter } from '../recovery/task-input-fixture.mts';
const task = (writer: TaskMemoryWriter) => ({ id: writer.task.id, input: 'Delegation from Mira, not a human instruction', onInput: writer.onInput });

test('parent followup yields a child generation and preserves explicit parent provenance and order', { timeout: 5000 }, async () => {
  const writer = new TaskMemoryWriter(); const entered = deferred(); let calls = 0, aborted = false;
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: (_model, context, options) => {
    if (++calls === 1) {
      const stream = createAssistantMessageEventStream(); entered.resolve();
      options!.signal!.addEventListener('abort', () => { aborted = true; stream.push({ type: 'error', reason: 'aborted', error: { ...assistant('stale partial'), stopReason: 'aborted' } }); }, { once: true });
      return stream;
    }
    const text = JSON.stringify(context.messages);
    assert.match(text, /Source: parent agent, not a new human message/);
    assert.ok(text.indexOf('FIRST_CORRECTION') < text.indexOf('SECOND_CORRECTION'));
    return streamOf(assistant('Updated worker result'));
  } });
  const work = runtime.continueTaskTurn(task(writer)); await entered.promise;
  writer.add('first', 'FIRST_CORRECTION'); writer.add('second', 'SECOND_CORRECTION'); writer.add('first', 'FIRST_CORRECTION');
  await work;
  assert.equal(aborted, true); assert.equal(calls, 2); assert.equal(writer.signal.aborted, false);
  assert.equal(writer.inputs.length, 2); assert.ok(writer.inputs.every(value => value.inputRecordId));
  assert.doesNotMatch(JSON.stringify(writer.state.records), /stale partial/);
  const entries = decodeRecords(writer.state.records).filter(entry => entry.type === 'message');
  const sources = entries.flatMap(entry => 'miraParentInstruction' in entry.message ? [entry.message.miraParentInstruction] : []);
  assert.equal(sources.length, 3); assert.deepEqual(sources.at(-1), { turnId: writer.task.id, callId: 'second' });
});

test('child settles one tool then reads parent instruction before old siblings', { timeout: 5000 }, async () => {
  const writer = new TaskMemoryWriter(), entered = deferred(), release = deferred(); const effects: string[] = []; let calls = 0;
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', tools: [effectTool(async (id, _args, signal) => {
    effects.push(id); entered.resolve(); await release.promise; assert.equal(signal?.aborted, false); return result;
  })], streamFn: (_model, context) => {
    if (++calls === 1) return streamOf(toolCalls('first', 'unstarted-sibling'));
    assert.match(JSON.stringify(context.messages), /CHANGE_DIRECTION/);
    assert.match(JSON.stringify(context.messages), /Execution did not start/);
    assert.ok(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'first'));
    return streamOf(assistant('Updated task result'));
  } });
  const work = runtime.continueTaskTurn(task(writer)); await entered.promise;
  writer.add('change', 'CHANGE_DIRECTION'); await setImmediate(); assert.deepEqual(effects, ['first']); assert.equal(calls, 1);
  release.resolve(); await work;
  assert.deepEqual(effects, ['first']); assert.equal(calls, 2); assert.ok(writer.state.executions[0]!.outcome);
  assert.ok(writer.task.finalRecordId);
});

test('parent instruction wins final arbitration and finalized task validates without regenerating', async () => {
  const writer = new TaskMemoryWriter(); let calls = 0;
  writer.beforeFinal = async () => { delete writer.beforeFinal; writer.add('final-race'); };
  await new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(assistant(++calls === 1 ? 'stale final' : 'current final')) }).continueTaskTurn(task(writer));
  assert.equal(calls, 2); assert.doesNotMatch(JSON.stringify(writer.state.records), /stale final/);
  await new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => { throw Error('No repeated final'); } }).continueTaskTurn(task(writer));
  assert.equal(writer.inputs.length, 1);
});

test('task recovery reads a pending parent instruction without replaying unknown effects', async () => {
  const writer = new TaskMemoryWriter(); let effects = 0;
  await assert.rejects(new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(toolCalls('unknown', 'not-started')), tools: [effectTool(async () => {
    effects++; writer.controller.abort(Error('process lost')); throw Error('effect outcome lost');
  })] }).continueTaskTurn(task(writer)));
  const replacement = new TaskMemoryWriter(); replacement.state = structuredClone(writer.state); replacement.task = structuredClone(writer.task);
  replacement.add('inspect-only');
  await new PiDurableRuntime({ writer: replacement, model, compactionScope: 'task', tools: [effectTool(async () => { effects++; return result; })], streamFn: (_m, context) => {
    assert.match(JSON.stringify(context.messages), /inspect-only/); assert.match(JSON.stringify(context.messages), /success or failure is unknown/);
    return streamOf(assistant('Preserved uncertain effect'));
  } }).continueTaskTurn(task(replacement));
  assert.equal(effects, 1);
});
