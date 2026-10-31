import { defineConfig } from '@playwright/test';

// Real PostgreSQL, the production life host and HTTP composition; only model
// output is scripted. Each test owns its database schema and MIRA_HOME.
export default defineConfig({
  testDir: '.', testMatch: 'memory-reset-real.spec.ts', fullyParallel: false,
  workers: 1, retries: 0, timeout: 180_000, expect: { timeout: 15_000 },
  reporter: [['list']], outputDir: '../../test-results/memory-reset-real',
  use: {
    headless: true, timezoneId: 'UTC', viewport: { width: 1440, height: 1000 },
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH']
      ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
  },
});
