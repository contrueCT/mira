import assert from 'node:assert/strict';
import test from 'node:test';
import { browserUuid } from '../src/uuid.ts';

test('browser UUID uses secure random bytes without requiring the HTTPS-only randomUUID API', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  const source = globalThis.crypto;
  try {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: source.getRandomValues.bind(source) } });
    const ids = new Set(Array.from({ length: 100 }, () => browserUuid()));
    assert.equal(ids.size, 100);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  } finally { if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor); }
});
