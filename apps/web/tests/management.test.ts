import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRequest, MEMORY_REQUEST_KEY, MEMORY_REQUEST_PREFIX, memoryBlocks, parseConfig, readMemoryRequest, writeMemoryRequest } from '../src/management.ts';
import { acceptRunRecords, emptyRunRecords, nextRunRecords } from '../src/run-records.ts';
import type { RunExecution } from '../src/types.ts';

const execution = (id: string, status = 'unknown'): RunExecution => ({ id, kind: 'tool', name: 'read', occurredAt: '2026-10-13T00:00:00Z', status, error: null });

test('Memory request is explicit ordinary text with one immutable envelope and bounded bytes', () => {
  const result = createMemoryRequest('  把红茶改为绿茶。  ');
  assert.equal(result.text, MEMORY_REQUEST_PREFIX + '把红茶改为绿茶。');
  assert.match(result.id, /^[0-9a-f-]{36}$/u);
  assert.ok(Number.isFinite(Date.parse(result.occurredAt)));
  assert.throws(() => createMemoryRequest('   '), /请先/u);
  assert.throws(() => createMemoryRequest('字'.repeat(30_000)), /太长/u);
});

test('Memory tracker stores identity only, and rejects corrupt state rather than resending', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const request = createMemoryRequest('ordinary request');
  writeMemoryRequest(storage, request);
  assert.deepEqual(readMemoryRequest(storage), { id: request.id, occurredAt: request.occurredAt });
  assert.equal(values.get(MEMORY_REQUEST_KEY)?.includes('ordinary request'), false);
  assert.equal(values.get(MEMORY_REQUEST_KEY)?.includes('text'), false);
  values.set(MEMORY_REQUEST_KEY, '{"id":"bad"}');
  assert.throws(() => readMemoryRequest(storage), /无法读取/u);
});

test('Memory summary parses a safe readable block subset while keeping HTML and links inert text', () => {
  assert.deepEqual(memoryBlocks('  \n'), []);
  const text = '# 记忆\n\n<img src=x onerror=alert(1)>\n\n- 第一项\n- [链接](javascript:alert(1))\n\n1. 一\n2. 二\n\n```html\n<script>alert(1)</script>\n```';
  assert.deepEqual(memoryBlocks(text), [
    { kind: 'heading', level: 1, text: '记忆' }, { kind: 'paragraph', text: '<img src=x onerror=alert(1)>' },
    { kind: 'list', ordered: false, items: ['第一项', '[链接](javascript:alert(1))'] },
    { kind: 'list', ordered: true, items: ['一', '二'] }, { kind: 'code', text: '<script>alert(1)</script>' },
  ]);
  assert.equal(memoryBlocks('x'.repeat(100_000))[0]?.kind, 'paragraph');
});

test('extension configuration accepts the SDK complete JSON value contract', () => {
  assert.deepEqual(parseConfig('{}'), {});
  assert.deepEqual(parseConfig('{"token":"entered only"}'), { token: 'entered only' });
  assert.equal(parseConfig('null'), null);
  assert.deepEqual(parseConfig('[1, "a"]'), [1, 'a']);
  assert.equal(parseConfig('1'), 1);
  assert.equal(parseConfig('"string"'), 'string');
  for (const value of ['', '{oops}']) assert.throws(() => parseConfig(value), /JSON/u);
});

test('latest run details replace unknown tool outcomes without wall-clock reordering', () => {
  let state = acceptRunRecords(emptyRunRecords(), { executions: [execution('earlier'), execution('tool')], nextCursor: null });
  state = acceptRunRecords(state, { executions: [execution('tool', 'succeeded'), { ...execution('final', 'completed'), occurredAt: '2020-01-01T00:00:00Z' }], nextCursor: 'before-tool' });
  assert.deepEqual(state.executions.map(item => [item.id, item.status]), [['earlier', 'unknown'], ['tool', 'succeeded'], ['final', 'completed']]);
});

test('run details initially below a page still expose a gap if they grow beyond a page', () => {
  let state = acceptRunRecords(emptyRunRecords(), { executions: [execution('one')], nextCursor: null });
  state = acceptRunRecords(state, { executions: [execution('newest')], nextCursor: 'before-newest' });
  assert.equal(nextRunRecords(state)?.cursor, 'before-newest');
  state = acceptRunRecords(state, { executions: [execution('one'), execution('middle')], nextCursor: 'before-one' }, nextRunRecords(state)!);
  assert.deepEqual(state.executions.map(item => item.id), ['one', 'middle', 'newest']);
  assert.equal(nextRunRecords(state), null);
});

test('an older run page cannot restore a stale outcome or erase a newer gap frontier', () => {
  let state = acceptRunRecords(emptyRunRecords(), { executions: [execution('tool')], nextCursor: 'oldest' });
  const older = nextRunRecords(state)!;
  state = acceptRunRecords(state, { executions: [execution('tool', 'succeeded'), execution('new')], nextCursor: 'before-tool' });
  state = acceptRunRecords(state, { executions: [execution('tool')], nextCursor: null }, older);
  assert.equal(state.executions.find(item => item.id === 'tool')?.status, 'succeeded');
  state = acceptRunRecords(state, { executions: [execution('latest')], nextCursor: 'gap' });
  const gap = nextRunRecords(state)!;
  state = acceptRunRecords(state, { executions: [execution('newer')], nextCursor: 'new-gap' });
  state = acceptRunRecords(state, { executions: [], nextCursor: null }, gap);
  assert.equal(nextRunRecords(state)?.cursor, 'new-gap');
});


test('interior run gap pages preserve server version order without relying on timestamps', () => {
  let state = acceptRunRecords(emptyRunRecords(), { executions: [execution('one')], nextCursor: null });
  state = acceptRunRecords(state, { executions: [execution('five')], nextCursor: 'before-five' });
  state = acceptRunRecords(state, { executions: [execution('three'), execution('four')], nextCursor: 'before-three' }, nextRunRecords(state)!);
  assert.deepEqual(state.executions.map(item => item.id), ['one', 'three', 'four', 'five']);
  state = acceptRunRecords(state, { executions: [execution('one'), execution('two')], nextCursor: null }, nextRunRecords(state)!);
  assert.deepEqual(state.executions.map(item => item.id), ['one', 'two', 'three', 'four', 'five']);
  assert.equal(nextRunRecords(state), null);
});
