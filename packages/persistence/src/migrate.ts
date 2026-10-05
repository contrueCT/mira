import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';

export interface MigrationOptions {
  connectionString: string;
  schema?: string;
  direction: 'up' | 'down';
}

/** Explicit connection only. Down is destructive and is never run automatically. */
export async function migrate(options: MigrationOptions): Promise<void> {
  if (!options.connectionString) throw new Error('An explicit PostgreSQL connectionString is required');
  const schema = options.schema ?? 'public';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Invalid PostgreSQL schema');
  await runner({
    databaseUrl: options.connectionString,
    dir: fileURLToPath(new URL('../migrations/', import.meta.url)),
    direction: options.direction,
    count: options.direction === 'down' ? 1 : Infinity,
    migrationsTable: 'mira_migrations',
    schema,
    createSchema: true,
    checkOrder: true,
    singleTransaction: true,
    log: () => {},
  });
}
