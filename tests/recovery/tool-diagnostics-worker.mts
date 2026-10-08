import { appendFile } from 'node:fs/promises';
import { PostgresPersistence } from '@mira/persistence';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { testDatabaseUrl } from '../integration/database.mts';
import { assistant, effectTool, input, overrideWriter, result, runtime, scripted, streamOf, toolCalls } from './fixtures.mts';

const [schema, miraId, mode, counter] = process.argv.slice(2);
if (!schema || !/^mira_test_[a-f0-9]+$/.test(schema) || !miraId || !mode) throw Error('Explicit isolated diagnostic fixture required');
const writer = await new PostgresPersistence({ connectionString: testDatabaseUrl(), schema }).acquire(miraId);
try {
  const tools = [effectTool(async () => {
    if (counter) await appendFile(counter, 'synthetic-effect\n');
    if (mode === 'unobserved-crash') process.exit(75);
    if (mode === 'observed-crash') throw Error('synthetic-tool-secret-do-not-save');
    return result;
  })];
  if (mode === 'unobserved-crash' || mode === 'observed-crash') {
    const target = overrideWriter(writer, { append: async (version, record, signal) => {
      const next = await writer.append(version, record, signal);
      if (mode === 'observed-crash' && (record.payload as { type?: string }).type === 'custom_message') process.exit(76);
      return next;
    } });
    await runtime(target, scripted([toolCalls('crash-call', 'unstarted-sibling'), assistant()]), { tools }).run(input());
    throw Error('Synthetic crash did not occur');
  }
  if (mode !== 'recover') throw Error('Unsupported diagnostic fixture mode');
  const contexts: TranscriptContext[] = [];
  const recovered = await runtime(writer, (_model, context) => {
    contexts.push(structuredClone(context)); return streamOf(assistant('Recovered without replay'));
  }, { tools }).run(input('Inspect the previously interrupted operation'));
  process.stdout.write(JSON.stringify({ snapshot: recovered.snapshot, recovery: recovered.recovery, contexts }));
} finally { await writer.close(); }
