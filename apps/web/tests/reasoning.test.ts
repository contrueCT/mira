import assert from 'node:assert/strict';
import test from 'node:test';
import { effectiveThinkingLevel } from '../src/reasoning.ts';
test('reasoning preview uses provided model capabilities without erasing the configured preference', () => {
  assert.equal(effectiveThinkingLevel('max', ['off', 'minimal', 'low', 'medium', 'high']), 'high');
  assert.equal(effectiveThinkingLevel('high', ['off']), 'off');
  assert.equal(effectiveThinkingLevel('off', ['low', 'medium', 'high']), 'low');
  assert.equal(effectiveThinkingLevel('xhigh', ['low', 'medium', 'high', 'xhigh', 'max']), 'xhigh');
});
