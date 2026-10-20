import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'pagination-real.spec.ts', workers: 1, retries: 0, timeout: 180_000,
  reporter: [['list']], outputDir: '../../test-results/pagination-real',
  use: { headless: true, timezoneId: 'UTC', viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {}) },
    trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
