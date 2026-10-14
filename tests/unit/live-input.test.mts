import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { Type, createAssistantMessageEventStream, getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import { decodeRecords, PiDurableRuntime } from '@mira/runtime-pi';
import { assistant, deferred, effectTool, model, result, streamOf, toolCalls, seed, input } from '../recovery/fixtures.mts';
import { LiveMemoryWriter, userEvent, userWake } from '../recovery/live-input-fixture.mts';

const add = (writer: LiveMemoryWriter, id: string) => writer.receiveLiveInput(userEvent(id), userWake(id));

test('new input cancels just the streaming request and restarts with ordered durable inputs', { timeout: 5000 }, async () => {
  const writer = new LiveMemoryWriter(); const entered = deferred(); let calls = 0; let aborted = false;
  const runtime = new PiDurableRuntime({ writer, model, streamFn: (_model, context, options) => {
    if (++calls === 1) {
      const stream = createAssistantMessageEventStream(); entered.resolve();
      options!.signal!.addEventListener('abort', () => {
        aborted = true; stream.push({ type: 'error', reason: 'aborted', error: { ...assistant('discarded partial'), stopReason: 'aborted' } });
      }, { once: true });
      return stream;
    }
    const users = context.messages.filter(message => message.role === 'user');
    assert.match(JSON.stringify(users), /correction/);
    return streamOf(assistant('Responded to correction'));
  } });
  const work = runtime.continueTurn(await writer.turn()); await entered.promise;
  assert.equal(await add(writer, 'correction'), 'inserted');
  assert.equal(await add(writer, 'correction'), 'duplicate');
  await work;
  assert.equal(aborted, true); assert.equal(calls, 2); assert.equal(writer.signal.aborted, false);
  assert.equal(writer.live.length, 1); assert.ok(writer.live[0]!.inputRecordId);
  assert.doesNotMatch(JSON.stringify(writer.state.records), /discarded partial/);
  assert.deepEqual(writer.run.requests.map(item => item.event.id), ['original']);
});

test('one in-flight tool finishes; remaining old batch never starts before new input', { timeout: 5000 }, async () => {
  const writer = new LiveMemoryWriter(); const entered = deferred(), release = deferred(); const effects: string[] = []; let calls = 0;
  const runtime = new PiDurableRuntime({ writer, model, tools: [effectTool(async (id, _args, signal) => {
    effects.push(id); entered.resolve(); await release.promise; assert.equal(signal?.aborted, false); return result;
  })], streamFn: (_model, context) => {
    if (++calls === 1) return streamOf(toolCalls('first', 'old-sibling', 'old-third'));
    assert.match(JSON.stringify(context.messages), /change-direction/);
    assert.ok(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'first'));
    assert.match(JSON.stringify(context.messages), /Execution did not start/);
    return streamOf(assistant('Stopped the remaining operations'));
  } });
  const work = runtime.continueTurn(await writer.turn()); await entered.promise;
  await add(writer, 'change-direction'); await setImmediate(); assert.equal(calls, 1); assert.deepEqual(effects, ['first']);
  release.resolve(); await work;
  assert.equal(calls, 2); assert.deepEqual(effects, ['first']);
  assert.deepEqual(writer.state.executions.map(item => item.intent.callId), ['first']);
  const recovered = await new PiDurableRuntime({ writer, model, streamFn: () => { throw Error('Recovery must not call provider'); } }).recover();
  assert.deepEqual(recovered.recovery.operations.map(item => [item.callId, item.status]), [['old-sibling', 'not-started'], ['old-third', 'not-started']]);
  assert.ok(writer.state.executions[0]!.outcome);
});

test('input winning the final commit race suppresses stale final and is consumed once', async () => {
  const writer = new LiveMemoryWriter(); let calls = 0;
  writer.beforeFinal = async () => { delete writer.beforeFinal; await add(writer, 'final-race'); };
  await new PiDurableRuntime({ writer, model, streamFn: (_model, context) => {
    if (++calls === 1) return streamOf(assistant('stale final'));
    assert.match(JSON.stringify(context.messages), /final-race/);
    return streamOf(assistant('current final'));
  } }).continueTurn(await writer.turn());
  assert.equal(calls, 2); assert.doesNotMatch(JSON.stringify(writer.state.records), /stale final/);
  assert.ok(writer.run.finalRecordId);
  const final = decodeRecords(writer.state.records).find(entry => entry.id === writer.run.finalRecordId);
  assert.match(JSON.stringify(final), /current final/);
});

test('pending input after tool-intent crash precedes cognition and does not replay unknown effects', async () => {
  const writer = new LiveMemoryWriter(); let effects = 0;
  const runtime = new PiDurableRuntime({ writer, model, streamFn: () => streamOf(toolCalls('unknown', 'never-started')),
    tools: [effectTool(async () => { effects++; writer.controller.abort(Error('simulated process loss')); throw Error('lost'); })] });
  await assert.rejects(runtime.continueTurn(await writer.turn()));
  const replacement = new LiveMemoryWriter(); replacement.state = structuredClone(writer.state); replacement.run = structuredClone(writer.run);
  await add(replacement, 'do-not-retry');
  await new PiDurableRuntime({ writer: replacement, model, tools: [effectTool(async () => { effects++; return result; })],
    streamFn: (_model, context) => {
      assert.match(JSON.stringify(context.messages), /do-not-retry/);
      assert.match(JSON.stringify(context.messages), /success or failure is unknown/);
      return streamOf(assistant('I will not replay the unknown action'));
    } }).continueTurn(await replacement.turn());
  assert.equal(effects, 1);
  assert.equal(replacement.state.executions[0]!.outcome, null);
});

