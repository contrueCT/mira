import { PostgresPersistence } from '@mira/persistence';
import { testDatabaseUrl } from '../database.mts';
const schema = process.argv[2];
const miraId = process.argv[3];
if (!schema || !miraId) throw new Error('schema and Mira ID are required');
const store = new PostgresPersistence({ connectionString: testDatabaseUrl(), schema, applicationName: 'mira-synthetic-child' });
try {
  const writer = await store.acquire(miraId);
  process.stdout.write(JSON.stringify({ state: 'acquired', epoch: writer.epoch }) + '\n');
  process.stdin.resume();
  process.stdin.once('data', () => { void writer.close().then(() => process.exit(0)); });
} catch (error) {
  process.stdout.write(JSON.stringify({ state: 'rejected', message: error instanceof Error ? error.message : String(error) }) + '\n');
  process.exitCode = 2;
}
