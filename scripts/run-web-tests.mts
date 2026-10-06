import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const home = await mkdtemp(path.join(os.tmpdir(), 'mira-web-e2e-'));
try {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'], HOME: home, TMPDIR: home, XDG_CACHE_HOME: home,
    ...(process.env['CI'] ? { CI: process.env['CI'] } : {}),
    // Resolve the installed browser before replacing HOME with test isolation.
    PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ?? chromium.executablePath(),
    ...(process.env['PLAYWRIGHT_BROWSERS_PATH'] ? { PLAYWRIGHT_BROWSERS_PATH: process.env['PLAYWRIGHT_BROWSERS_PATH'] } : {}) };
  const child = spawn(process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/playwright.config.ts'], { stdio: 'inherit', env });
  process.exitCode = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
} finally { await rm(home, { recursive: true, force: true }); }
