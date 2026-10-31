import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { testDatabaseUrl } from '../tests/integration/database.mts';

// Fail, rather than skip, when the isolated real-database gate is unconfigured.
const suite = process.argv[2];
if (suite !== 'pagination' && suite !== 'replies' && suite !== 'browser' && suite !== 'auth' && suite !== 'external' && suite !== 'management' && suite !== 'attachments' && suite !== 'live-input' && suite !== 'agent-capabilities' && suite !== 'feishu' && suite !== 'mcp' && suite !== 'persona' && suite !== 'memory-reset' && suite !== 'usage' && suite !== 'unstuck') throw Error('Choose pagination, replies, browser, auth, external, management, attachments, live-input agent-capabilities, feishu, mcp, persona, memory-reset, usage or unstuck real-browser suite');
const connectionString = testDatabaseUrl();
// Resolve the installed browser before replacing HOME. CI always uses the
// official Playwright installation for existing UI gates. The replies gate
// requires Chromium's sandbox, supported by CI's installed official Chrome
// (downloaded Chromium is restricted by the runner's AppArmor policy).
const executablePath = process.env['CI'] ? ((suite === 'replies' || suite === 'pagination') ? '/usr/bin/google-chrome' : chromium.executablePath())
  : process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? chromium.executablePath();
const home = await mkdtemp(path.join(os.tmpdir(), `mira-${suite}-web-e2e-`));
try {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: home, TMPDIR: home, TMP: home, TEMP: home, XDG_CACHE_HOME: home,
    MIRA_TEST_DATABASE_URL: connectionString, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: executablePath,
    ...(suite === 'browser' ? { MIRA_AGENT_BROWSER_EXECUTABLE: process.env['MIRA_AGENT_BROWSER_EXECUTABLE'], MIRA_BROWSER_EXECUTABLE_PATH: process.env['MIRA_BROWSER_EXECUTABLE_PATH'] ?? executablePath } : {}),
  };
  const child = spawn(process.execPath, [
    'node_modules/@playwright/test/cli.js', 'test', '--config', `tests/e2e/${suite}-real.config.ts`, ...process.argv.slice(3),
  ], { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', env });
  process.exitCode = await new Promise<number>((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => resolve(code ?? 1));
  });
} finally { await rm(home, { recursive: true, force: true }); }
