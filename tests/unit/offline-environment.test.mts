import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { test } from 'node:test';

test('test runner blocks HTTP providers and supplies an isolated credential-free environment', () => {
  assert.throws(() => http.get('http://invalid.invalid'), /may not call HTTP/);
  assert.throws(() => https.get('https://invalid.invalid'), /may not call HTTP/);
  assert.throws(() => fetch('https://invalid.invalid'), /may not call HTTP/);
  for (const key of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GOOGLE_API_KEY', 'AWS_ACCESS_KEY_ID', 'HTTPS_PROXY', 'GH_TOKEN']) assert.equal(process.env[key], undefined);
  assert.match(process.env['HOME'] ?? '', /mira-tests-/);
});
