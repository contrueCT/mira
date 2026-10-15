import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: 'feishu-real.spec.ts', fullyParallel: false, workers: 1, retries: 0,
  timeout: 90_000, expect: { timeout: 10_000 }, reporter: [['list']], outputDir: '../../test-results/feishu-real',
  use: { headless: true, timezoneId: 'UTC', viewport: { width: 1440, height: 1000 },
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
});
