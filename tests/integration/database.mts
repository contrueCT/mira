import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { migrate, PostgresPersistence } from '@mira/persistence';
import type { DurableWriter } from '@mira/life';

/** No default URL, no production-shaped database names, no remote hosts. */
export function testDatabaseUrl(): string {
  const input = process.env['MIRA_TEST_DATABASE_URL'];
  if (!input) throw new Error('Set MIRA_TEST_DATABASE_URL explicitly to the isolated localhost mira_test database');
  const url = new URL(input);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/mira_test') {
    throw new Error('Integration tests only accept an explicit localhost PostgreSQL URL for database mira_test');
  }
  // URL options could silently redirect a supposedly local URL to another server.
  if (url.search) throw new Error('Test database URL query parameters are not permitted');
  return input;
}

export async function createTestDatabase() {
  const connectionString = testDatabaseUrl();
  const schema = `mira_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Client({ connectionString, application_name: 'mira-synthetic-test-admin' });
  await admin.connect();
  const writers: DurableWriter[] = [];
  const store = new PostgresPersistence({ connectionString, schema });
  try {
    await migrate({ connectionString, schema, direction: 'up' });
    await admin.query(`SET search_path TO "${schema}"`);
  } catch (error) {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await admin.end();
    throw error;
  }
  return {
    connectionString, schema, admin, store,
    async acquire(miraId = 'synthetic-mira') {
      const writer = await store.acquire(miraId); writers.push(writer); return writer;
    },
    async close() {
      await Promise.all(writers.map((writer) => writer.close()));
      try { await admin.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await admin.end(); }
    },
  };
}
