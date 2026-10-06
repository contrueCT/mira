import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 30_000,
  reporter: [['list']], outputDir: '../../test-results',
  use: { baseURL: 'http://127.0.0.1:3211', headless: true,
    launchOptions: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/e2e/fixture-server.mts', url: 'http://127.0.0.1:3211/', reuseExistingServer: false, timeout: 30_000 },
});
