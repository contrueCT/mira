import { appendFile } from 'node:fs/promises';
import { PostgresPersistence } from '@mira/persistence';
import { testDatabaseUrl } from '../integration/database.mts';
import { assistant, effectTool, input, model, overrideWriter, runtime, scripted, toolCalls } from './fixtures.mts';
import { largeToolText, outputSpool } from './tool-output-fixtures.mts';

const [schema, miraId, mode, spool, counter] = process.argv.slice(2);
if (!schema || !/^mira_test_[a-f0-9]+$/.test(schema) || !miraId || !['crash-after-outcome', 'recover'].includes(mode ?? '') || !spool || !counter) throw Error('Explicit isolated tool output fixture required');
const writer = await new PostgresPersistence({ connectionString: testDatabaseUrl(), schema }).acquire(miraId);
try {
  const tools = [effectTool(async () => {
    if (mode === 'recover') throw Error('Known external effect must never replay');
    await appendFile(counter, 'once\n');
    return { content: [{ type: 'text' as const, text: largeToolText }], details: { receipt: 'original' }, structuredContent: { allFields: true } };
  })];
  const target = mode === 'recover' ? writer : overrideWriter(writer, { finishTool: async outcome => { await writer.finishTool(outcome); process.exit(75); } });
  const options = { model: { ...model, contextWindow: 200_000 }, tools, writeOverflowInput: outputSpool(spool) };
  if (mode === 'crash-after-outcome') {
    await runtime(target, scripted([toolCalls('durable-large')]), options).run(input());
    throw Error('Synthetic crash did not occur');
  }
  const restored = await runtime(target, undefined, options).recover();
  const state = restored.messages.at(-1)?.role === 'assistant' ? restored : await runtime(target, scripted([assistant('Recovered original without replay')]), options).run();
  process.stdout.write(JSON.stringify(state));
} finally { await writer.close(); }
