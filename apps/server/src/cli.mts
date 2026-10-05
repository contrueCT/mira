import { readExtensionConfiguration } from '@mira/extension-host';
import type { DemoOptions } from './index.ts';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemo } from './index.ts';

if (process.argv.includes('--help')) {
  console.log('Mira synthetic PostgreSQL demo\nMIRA_DEMO_DATABASE_URL=<explicit localhost mira_demo or mira_test URL> MIRA_DEMO_SPOOL=<outside source/home directory> pnpm demo <stable-input-id> <message>\nOptional: MIRA_DEMO_SCHEMA (default mira_demo), MIRA_DEMO_MIRA_ID (default synthetic-mira), MIRA_DEMO_MAX_INLINE_BYTES, MIRA_DEMO_CWD (existing directory), MIRA_DEMO_MEMORY (optional Memory root), MIRA_DEMO_EXTENSIONS (trusted local JSON configuration file; source HMR needs node --expose-internals)\nRepeat the same input ID/message to verify idempotency. No real model or credentials are used.');
} else {
  const connectionString = process.env['MIRA_DEMO_DATABASE_URL'];
  const spoolDirectory = process.env['MIRA_DEMO_SPOOL'];
  const [inputId, message, ...extra] = process.argv.slice(2);
  if (!connectionString || !spoolDirectory || !inputId || !message || extra.length) throw Error('Set explicit demo database/spool and provide a stable input ID plus message. Run pnpm demo --help.');
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['/mira_demo', '/mira_test'].includes(url.pathname) || url.search) throw Error('Demo requires an explicit localhost mira_demo or mira_test database without URL options');
  const schema = process.env['MIRA_DEMO_SCHEMA'] ?? 'mira_demo';
  if (!/^mira_demo(?:_[a-z0-9_]+)?$/.test(schema)) throw Error('Demo schema must be mira_demo or mira_demo_<suffix>');
  const max = process.env['MIRA_DEMO_MAX_INLINE_BYTES'];
  const memoryRoot = process.env['MIRA_DEMO_MEMORY'];
  if (process.env['MIRA_DEMO_STATE'] !== undefined || process.env['MIRA_DEMO_STATE_FILES'] !== undefined) {
    console.warn('MIRA_DEMO_STATE and MIRA_DEMO_STATE_FILES are retired and ignored. Existing State files are left untouched; no State is read or promoted into Memory.');
  }
  const extensionFile = process.env['MIRA_DEMO_EXTENSIONS'];
  const extensions: DemoOptions['extensions'] = extensionFile ? await readExtensionConfiguration(extensionFile) : undefined;
  if (extensions && (!Array.isArray(extensions.entries) || (extensions.hmr !== undefined && typeof extensions.hmr !== 'boolean'))) throw Error('Extension configuration requires entries[] and optional hmr boolean');
  const result = await runDemo({
    ...(extensions ? { extensions } : {}),
    connectionString, schema, miraId: process.env['MIRA_DEMO_MIRA_ID'] ?? 'synthetic-mira', spoolDirectory: path.resolve(spoolDirectory),
    ...(memoryRoot ? { memory: { memoryRoot: path.resolve(memoryRoot) } } : {}),
    ...(process.env['MIRA_DEMO_CWD'] ? { workingDirectory: path.resolve(process.env['MIRA_DEMO_CWD']) } : {}),
    sourceDirectory: fileURLToPath(new URL('../../../', import.meta.url)),
    // Stable synthetic event time ensures exact retries have identical evidence.
    events: [{ event: { id: inputId, type: 'demo.message', source: 'user', occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: message } }, wake: { id: `wake:${inputId}`, reason: 'synthetic CLI input' } }],
    ...(max === undefined ? {} : { maxInlineBytes: Number(max) }),
  });
  console.log(JSON.stringify(result));
}
