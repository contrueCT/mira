import assert from 'node:assert/strict';
import test from 'node:test';
import { ownDraft, secretUpdates } from '../src/extension-settings-drafts.ts';

test('prototype-named fields start blank and untouched secrets are never cleared', () => {
  const keys = ['constructor', 'toString', 'valueOf', '__proto__'];
  for (const key of keys) assert.equal(ownDraft({}, key), undefined);
  assert.deepEqual(secretUpdates(keys, {}, {}), {});
  const secrets = Object.fromEntries(keys.map(key => [key, `synthetic-${key}`]));
  assert.deepEqual(secretUpdates(keys, secrets, {}), secrets);
  const clear = { ['constructor']: true, ['__proto__']: true };
  assert.deepEqual(secretUpdates(keys, secrets, clear), { constructor: null, toString: 'synthetic-toString', valueOf: 'synthetic-valueOf', ['__proto__']: null });
  assert.equal(Object.getPrototypeOf(secretUpdates(keys, secrets, clear)), Object.prototype);
  assert.deepEqual(secretUpdates(keys, { constructor: '' }, {}), {});
});
