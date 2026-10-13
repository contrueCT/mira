import { defineConfig } from '@playwright/test';

// Separate from the UI-only fixture: this gate requires real PostgreSQL and
// starts the production HTTP/service composition inside the test itself.
export default defineConfig({
  testDir: '.', testMatch: 'attachments-real.spec.ts', fullyParallel: false,
  workers: 1, retries: 0, timeout: 120_000, expect: { timeout: 10_000 },
  reporter: [['list']], outputDir: '../../test-results/attachments-real',
  use: {
    headless: true, timezoneId: 'UTC', viewport: { width: 1440, height: 1000 },
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
      ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
});
