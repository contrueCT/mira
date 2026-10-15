import { defineConfig } from '@playwright/test';

// Real PostgreSQL, production HTTP/auth, and pinned official agent-browser.
// No fixture WebSocket, driver, browser page, or frame substitution.
export default defineConfig({
  testDir: '.', testMatch: 'browser-real.spec.ts', fullyParallel: false, workers: 1,
  retries: 0, timeout: 180_000, expect: { timeout: 15_000 }, reporter: [['list']],
  outputDir: '../../test-results/browser-real',
  use: { headless: true, timezoneId: 'UTC', viewport: { width: 1440, height: 1000 },
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
