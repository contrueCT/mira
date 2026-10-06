import { listBuiltinCatalog, getBuiltinCatalogModel } from './model-catalog.ts';
import { readModelConfiguration } from './model-config.ts';
import { discoverModels } from './model-discovery.ts';

const help = `Mira model catalog and custom discovery (JSON output)
pnpm models list [provider]
pnpm models details <provider> <model-id>
pnpm models custom <config.json>
pnpm models discover <config.json> <connection-id>

list/details read Pi's bundled chat catalog offline, without credentials.
custom validates and lists explicitly configured custom models offline.
discover sends an authenticated GET only to the chosen custom connection and never saves changes.
It requires that connection's own API-key environment variable. Manual IDs always remain available.
See docs/development/models.md for protocol-specific base URL semantics and required model limits.
No command invokes a generative model. The demo remains synthetic.`;

async function main(): Promise<void> {
  const [command, first, second, ...extra] = process.argv.slice(2);
  if (!command || command === '--help') { if (first) throw Error('Unexpected arguments'); console.log(help); return; }
  if (extra.length) throw Error('Unexpected arguments');
  if (command === 'list' && second === undefined) { console.log(JSON.stringify(listBuiltinCatalog(first), null, 2)); return; }
  if (command === 'details' && first && second) { console.log(JSON.stringify(getBuiltinCatalogModel(first, second), null, 2)); return; }
  if (command === 'custom' && first && second === undefined) {
    const config = await readModelConfiguration(first);
    console.log(JSON.stringify({ connections: config.customConnections.map(connection => ({ id: connection.id, name: connection.name ?? connection.id, baseUrl: connection.baseUrl, protocol: connection.api, models: connection.models, pricing: 'unknown', credential: 'explicit environment reference required' })) }, null, 2)); return;
  }
  if (command === 'discover' && first && second) {
    const config = await readModelConfiguration(first);
    const connection = config.customConnections.find(item => item.id === second);
    if (!connection) throw Error('Unknown custom connection');
    console.log(JSON.stringify(await discoverModels(connection), null, 2)); return;
  }
  throw Error('Invalid command or arguments. Run pnpm models --help.');
}
try { await main(); } catch (error) {
  // Configuration paths, file contents, HTTP response bodies and keys never
  // become CLI diagnostics. Public module errors are already sanitized.
  const safe = error instanceof Error && !('code' in error) && error.name === 'Error' ? error.message : 'Unable to read or use model configuration';
  console.error(safe); process.exitCode = 1;
}