test('ordered attachment identities are retained across supplemental inputs and recovery', async () => {
  const writer = new LiveMemoryWriter();
  const refs = ['a', 'b'].map((name, index) => ({ id: `00000000-0000-4000-8000-00000000000${index}`, name: `${name}.mp4`, mimeType: 'video/mp4', size: 12, sha256: 'a'.repeat(64), path: `/tmp/${name}.mp4` }));
  await writer.receiveLiveInput({ ...userEvent('videos'), payload: { text: 'read in order', attachments: refs } }, userWake('videos'));
  await add(writer, 'then-answer');
  let requests = 0;
  await new PiDurableRuntime({ writer, model, streamFn: (_model, context) => {
    requests++; const text = JSON.stringify(context.messages);
    assert.ok(text.indexOf('a.mp4') < text.indexOf('b.mp4'));
    assert.ok(text.indexOf('read in order') < text.indexOf('then-answer'));
    assert.ok(!context.messages.some(message => message.role === 'user' && Array.isArray(message.content) && message.content.some(block => block.type === 'image')));
    return streamOf(assistant('Need an explicit file read for videos'));
  } }).continueTurn(await writer.turn());
  await new PiDurableRuntime({ writer, model, streamFn: () => { requests++; throw Error('Finalized recovery must not request model'); } }).continueTurn({ ...await writer.turn(), input: '' });
  assert.equal(requests, 1); assert.equal(writer.live.length, 2);
});

test('input arriving during compaction remains ordered after the atomic checkpoint and before a natural request', { timeout: 5000 }, async () => {
  const writer = new LiveMemoryWriter(); const entered = deferred(), release = deferred();
  await seed(writer, [input('Older question '.repeat(4000)), assistant('Earlier answer '.repeat(4000)), input('Recent question'), assistant('Recent answer')]);
  const prefix = structuredClone(writer.state.records); let summaries = 0, requests = 0;
  const work = new PiDurableRuntime({ writer, model: { ...model, contextWindow: 65536 },
    autoCompaction: { enabled: true, threshold: 0.3, reserveTokens: 512, keepRecentTokens: 1 },
    streamFn: async (_model, context, options) => {
      const system = getCurrentSystemMessage(context.messages);
      if (system && getSystemMessageText(system).startsWith('你负责压缩 Mira 的 Working Context')) {
        summaries++; entered.resolve(); await release.promise;
        assert.equal(options?.signal?.aborted, false, 'steering does not poison a compaction candidate');
        return streamOf(assistant('Compressed older history'));
      }
      requests++; assert.match(JSON.stringify(context.messages), /during-summary/);
      assert.match(JSON.stringify(context.messages), /Compressed older history/);
      return streamOf(assistant('Answered the new input after compaction'));
    } }).continueTurn(await writer.turn());
  await entered.promise; await add(writer, 'during-summary'); release.resolve(); await work;
  assert.equal(summaries, 1); assert.equal(requests, 1);
  assert.deepEqual(writer.state.records.slice(0, prefix.length), prefix);
  const records = decodeRecords(writer.state.records);
  const checkpoint = records.findIndex(entry => entry.type === 'compaction');
  assert.ok(checkpoint >= 0); assert.ok(records.findIndex(entry => entry.id === writer.live[0]!.inputRecordId) > checkpoint);
});

test('new input between assistant commit and first tool intent prevents every old effect', async () => {
  const writer = new LiveMemoryWriter(); let calls = 0, effects = 0;
  writer.beforeAppend = async record => {
    if (JSON.stringify(record.payload).includes('old-first')) { delete writer.beforeAppend; await add(writer, 'no-old-effects'); }
  };
  await new PiDurableRuntime({ writer, model, tools: [effectTool(async () => { effects++; return result; })], streamFn: (_model, context) => {
    if (++calls === 1) return streamOf(toolCalls('old-first', 'old-second'));
    assert.match(JSON.stringify(context.messages), /no-old-effects/);
    return streamOf(assistant('New instructions considered first'));
  } }).continueTurn(await writer.turn());
  assert.equal(effects, 0); assert.equal(calls, 2); assert.equal(writer.state.executions.length, 0);
});

for (const malformed of ['unknown-tool', 'invalid-arguments'] as const) test(`pending input wins before a ${malformed} old sibling is prepared`, { timeout: 5000 }, async () => {
  const writer = new LiveMemoryWriter(); const entered = deferred(), release = deferred(); let effects = 0, requests = 0;
  const tool = effectTool(async () => { effects++; entered.resolve(); await release.promise; return result; });
  tool.parameters = Type.Object({ value: Type.Number() });
  const work = new PiDurableRuntime({ writer, model, tools: [tool], streamFn: (_model, context) => {
    if (++requests === 1) {
      const message = toolCalls('valid-first');
      const first = message.content[0]!; if (first.type === 'toolCall') first.arguments = { value: 1 };
      message.content.push({ type: 'toolCall', id: 'bad-sibling', name: malformed === 'unknown-tool' ? 'missing-tool' : 'effect', arguments: malformed === 'invalid-arguments' ? { value: 'not-a-number' } : {} });
      return streamOf(message);
    }
    assert.match(JSON.stringify(context.messages), /correct-invalid-batch/);
    assert.match(JSON.stringify(context.messages), /Execution did not start/);
    return streamOf(assistant('The correction reached the model'));
  } }).continueTurn(await writer.turn());
  await entered.promise; await add(writer, 'correct-invalid-batch'); release.resolve(); await work;
  assert.equal(effects, 1); assert.equal(requests, 2); assert.ok(writer.run.finalRecordId);
});
