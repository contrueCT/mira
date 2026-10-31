import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeRecords, PiDurableRuntime, RUNTIME_STATUS_PREFIX, type BackgroundJob, type BackgroundOutcome, type ForegroundOptions } from '@mira/runtime-pi';
import { assistant, deferred, effectTool, model, result, streamOf, toolCalls } from '../recovery/fixtures.mts';
import { LiveMemoryWriter, userEvent, userWake } from '../recovery/live-input-fixture.mts';

const add = (writer: LiveMemoryWriter, id: string) => writer.receiveLiveInput(userEvent(id), userWake(id));
function foreground(overrides: Partial<ForegroundOptions> = {}) {
  const started: BackgroundJob[] = []; const settled: Array<{ job: BackgroundJob; outcome: BackgroundOutcome }> = [];
  const done = deferred();
  const options: ForegroundOptions = { hardLimitMs: 60_000, steerGraceMs: 30, onBackground: async job => { started.push(job); },
    onSettled: (job, outcome) => { settled.push({ job, outcome }); done.resolve(); }, ...overrides };
  return { options, started, settled, done };
}
const toolResults = (writer: LiveMemoryWriter) => decodeRecords(writer.state.records).flatMap(entry => entry.type === 'message' && entry.message.role === 'toolResult' ? [entry.message] : []);

test('a waiting user message moves a long tool to the background with an honest receipt, then the real result settles', { timeout: 5000 }, async () => {
  const writer = new LiveMemoryWriter(); const entered = deferred(); const release = deferred(); let calls = 0; let toolSignal: AbortSignal | undefined;
  const fg = foreground();
  const runtime = new PiDurableRuntime({ writer, model, foreground: fg.options,
    runtimeStatus: ({ phase }) => phase === 'live' ? 'Tool calls still running in the background: effect' : null,
    tools: [effectTool(async (_id, _args, signal) => { toolSignal = signal; entered.resolve(); await release.promise; return result; })],
    streamFn: (_model, context) => {
      if (++calls === 1) return streamOf(toolCalls('slow'));
      const text = JSON.stringify(context.messages);
      assert.match(text, /backgrounded/); assert.match(text, /outcome unknown/);
      assert.match(text, /steer-now/); assert.ok(text.includes(RUNTIME_STATUS_PREFIX));
      return streamOf(assistant('Still running; I will report when it finishes.'));
    } });
  const work = runtime.continueTurn(await writer.turn()); await entered.promise;
  await add(writer, 'steer-now');
  await work;
  assert.equal(calls, 2); assert.equal(fg.started.length, 1); assert.equal(fg.started[0]!.reason, 'user-input');
  assert.equal(fg.settled.length, 0, 'the tool is still running after the Wake answered');
  const [receipt] = toolResults(writer);
  assert.equal(receipt!.isError, false); assert.match(JSON.stringify(receipt!.details), /"status":"backgrounded"/);
  // The delivered input carries model-only status; the deterministic text is unchanged before it.
  const live = decodeRecords(writer.state.records).find(entry => entry.id === writer.live[0]!.inputRecordId);
  assert.ok(live?.type === 'message' && live.message.role === 'user' && typeof live.message.content === 'string');
  assert.ok((live.message as unknown as Record<string, unknown>)['miraRuntimeStatus']);
  release.resolve(); await fg.done.promise;
  assert.equal(toolSignal?.aborted, false, 'the background call is never aborted by the finished attempt');
  assert.deepEqual(fg.settled[0]!.outcome, { status: 'completed', result });
  // Recovery revalidates the persisted live input (with its status) without re-calling the provider.
  await new PiDurableRuntime({ writer, model, streamFn: () => { throw Error('no provider during recovery'); } }).continueTurn(await writer.turn());
});

test('the hard limit backgrounds a tool even with no user message; a throw later is reported, never a fabricated outcome', { timeout: 5000 }, async () => {
  const writer = new LiveMemoryWriter(); const release = deferred(); let calls = 0;
  const fg = foreground({ hardLimitMs: 40 });
  await new PiDurableRuntime({ writer, model, foreground: fg.options,
    tools: [effectTool(async () => { await release.promise; throw new Error('late failure'); })],
    streamFn: () => ++calls === 1 ? streamOf(toolCalls('stuck')) : streamOf(assistant('NO_REPLY')) }).continueTurn(await writer.turn());
  assert.equal(fg.started[0]!.reason, 'hard-limit');
  release.resolve(); await fg.done.promise;
  assert.equal(fg.settled[0]!.outcome.status, 'rejected');
  assert.match((fg.settled[0]!.outcome as { error: string }).error, /late failure/);
});

test('fast tools and non-promotable tools stay in the foreground', { timeout: 5000 }, async () => {
  const writer = new LiveMemoryWriter(); let calls = 0;
  const fg = foreground({ hardLimitMs: 10, promotable: () => false });
  await new PiDurableRuntime({ writer, model, foreground: fg.options,
    tools: [effectTool(async () => { await new Promise(resolve => setTimeout(resolve, 40)); return result; })],
    streamFn: () => ++calls === 1 ? streamOf(toolCalls('quick')) : streamOf(assistant('done')) }).continueTurn(await writer.turn());
  assert.equal(fg.started.length, 0);
  assert.match(JSON.stringify(toolResults(writer)[0]!.content), /synthetic effect done/);
});

test('a tampered runtime status blocks recovery', async () => {
  const writer = new LiveMemoryWriter(); let calls = 0; const entered = deferred(); const release = deferred();
  await (async () => {
    const work = new PiDurableRuntime({ writer, model, runtimeStatus: () => 'snapshot',
      tools: [effectTool(async () => { entered.resolve(); await release.promise; return result; })],
      streamFn: () => ++calls === 1 ? streamOf(toolCalls('one')) : streamOf(assistant('ok')) }).continueTurn(await writer.turn());
    await entered.promise; await add(writer, 'late'); release.resolve(); await work;
  })();
  const id = writer.live[0]!.inputRecordId!;
  const index = writer.state.records.findIndex(record => record.id === id);
  const record = structuredClone(writer.state.records[index]!) as unknown as { payload: { message: { content: string } } };
  record.payload.message.content = record.payload.message.content.replace('late', 'edited');
  writer.state.records[index] = record as never;
  await assert.rejects(new PiDurableRuntime({ writer, model, streamFn: () => streamOf(assistant('x')) }).continueTurn(await writer.turn()));
});
