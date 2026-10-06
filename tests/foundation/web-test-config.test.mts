import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import configuration from '../e2e/playwright.config.ts';

test('Playwright fixture command resolves from the repository rather than the config directory', async () => {
  const server = configuration.webServer;
  assert.ok(server && !Array.isArray(server));
  assert.equal(path.resolve(server.cwd!), process.cwd());
  assert.equal(server.command, 'node tests/e2e/fixture-server.mts');
  await access(path.resolve(server.cwd!, 'tests/e2e/fixture-server.mts'));
  assert.equal(server.url, 'http://127.0.0.1:3211/');
  assert.equal(server.reuseExistingServer, false);
});
