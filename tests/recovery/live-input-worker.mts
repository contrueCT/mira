import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { WakeLoop, type LiveInputWriter } from '@mira/life';
import { PostgresPersistence } from '@mira/persistence';
import { testDatabaseUrl } from '../integration/database.mts';
import { assistant, effectTool, model, result, streamOf, toolCalls } from './fixtures.mts';
import { userEvent, userWake, noOverflow } from './live-input-fixture.mts';
import { PiDurableRuntime } from '@mira/runtime-pi';

const [schema, miraId, mode, counter] = process.argv.slice(2);
assert.ok(schema && miraId && mode && counter);
const writer = await new PostgresPersistence({ connectionString: testDatabaseUrl(), schema }).acquire(miraId);
let runId: string | undefined;
let calls = 0;
const contexts: unknown[] = [];
const inject = () => writer.receiveLiveInput(userEvent('new-input-before-crash'), userWake('new-input-before-crash'));
const wrapped = new Proxy(writer, { get(target, property) {
  if (property === 'appendLiveInput' && mode === 'after-consume') return async (...args: Parameters<LiveInputWriter['appendLiveInput']>) => {
    await target.appendLiveInput(...args); process.exit(81);
  };
  if (property === 'finishTool' && mode === 'after-outcome') return async (...args: Parameters<LiveInputWriter['finishTool']>) => {
    await target.finishTool(...args); process.exit(82);
  };
  const value = Reflect.get(target, property); return typeof value === 'function' ? value.bind(target) : value;
} });
try {
  if (mode !== 'recover') await writer.receiveLiveInput(userEvent('original'), userWake('original'));
  const loop = new WakeLoop({ writer: wrapped, writeOverflowInput: noOverflow,
    createRuntime: () => new PiDurableRuntime({ writer: wrapped, model, tools: [effectTool(async () => {
      appendFileSync(counter, 'one-effect\n'); await inject();
      if (mode === 'unknown') process.exit(83);
      return result;
    })], streamFn: async (_model, context) => {
      contexts.push(structuredClone(context)); calls++;
      runId = (await writer.claimWakeBatch())?.id;
      if (mode === 'after-outcome' || mode === 'unknown') return streamOf(toolCalls('effect-before-crash', 'old-sibling'));
      if (mode === 'after-receipt' || mode === 'after-consume') {
        await inject();
        if (mode === 'after-receipt') process.exit(80);
        // The committed receipt aborts this first request; runtime must discard it.
        return streamOf(assistant('Stale response must not publish'));
      }
      assert.match(JSON.stringify(context.messages), /new-input-before-crash/);
      return streamOf(assistant('Recovered with newest input first'));
    } }),
  });
  const completed = await loop.drain();
  assert.ok(runId);
  process.stdout.write(JSON.stringify({ completed, calls, contexts, snapshot: await writer.load(), run: await writer.loadWakeRun(runId), live: await writer.loadLiveInputs(runId) }));
} finally { await writer.close(); }
