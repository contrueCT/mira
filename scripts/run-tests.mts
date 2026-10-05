import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const integration = process.argv.includes('--integration');
if (integration && !process.env['MIRA_TEST_DATABASE_URL']) throw new Error('Set MIRA_TEST_DATABASE_URL to an isolated local mira_test database; integration tests never silently skip');
const home = await mkdtemp(path.join(os.tmpdir(), 'mira-tests-'));
try {
  const directories = integration ? ['integration', 'recovery'] : ['foundation', 'unit'];
  const files = (await Promise.all(directories.map(async (directory) => (await readdir(`tests/${directory}`))
    .filter((file) => file.endsWith('.test.mts')).map((file) => `tests/${directory}/${file}`)))).flat();
  if (!files.length) throw new Error('No tests found');
  // Tests and their children get no provider keys, proxy settings, or real user HOME.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: home, TMPDIR: home,
    XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
    NODE_OPTIONS: `--import=${path.resolve('tests/deny-model-network.mts')}`,
    npm_execpath: process.env['npm_execpath'],
    ...(integration ? { MIRA_TEST_DATABASE_URL: process.env['MIRA_TEST_DATABASE_URL'] } : {}),
  };
  const child = spawn(process.execPath, ['--test', '--test-concurrency=1', '--test-timeout=60000', ...files], { stdio: 'inherit', env });
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code ?? 1));
  });
} finally { await rm(home, { recursive: true, force: true }); }
