import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertJson, assertRecord } from '@mira/context';

test('runtime envelope accepts opaque JSON without interpreting provider data', () => {
  const record = { formatVersion: 1, runtime: 'pi', runtimeVersion: '1.0.2', id: 'one', parentId: null,
    kind: 'message', occurredAt: '2026-10-05T00:00:00.000Z', payload: { opaque: ['text', 42, false, null], signature: 'synthetic' } };
  assertRecord(record);
  assert.deepEqual(JSON.parse(JSON.stringify(record)), record);
});

test('unknown envelope versions fail closed, even for otherwise valid JSON', () => {
  assert.throws(() => assertRecord({ formatVersion: 2 }), /migration required/);
  for (const value of [null, [], {}, { formatVersion: 1, payload: {} }]) assert.throws(() => assertRecord(value));
});

test('JSON validation rejects values that would silently disappear or change', () => {
  const circular: Record<string, unknown> = {}; circular['self'] = circular;
  for (const value of [undefined, NaN, Infinity, new Date(), 1n, () => {}, { undefined }, circular, new Array(2), { [Symbol('hidden')]: 1 }]) {
    assert.throws(() => assertJson(value));
  }
  const repeated = { value: 'valid' };
  assert.doesNotThrow(() => assertJson({ first: repeated, second: repeated }));
});
