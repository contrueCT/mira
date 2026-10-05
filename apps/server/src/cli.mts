import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemo } from './index.ts';

if (process.argv.includes('--help')) {
  console.log('Mira synthetic PostgreSQL demo\nMIRA_DEMO_DATABASE_URL=<explicit localhost mira_demo or mira_test URL> MIRA_DEMO_SPOOL=<outside source/home directory> pnpm demo <stable-input-id> <message>\nOptional: MIRA_DEMO_SCHEMA (default mira_demo), MIRA_DEMO_MIRA_ID (default synthetic-mira), MIRA_DEMO_MAX_INLINE_BYTES, MIRA_DEMO_CWD (existing directory), MIRA_DEMO_MEMORY + MIRA_DEMO_STATE (optional paired roots), MIRA_DEMO_STATE_FILES (JSON array of relative paths)\nRepeat the same input ID/message to verify idempotency. No real model or credentials are used.');
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
  const stateRoot = process.env['MIRA_DEMO_STATE'];
  if (Boolean(memoryRoot) !== Boolean(stateRoot)) throw Error('Memory and State roots must be configured together');
  const stateFiles: unknown = JSON.parse(process.env['MIRA_DEMO_STATE_FILES'] ?? '[]');
  if (!Array.isArray(stateFiles) || stateFiles.some(file => typeof file !== 'string')) throw Error('MIRA_DEMO_STATE_FILES must be a JSON array of relative paths');
  if (stateFiles.length && !memoryRoot) throw Error('State files require configured Memory and State roots');
  const result = await runDemo({
    connectionString, schema, miraId: process.env['MIRA_DEMO_MIRA_ID'] ?? 'synthetic-mira', spoolDirectory: path.resolve(spoolDirectory),
    ...(memoryRoot && stateRoot ? { memory: { memoryRoot: path.resolve(memoryRoot), stateRoot: path.resolve(stateRoot), stateFiles } } : {}),
    ...(process.env['MIRA_DEMO_CWD'] ? { workingDirectory: path.resolve(process.env['MIRA_DEMO_CWD']) } : {}),
    sourceDirectory: fileURLToPath(new URL('../../../', import.meta.url)),
    // Stable synthetic event time ensures exact retries have identical evidence.
    events: [{ event: { id: inputId, type: 'demo.message', source: 'user', occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: message } }, wake: { id: `wake:${inputId}`, reason: 'synthetic CLI input' } }],
    ...(max === undefined ? {} : { maxInlineBytes: Number(max) }),
  });
  console.log(JSON.stringify(result));
}
