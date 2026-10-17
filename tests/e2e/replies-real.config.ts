import { defineConfig } from '@playwright/test';

// A separate real browser → HTTP → PostgreSQL → runtime gate. Only model
// responses are synthetic; an absent database or browser fails rather than skips.
export default defineConfig({
  testDir: '.', testMatch: 'replies-real.spec.ts', fullyParallel: false,
  workers: 1, retries: 0, timeout: 120_000, expect: { timeout: 10_000 },
  reporter: [['list']], outputDir: '../../test-results/replies-real',
  use: {
    headless: true, timezoneId: 'UTC', viewport: { width: 1440, height: 1000 },
    launchOptions: {
      chromiumSandbox: true,
      ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
        ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {}),
    },
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
});
