import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { PostgresPersistence } from '@mira/persistence';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { testDatabaseUrl } from '../integration/database.mts';
import { assistant, effectTool, input, overrideWriter, result, runtime, scripted, streamOf, toolCalls } from './fixtures.mts';

const [schema, miraId, mode, effectPath] = process.argv.slice(2);
assert(schema && miraId && mode);
const store = new PostgresPersistence({ connectionString: testDatabaseUrl(), schema });
const writer = await store.acquire(miraId);
try {
  if (mode === 'first' || mode === 'second') {
    const requests: TranscriptContext[] = [];
    const restored = await runtime(writer, (_m, context) => { requests.push(structuredClone(context)); return streamOf(assistant(`${mode} answer`)); }).run(input(mode === 'first' ? 'The synthetic restaurant was called Paper Moon' : 'What about that earlier restaurant?'));
    process.stdout.write(JSON.stringify({ snapshot: restored.snapshot, requests }));
  } else if (mode === 'recover') {
    let requests = 0, effects = 0;
    try {
      const contexts: TranscriptContext[] = [];
      const restored = await runtime(writer, (_model, context) => { requests++; contexts.push(structuredClone(context)); return streamOf(assistant()); }, { tools: [effectTool(async () => { effects++; return result; })] }).run(input('continue'));
      process.stdout.write(JSON.stringify({ blocked: false, requests, effects, snapshot: restored.snapshot, recovery: restored.recovery, contexts }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ blocked: true, error: String(error), requests, effects, snapshot: await writer.load() }));
    }
  } else if (mode === 'recover-outcome') {
    let effects = 0;
    const instance = runtime(writer, scripted([assistant('continued after materialized outcome')]), { tools: [effectTool(async () => { effects++; return result; })] });
    const restored = await instance.recover();
    const continued = await instance.run();
    process.stdout.write(JSON.stringify({ restored: restored.snapshot, continued: continued.snapshot, effects }));
  } else {
    assert(effectPath);
    const wrapped = mode === 'after-outcome' ? overrideWriter(writer, {
      append: async (expected, record) => {
        if ((record.payload as { message?: { role: string } }).message?.role === 'toolResult') process.exit(72);
        return writer.append(expected, record);
      },
    }) : writer;
    await runtime(wrapped, scripted([toolCalls('counter-effect'), assistant()]), {
      tools: [effectTool(async () => {
        if (mode === 'before-effect') process.exit(70);
        appendFileSync(effectPath, 'synthetic-effect\n', { encoding: 'utf8' });
        if (mode === 'after-effect') process.exit(71);
        return result;
      })],
    }).run(input('one synthetic local counter effect'));
    throw Error('Expected controlled process crash');
  }
} finally { await writer.close(); }
