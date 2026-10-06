import assert from 'node:assert/strict';
import test from 'node:test';
import { hasUsableApiKey, sameCredentialTarget, validateApiKey, withApiKey } from '../src/credentials.ts';
import type { CustomConnection } from '../src/types.ts';

test('blank keys retain saved credentials; replacement and removal are explicit write operations', () => {
  const saved = { hasApiKey: true };
  assert.deepEqual(withApiKey(saved, ''), saved);
  assert.deepEqual(withApiKey(saved, 'dummy-test-only'), { ...saved, apiKey: 'dummy-test-only' });
  assert.deepEqual(withApiKey(saved, null), { ...saved, apiKey: null });
  assert.equal(hasUsableApiKey(saved), true);
  assert.equal(hasUsableApiKey(withApiKey(saved, null)), false);
  assert.equal(hasUsableApiKey(withApiKey({ hasApiKey: false }, 'dummy-test-only')), true);
  assert.equal(hasUsableApiKey({ hasApiKey: false }), false);
  assert.deepEqual(withApiKey(withApiKey(saved, 'dummy-test-only'), undefined), saved);
});

test('API key validation never includes the entered value in diagnostics', () => {
  for (const apiKey of ['dummy key with spaces', 'dummy\nkey', 'sk-ant-oat-dummy-oauth']) {
    assert.throws(() => validateApiKey({ hasApiKey: false, apiKey }), error => error instanceof Error && !error.message.includes(apiKey));
  }
  assert.doesNotThrow(() => validateApiKey({ hasApiKey: false, apiKey: 'dummy-key-only' }));
});

test('credential targets bind all destination fields but not display names or model edits', () => {
  const original: CustomConnection = { id: 'test', baseUrl: 'https://example.test/v1', api: 'openai-completions', modelsUrl: 'https://example.test/models', hasApiKey: true, models: [] };
  assert.equal(sameCredentialTarget(original, { ...original, name: 'Renamed', models: [] }), true);
  for (const patch of [{ id: 'other' }, { baseUrl: 'https://other.test/v1' }, { api: 'openai-responses' as const }, { modelsUrl: 'https://example.test/other-models' }]) {
    assert.equal(sameCredentialTarget(original, { ...original, ...patch }), false);
  }
});
