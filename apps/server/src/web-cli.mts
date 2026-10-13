import path from 'node:path';
import os from 'node:os';
import { mkdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { browserLaunchEnvironment } from './browser-launch.ts';
import { localDatabaseUrl } from './web-config.ts';
import { readWebExtensionConfiguration } from './web-extensions.ts';
import { createLocalHttp } from './http.ts';
import { LocalWebService } from './web-service.ts';
import { ExternalAccessStore } from './external-access.ts';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`Mira local web\n\nMIRA_DATABASE_URL=postgres://...@127.0.0.1/mira pnpm start [--synthetic] [--no-open] [--port 3210]\n\nRequires Node 24 and an existing local PostgreSQL database. Startup applies current migrations; it never creates or resets a database.\nMIRA_HOME defaults to ~/.mira, outside the source repository; stores protected plaintext model settings/API keys, Memory Git, overflow inputs, persistent extensions.json and extension-artifacts/, and ordinary user skills under skills/. Repository skills load first; metadata refreshes at each natural model request.\nOptional MIRA_SCHEMA (default mira), MIRA_CWD (default current directory), MIRA_EXTENSIONS (authoritative trusted extension configuration file override). Without it, the web app initializes an empty persistent extension host under MIRA_HOME; management tools are available without installing or activating new code.\nDreaming memory housekeeping is enabled with Memory: after new explicit user/extension/external Wakes, 30 minutes idle, and either three successful compactions or more than 24 hours since the previous trigger. First enablement establishes a baseline; event-only records and external notifications do not trigger housekeeping.\nUse --synthetic to test the UI with persisted fake replies and no real model calls.\nIn live mode, select a model and enter its API key in Settings. The server saves the key in a private models.json (0600); the browser receives only saved-key status. Settings must be outside the source and Memory repositories. Local OS-account access can still read the plaintext file.\nExternal program ingress shares this loopback listener and starts disabled. Use pnpm external-access --help to manage the private local configuration through ordinary Shell; no token is printed. Changes apply to subsequent authentication without restarting Mira. External notifications appear as source-labelled Timeline notices without waking the model.\nOnly http://127.0.0.1:<port> is served. No accounts, public binding, TLS proxy, deployment or token streaming.\nCtrl+C stops accepting requests, cancels the current run and closes the durable writer; unknown effects are not replayed.`);
} else {
  let port = 3210;
  let synthetic = false; let openBrowser = true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--synthetic') synthetic = true;
    else if (arg === '--no-open') openBrowser = false;
    else if (arg === '--port') {
      const value = args[++index];
      if (!value || !/^\d+$/.test(value) || Number(value) < 1024 || Number(value) > 65535) throw Error('Port must be an integer from 1024 to 65535');
      port = Number(value);
    } else throw Error('Unknown option; run pnpm start --help');
  }
  const connectionString = localDatabaseUrl(process.env['MIRA_DATABASE_URL']);
  const schema = process.env['MIRA_SCHEMA'] ?? 'mira';
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw Error('Invalid MIRA_SCHEMA');
  const sourceDirectory = await realpath(fileURLToPath(new URL('../../../', import.meta.url)));
  const home = path.resolve(process.env['MIRA_HOME'] ?? path.join(os.homedir(), '.mira'));
  // Check the existing parent before creating data. setupMemoryWorkspace also
  // enforces independent repository identity and disjoint data roots.
  const lexical = path.relative(sourceDirectory, home);
  if (lexical === '' || (!lexical.startsWith(`..${path.sep}`) && lexical !== '..' && !path.isAbsolute(lexical))) throw Error('MIRA_HOME must be outside the source repository');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const root = await realpath(home);
  const relative = path.relative(sourceDirectory, root);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw Error('MIRA_HOME must be outside the source repository');
  const extensions = await readWebExtensionConfiguration(root, process.env['MIRA_EXTENSIONS']);
  const access = new ExternalAccessStore({ miraHome: root, sourceDirectory, memoryRoot: path.join(root, 'memory'),
    ...(extensions.artifactsDirectory ? { artifactsDirectory: extensions.artifactsDirectory } : {}) });
  const service = await LocalWebService.open({ connectionString, schema, miraId: 'mira', sourceDirectory,
    spoolDirectory: path.join(root, 'wake-input'), settingsFile: path.join(root, 'models.json'), memoryRoot: path.join(root, 'memory'), miraHome: root,
    workingDirectory: path.resolve(process.env['MIRA_CWD'] ?? process.cwd()), synthetic, extensions });
  const app = createLocalHttp({ backend: service, port, assetsDirectory: fileURLToPath(new URL('../../web/dist/', import.meta.url)), external: { access, ingress: service.external } });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return; stopping = true;
    console.log('Stopping Mira; waiting for cancellation and durable writer cleanup…');
    const closing = app.close();
    await service.close(); await closing;
  };
  process.once('SIGINT', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { void shutdown().catch(() => { process.exitCode = 1; }); });
  try {
    const url = await app.listen({ host: '127.0.0.1', port });
    console.log(`Mira ${synthetic ? 'synthetic' : 'live'} mode: ${url}`);
    console.log('Tools use this OS account’s permissions. Keep this terminal open.');
    if (openBrowser) {
      const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
      const browserArgs = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
      const child = spawn(command, browserArgs, { stdio: 'ignore', detached: true, shell: false, env: browserLaunchEnvironment(process.env) });
      child.once('error', () => console.log(`Open ${url} in your browser.`));
      child.once('exit', code => { if (code !== 0) console.log(`Open ${url} in your browser.`); });
      child.unref();
    }
  } catch { await shutdown(); throw Error('Could not start the localhost listener; check the port and database configuration'); }
}
