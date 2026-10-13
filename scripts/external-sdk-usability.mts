/** Actual loopback HTTP + SDK authoring fixture. Event storage is an in-memory
 * synthetic stand-in, not PostgreSQL or a model. Never use a real Mira home. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createLocalHttp, type WebBackend } from '../apps/server/src/http.ts';
import { ExternalAccessStore } from '../apps/server/src/external-access.ts';
import { createExternalIngress } from '../apps/server/src/external-ingress.ts';
import { PersistenceError } from '@mira/persistence';
import type { LifeEvent, WakeReceipt } from '@mira/life';

if (process.argv.includes('--help')) {
  console.log('node scripts/external-sdk-usability.mts [--port 43219] [--root <previous-fixture-root> --run <script-path>]\nCreates an isolated blank temporary home; starts real loopback HTTP with production access/ingress. No database, model, or real credentials. stdout gives paths; evidence.jsonl records synthetic operations without secrets. Ctrl+C stops the listener; files remain for evidence review.');
} else {
  const args = process.argv.slice(2); const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!key || !['--port', '--root', '--run'].includes(key) || !value || flags.has(key)) throw Error('Use --help');
    flags.set(key, value);
  }
  const port = Number(flags.get('--port') ?? '43219');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid fixture port');
  const previous = flags.get('--root');
  const root = previous ? await realpath(previous) : await mkdtemp(path.join(os.tmpdir(), 'mira-external-usability-'));
  if (path.dirname(root) !== await realpath(os.tmpdir()) || !/^mira-external-usability-[A-Za-z0-9]+$/.test(path.basename(root))) throw Error('Use an isolated fixture root');
  const home = path.join(root, 'home'); await mkdir(home, { mode: 0o700, recursive: true });
  const evidence = path.join(root, 'evidence.jsonl'); await writeFile(evidence, '', { mode: 0o600, flag: 'a' });
  const sourceDirectory = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  const records = new Map<string, { event: LifeEvent; wake: WakeReceipt | null }>();
  const wakeIds = new Set<string>();
  const items: Awaited<ReturnType<WebBackend['timeline']>>['items'] = [];
  let operations = Promise.resolve(); let kicks = 0;
  const ingress = createExternalIngress({ receive(event, wake) {
    const input = structuredClone({ event, wake: wake ?? null });
    const run = operations.then(async () => {
      const old = records.get(event.id);
      if (old && !isDeepStrictEqual(old, input)) throw new PersistenceError('duplicate', 'Synthetic conflict');
      if (!old && wake && wakeIds.has(wake.id)) throw new PersistenceError('duplicate', 'Synthetic conflict');
      const receipt = old ? 'duplicate' : 'inserted';
      if (!old) {
        records.set(event.id, input); if (wake) wakeIds.add(wake.id);
        const payload = event.payload;
        if (event.type === 'external.notification' && payload && typeof payload === 'object' && !Array.isArray(payload) && payload['operation'] === 'notification') {
          items.push({ id: randomUUID(), role: 'notice', text: `外部程序 ${payload['senderId']}\n${payload['text']}`, occurredAt: event.occurredAt });
        }
      }
      await appendFile(evidence, `${JSON.stringify({ ...input, receipt, kicksBeforeCallback: kicks })}\n`);
      return receipt;
    });
    operations = run.then(() => {}, () => {});
    return run;
  } }, () => { kicks++; });
  const backend: WebBackend = {
    status: async () => ({ state: 'idle', mode: 'synthetic', model: null, error: null }),
    timeline: async () => ({ items: structuredClone(items), nextCursor: null }),
    submit: async () => { throw Error('This fixture only accepts external operations'); },
    settings: async () => ({ revision: '0'.repeat(64), selection: null, configuration: { builtinCredentials: {}, customConnections: [] } }),
    saveSettings: async () => { throw Error('No settings in fixture'); }, discover: async () => { throw Error('No network in fixture'); },
  };
  const access = new ExternalAccessStore({ miraHome: home, sourceDirectory });
  const app = createLocalHttp({ backend, port, external: { access, ingress } });
  await app.listen({ host: '127.0.0.1', port });
  console.log(JSON.stringify({ fixture: 'synthetic-memory-not-postgresql', root, home, evidence, baseUrl: `http://127.0.0.1:${port}`, sdkEntry: path.join(sourceDirectory, 'packages/external-sdk/src/index.ts') }));
  const run = flags.get('--run');
  if (run) {
    // Some executor sessions have separate loopback namespaces. Run the authored
    // program beside its listener; this does not mock the HTTP transport.
    try {
      const child = spawn(process.execPath, [run], { cwd: sourceDirectory, env: {
        PATH: process.env['PATH'], HOME: home, TMPDIR: root, XDG_CACHE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
        MIRA_EXTERNAL_URL: `http://127.0.0.1:${port}`,
        ...(process.env['MIRA_EXTERNAL_CREDENTIAL_FILE'] ? { MIRA_EXTERNAL_CREDENTIAL_FILE: process.env['MIRA_EXTERNAL_CREDENTIAL_FILE'] } : {}),
      }, stdio: 'inherit' });
      process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
    } finally { await app.close(); }
  } else {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
  }
}
