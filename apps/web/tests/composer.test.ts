import assert from 'node:assert/strict';
import test from 'node:test';
import { composerBudget, envelopeBytes, MESSAGE_BODY_LIMIT } from '../src/composer.ts';

test('the composer budget counts UTF-8 bytes of the whole envelope, not characters', () => {
  // 22,000 CJK characters are under the old 50,000-character limit but 66,000 bytes.
  const over = composerBudget({ text: '湖'.repeat(22_000) });
  assert.equal(over.over, true); assert.match(over.label!, /^超出 .* KB，请缩短后再发送$/u);
  const near = composerBudget({ text: '湖'.repeat(20_000) });
  assert.equal(near.over, false); assert.equal(near.near, true); assert.match(near.label!, /^还可输入约 .* KB$/u);
  const small = composerBudget({ text: 'hello' });
  assert.deepEqual([small.over, small.near, small.label], [false, false, null]);
  // ASCII fits far more characters than CJK.
  assert.equal(composerBudget({ text: 'a'.repeat(60_000) }).over, false);
  // JSON escaping and the reply/attachment fields count toward the same limit.
  assert.ok(composerBudget({ text: '"'.repeat(33_000) }).over);
  const base = composerBudget({ text: 'x' }).bytes;
  assert.ok(composerBudget({ text: 'x', replyToMessageId: '11111111-1111-4111-8111-111111111111', attachmentIds: ['22222222-2222-4222-8222-222222222222'] }).bytes > base + 80);
});

test('the budget matches a real envelope byte for byte', () => {
  // Sending trims the draft, so the budget measures the trimmed text.
  const text = '周末 hello "quoted"\n'.repeat(100);
  const real = envelopeBytes({ replyToMessageId: '11111111-1111-4111-8111-111111111111', id: crypto.randomUUID(), text: text.trim(), occurredAt: new Date().toISOString(), attachmentIds: ['22222222-2222-4222-8222-222222222222'] });
  assert.equal(composerBudget({ text, replyToMessageId: '11111111-1111-4111-8111-111111111111', attachmentIds: ['22222222-2222-4222-8222-222222222222'] }).bytes, real);
  assert.equal(MESSAGE_BODY_LIMIT, 65_536);
});
