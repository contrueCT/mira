import { Client } from 'pg';
import { PostgresPersistence } from '@mira/persistence';
import { testDatabaseUrl } from '../database.mts';

// Synthetic child pauses at the exact protocol boundary. Parent SIGKILL, rather
// than a graceful writer close, proves server-side transaction recovery.
const [schema, applicationName, owner, boundary] = process.argv.slice(2);
if (!schema || !applicationName || !owner || !['before', 'after'].includes(boundary ?? '')) throw new Error('Invalid scheduling worker arguments');
const writer = await new PostgresPersistence({ connectionString: testDatabaseUrl(), schema, applicationName }).acquire('synthetic-mira');
const query = Client.prototype.query;
async function stopAtBoundary(): Promise<never> {
  process.send?.({ boundary });
  return new Promise<never>(() => {});
}
Client.prototype.query = (async function(this: Client, ...args: unknown[]) {
  if (args[0] === 'COMMIT' && boundary === 'before') return stopAtBoundary();
  const result: unknown = await Reflect.apply(query, this, args);
  if (args[0] === 'COMMIT') return stopAtBoundary();
  return result;
}) as typeof Client.prototype.query;
await writer.dispatchScheduledDeliveries([owner]);
throw new Error('Scheduling worker crossed its crash boundary');
