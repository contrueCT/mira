import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cacheShare, compactNumber, dayLabel, inputTokens, triggerLabel } from '../src/usage.ts';

const counts = { requests: 3, failedRequests: 1, input: 500, output: 40, cacheRead: 1500, cacheWrite: 0, total: 2040 };

test('compact token numbers', () => {
  assert.equal(compactNumber(0), '0'); assert.equal(compactNumber(9_999), '9,999');
  assert.equal(compactNumber(36_400), '36.4K'); assert.equal(compactNumber(214_000), '214K');
  assert.equal(compactNumber(1_960_000), '1.96M'); assert.equal(compactNumber(2_000_000), '2M');
  assert.equal(compactNumber(Number.NaN), '—'); assert.equal(compactNumber(-1), '—');
});
test('input includes cache reads; cache share is a whole percent or null', () => {
  assert.equal(inputTokens(counts), 2000); assert.equal(cacheShare(counts), 75);
  assert.equal(cacheShare({ ...counts, input: 0, cacheRead: 0 }), null);
});
test('trigger and day labels', () => {
  assert.equal(triggerLabel({ source: 'user', type: 'web.message' }), '你的消息');
  assert.equal(triggerLabel({ source: 'system', type: 'memory.dreaming' }), 'Dreaming');
  assert.equal(triggerLabel(null), '唤醒');
  assert.deepEqual(dayLabel('2026-10-31'), { weekday: '六', day: '10/31' });
});
