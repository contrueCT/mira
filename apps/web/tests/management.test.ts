import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryRequest, MEMORY_REQUEST_KEY, MEMORY_REQUEST_PREFIX, memoryBlocks, parseConfig, readMemoryRequest, recoverMemoryRequest, writeMemoryRequest } from '../src/management.ts';
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


test('pending Memory identity survives an interrupted identity-store write without replacing a newer saved request', () => {
  const saved = { id: '10000000-0000-4000-8000-000000000001', occurredAt: '2026-10-13T00:00:00Z' };
  const pending = { id: '20000000-0000-4000-8000-000000000002', occurredAt: '2026-10-13T00:01:00Z', text: MEMORY_REQUEST_PREFIX + 'change' };
  assert.deepEqual(recoverMemoryRequest(saved, [pending]), { id: pending.id, occurredAt: pending.occurredAt });
  assert.deepEqual(recoverMemoryRequest({ ...saved, occurredAt: '2026-10-13T00:02:00Z' }, [pending]), { ...saved, occurredAt: '2026-10-13T00:02:00Z' });
  assert.deepEqual(recoverMemoryRequest(null, [pending]), { id: pending.id, occurredAt: pending.occurredAt });
});

test('a tool outcome arriving through an older gap page advances after it has left the latest 50 records', () => {
  const newer = Array.from({ length: 51 }, (_, index) => execution(`new-${index + 1}`, 'succeeded'));
  let state = acceptRunRecords(emptyRunRecords(), { executions: [execution('old-tool')], nextCursor: null });
  const latest = { executions: newer.slice(1), nextCursor: 'before-new-2' };
  state = acceptRunRecords(state, latest);
  assert.equal(state.executions.find(item => item.id === 'old-tool')?.status, 'unknown');
  const gap = nextRunRecords(state)!;
  assert.equal(gap.cursor, 'before-new-2');
  state = acceptRunRecords(state, { executions: [execution('old-tool', 'succeeded'), newer[0]!], nextCursor: null }, gap);
  assert.equal(state.executions.find(item => item.id === 'old-tool')?.status, 'succeeded');
  assert.equal(nextRunRecords(state), null);
  state = acceptRunRecords(state, latest);
  assert.equal(state.executions.find(item => item.id === 'old-tool')?.status, 'succeeded');
  assert.deepEqual(state.executions.map(item => item.id), ['old-tool', ...newer.map(item => item.id)]);
});

test('tool outcomes advance unknown to failed through older pages and never regress to unknown', () => {
  let state = acceptRunRecords(emptyRunRecords(), { executions: [execution('tool')], nextCursor: 'older' });
  const request = nextRunRecords(state)!;
  state = acceptRunRecords(state, { executions: [{ ...execution('tool', 'failed'), error: 'Recorded safe failure' }], nextCursor: null }, request);
  assert.equal(state.executions[0]?.status, 'failed');
  state = acceptRunRecords(state, { executions: [execution('tool')], nextCursor: null }, request);
  assert.equal(state.executions[0]?.status, 'failed');
  state = acceptRunRecords(state, { executions: [execution('tool')], nextCursor: null });
  assert.equal(state.executions[0]?.status, 'failed');
  assert.equal(state.executions[0]?.error, 'Recorded safe failure');
});

test('an oversized durable result in an older gap page replaces unknown after leaving the latest 50 records', () => {
  const newer = Array.from({ length: 51 }, (_, index) => execution(`new-${index + 1}`, 'succeeded'));
  const unavailable: RunExecution = { id: 'old-tool', occurredAt: '2026-10-13T00:00:00Z', kind: 'unavailable', name: null, status: 'unavailable', error: 'This durable record exceeds the display read limit; the original is still preserved.' };
  let state = acceptRunRecords(emptyRunRecords(), { executions: [execution('old-tool')], nextCursor: null });
  const latest = { executions: newer.slice(1), nextCursor: 'before-new-2' };
  state = acceptRunRecords(state, latest);
  const gap = nextRunRecords(state)!;
  state = acceptRunRecords(state, { executions: [unavailable, newer[0]!], nextCursor: null }, gap);
  assert.deepEqual(state.executions.find(item => item.id === 'old-tool'), unavailable);
  assert.equal(nextRunRecords(state), null);
  state = acceptRunRecords(state, latest);
  assert.deepEqual(state.executions.find(item => item.id === 'old-tool'), unavailable);
  // These reads started while the original tool was still pending. Neither an
  // old page nor a late latest-page response may restore that stale unknown.
  state = acceptRunRecords(state, { executions: [execution('old-tool')], nextCursor: null }, gap);
  assert.deepEqual(state.executions.find(item => item.id === 'old-tool'), unavailable);
  state = acceptRunRecords(state, { executions: [execution('old-tool')], nextCursor: null });
  assert.deepEqual(state.executions.find(item => item.id === 'old-tool'), unavailable);
  assert.deepEqual(state.executions.map(item => item.id), ['old-tool', ...newer.map(item => item.id)]);
});


test('child turn status advances through older and gap pages without stale response regression', () => {
  const child = (status: string): RunExecution => ({ ...execution('child-turn', status), kind: 'subagent', name: 'child-id' });
  for (const terminal of ['completed', 'cancelled', 'interrupted', 'failed']) for (const gapPage of [false, true]) {
    let state = acceptRunRecords(emptyRunRecords(), { executions: [child('queued')], nextCursor: gapPage ? null : 'older' });
    if (gapPage) state = acceptRunRecords(state, { executions: [execution('newer', 'succeeded')], nextCursor: 'gap' });
    const request = nextRunRecords(state)!;
    state = acceptRunRecords(state, { executions: [child('running')], nextCursor: null }, request);
    assert.equal(state.executions.find(item => item.id === 'child-turn')?.status, 'running');
    state = acceptRunRecords(state, { executions: [child('queued')], nextCursor: null });
    assert.equal(state.executions.find(item => item.id === 'child-turn')?.status, 'running');
    state = acceptRunRecords(state, { executions: [child(terminal)], nextCursor: null }, request);
    assert.equal(state.executions.find(item => item.id === 'child-turn')?.status, terminal);
    for (const stale of ['queued', 'running', 'failed']) {
      state = acceptRunRecords(state, { executions: [child(stale)], nextCursor: null }, request);
      state = acceptRunRecords(state, { executions: [child(stale)], nextCursor: null });
      assert.equal(state.executions.find(item => item.id === 'child-turn')?.status, terminal);
    }
  }
});
