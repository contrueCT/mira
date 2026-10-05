import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { WakeLoop, type RecoverySnapshot, type WakeRun, type WakeWriter } from '@mira/life';
import { PostgresPersistence } from '@mira/persistence';
import { testDatabaseUrl } from '../integration/database.mts';
import { assistant, deferred, effectTool, result, runtime, streamOf, toolCalls } from './fixtures.mts';

export type CrashBoundary = 'after-claim' | 'after-input' | 'after-final' | 'after-complete';
export type WorkerMode = CrashBoundary | 'drain' | 'hold-model' | 'hold-effect' | 'resume-with-tools';
export type WorkerMessage =
  | { type: 'acquired'; epoch: string }
  | { type: 'checkpoint'; boundary: CrashBoundary; run: WakeRun; snapshot: RecoverySnapshot; modelCalls: number; effects: number }
  | { type: 'waiting'; boundary: 'model' | 'effect'; run: WakeRun; snapshot: RecoverySnapshot }
  | { type: 'lost' }
  | { type: 'result'; completed: number; claims: string[]; snapshot: RecoverySnapshot; modelCalls: number; effects: number; requests: TranscriptContext[] }
  | { type: 'stopped'; ownershipLost: boolean; modelCalls: number; effects: number }
  | { type: 'failed'; message: string };

/** IPC carries synthetic evidence only. The database URL stays in the runner's
 * isolated environment; no credentials, provider calls or arbitrary logs. */
async function report(message: WorkerMessage): Promise<void> {
  if (!process.send || !process.connected) throw new Error('Wake worker requires its parent IPC channel');
  await new Promise<void>((resolve, reject) => process.send!(message, error => error ? reject(error) : resolve()));
}

async function main(): Promise<void> {
  const [schema, miraId, mode, applicationName, effectPath] = process.argv.slice(2);
  assert(schema && miraId && mode && applicationName);
  assert(['after-claim', 'after-input', 'after-final', 'after-complete', 'drain', 'hold-model', 'hold-effect', 'resume-with-tools'].includes(mode));
  const release = deferred();
  process.on('message', message => {
    if (typeof message !== 'object' || message === null || !('command' in message)) return;
    if (message.command === 'release') release.resolve();
    // Deliberately bypass writer.close()/finally, exactly like process death.
    if (message.command === 'exit') process.exit(80);
  });
  const writer = await new PostgresPersistence({ connectionString: testDatabaseUrl(), schema, applicationName }).acquire(miraId);
  let modelCalls = 0, effects = 0;
  const claims: string[] = [];
  const requests: TranscriptContext[] = [];
  let currentRun: WakeRun | undefined;
  const lost = () => { void report({ type: 'lost' }).catch(() => {}); };
  writer.signal.addEventListener('abort', lost, { once: true });
  const checkpoint = async (boundary: CrashBoundary, runId: string): Promise<void> => {
    if (mode !== boundary) return;
    await report({ type: 'checkpoint', boundary, run: await writer.loadWakeRun(runId), snapshot: await writer.load(), modelCalls, effects });
    // Parent chooses SIGKILL or immediate exit after receiving durable evidence.
    await release.promise;
    throw new Error('A crash checkpoint must terminate, never continue');
  };
  const wrapped: WakeWriter = {
    miraId: writer.miraId, epoch: writer.epoch, signal: writer.signal,
    assertActive: writer.assertActive.bind(writer), verifyActive: writer.verifyActive.bind(writer),
    load: writer.load.bind(writer), append: writer.append.bind(writer), receive: writer.receive.bind(writer),
    beginTool: writer.beginTool.bind(writer), finishTool: writer.finishTool.bind(writer), close: writer.close.bind(writer),
    loadWakeRun: writer.loadWakeRun.bind(writer),
    claimWakeBatch: async () => {
      const run = await writer.claimWakeBatch();
      if (run) {
        currentRun = run; claims.push(run.id);
        await checkpoint('after-claim', run.id);
      }
      return run;
    },
    appendWakeInput: async (runId, expected, record, signal) => {
      const version = await writer.appendWakeInput(runId, expected, record, signal);
      await checkpoint('after-input', runId);
      return version;
    },
    appendWakeFinal: async (runId, expected, record, signal) => {
      const version = await writer.appendWakeFinal(runId, expected, record, signal);
      await checkpoint('after-final', runId);
      return version;
    },
    completeWakeRun: async runId => {
      await writer.completeWakeRun(runId);
      await checkpoint('after-complete', runId);
    },
  };
  const waitAt = async (boundary: 'model' | 'effect'): Promise<void> => {
    assert(currentRun);
    await report({ type: 'waiting', boundary, run: await writer.loadWakeRun(currentRun.id), snapshot: await writer.load() });
    // Intentionally ignore AbortSignal. The runtime must fence this already
    // pending provider/effect when it eventually returns after replacement.
    await release.promise;
  };
  const usesTools = mode === 'hold-model' || mode === 'hold-effect' || mode === 'resume-with-tools';
  const tools = usesTools ? [effectTool(async callId => {
    effects++;
    assert(effectPath);
    appendFileSync(effectPath, `${mode}:${callId}\n`, { encoding: 'utf8' });
    if (mode === 'hold-effect' && effects === 1) await waitAt('effect');
    return result;
  })] : [];
  const loop = new WakeLoop({
    writer: wrapped,
    writeOverflowInput: async () => { throw new Error('Small synthetic wake unexpectedly overflowed'); },
    createRuntime: () => runtime(wrapped, async (_model, context) => {
      modelCalls++; requests.push(structuredClone(context));
      if (mode === 'hold-model' && modelCalls === 1) await waitAt('model');
      if ((mode === 'hold-model' || mode === 'hold-effect') && modelCalls === 1) return streamOf(toolCalls('stale-first', 'stale-second'));
      return streamOf(assistant('synthetic process wake reply'));
    }, { tools }),
  });
  try {
    await report({ type: 'acquired', epoch: writer.epoch });
    try {
      const completed = await loop.drain();
      await report({ type: 'result', completed, claims, snapshot: await writer.load(), modelCalls, effects, requests });
    } catch (error) {
      if (mode !== 'hold-model' && mode !== 'hold-effect') throw error;
      await report({ type: 'stopped', ownershipLost: writer.signal.aborted, modelCalls, effects });
    }
  } finally {
    writer.signal.removeEventListener('abort', lost);
    await writer.close();
  }
}

try { await main(); }
catch (error) {
  await report({ type: 'failed', message: error instanceof Error ? error.message : 'Unknown wake worker failure' }).catch(() => {});
  process.exitCode = 1;
} finally { if (process.connected) process.disconnect(); }
