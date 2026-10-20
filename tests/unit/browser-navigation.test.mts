import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBrowserAddress } from '../../apps/web/src/browserAddress.ts';

const error = '只支持 http 或 https 网址';

test('normalizeBrowserAddress accepts credential-free http(s) and rejects every other address', () => {
  assert.deepEqual(normalizeBrowserAddress('  example.org  '), { url: 'https://example.org/' });
  assert.deepEqual(normalizeBrowserAddress('http://example.org/a'), { url: 'http://example.org/a' });
  assert.deepEqual(normalizeBrowserAddress('https://example.org/a'), { url: 'https://example.org/a' });
  assert.deepEqual(normalizeBrowserAddress('HTTP://Example.ORG/a'), { url: 'http://example.org/a' });
  for (const input of [
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x', 'chrome://settings', 'about:blank', 'ftp://example.org/',
    'https://user:pw@x.test/', 'https://user@x.test/', '', '   ', 'http://', 'https://', 'http:///', 'x'.repeat(2049),
    'example.org/' + 'a'.repeat(2048),
  ]) assert.deepEqual(normalizeBrowserAddress(input), { error }, input);
});
