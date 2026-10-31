import path from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { PostgresLives, migrate } from '@mira/persistence';
import { localDatabaseUrl, resolveWebMiraHome } from './web-config.ts';
import { restoreArchivedLife } from './life-host.ts';

const help = `Mira lives (ADR 0047)

pnpm life list                 List every life of the local Mira, newest last.
pnpm life restore <mira-id>    Make an archived life active again (stop Mira first).

Uses MIRA_DATABASE_URL, MIRA_SCHEMA (default mira) and MIRA_HOME (default ~/.mira),
the same as pnpm start. Restore archives the current life's Memory and overflow
inputs under MIRA_HOME/archive and moves the restored life's archived files back.
Nothing is deleted; there is no Web list of old lives and no purge command.`;
const [command, target, ...rest] = process.argv.slice(2);
if (!command || command === '--help' || command === 'help') console.log(help);
else {
  const connectionString = localDatabaseUrl(process.env['MIRA_DATABASE_URL']);
  const schema = process.env['MIRA_SCHEMA'] ?? 'mira';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid MIRA_SCHEMA');
  const home = resolveWebMiraHome(process.env['MIRA_HOME']);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const root = await realpath(home);
  if (command === 'list' && target === undefined) {
    await migrate({ connectionString, schema, direction: 'up' });
    const lives = await new PostgresLives({ connectionString, schema }).list('mira');
    if (!lives.length) console.log('Only the original life (mira, generation 0) exists.');
    for (const life of lives) console.log([life.active ? '*' : ' ', life.miraId, `generation ${life.generation}`, `created ${life.createdAt}`,
      life.archivedAt ? `archived ${life.archivedAt}` : 'active', life.archivePath ?? ''].join('  ').trimEnd());
  } else if (command === 'restore' && target && !rest.length) {
    const result = await restoreArchivedLife({ connectionString, schema, slot: 'mira', miraHome: root, memoryRoot: path.join(root, 'memory'), spoolDirectory: path.join(root, 'wake-input'), target });
    console.log(`Restored ${result.to}. The previous life ${result.from} is archived at ${result.archivePath}. Start Mira with pnpm start.`);
  } else throw Error('Unknown command; run pnpm life --help');
}
