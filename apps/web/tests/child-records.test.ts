import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeChildPage } from '../src/child-records.ts';
import { latestPagination, olderPagination, nextHistoryRequest } from '../src/timeline.ts';

const entries = (high: number, low: number) => Array.from({ length: high - low + 1 }, (_, index) => ({ id: `${high - index}`, text: 'confirmed' }));
const ids = (items: { id: string }[]) => items.map(item => item.id);

test('run child gap pages retain association order after fifty-five old and fifty-five newly linked children', () => {
  let items = entries(55, 6);
  let paging = latestPagination({ latestCursor: null, oldestCursor: null, gaps: [] }, [], { items, nextCursor: '6' }, false);
  const older = nextHistoryRequest(paging)!;
  items = mergeChildPage(items, entries(5, 1), older.cursor);
  paging = olderPagination(paging, older, { items: entries(5, 1), nextCursor: null });
  assert.equal(nextHistoryRequest(paging), null);
  const latest = { items: entries(110, 61), nextCursor: '61' };
  paging = latestPagination(paging, items, latest, true); items = mergeChildPage(items, latest.items);
  const gap = nextHistoryRequest(paging)!; assert.equal(gap.cursor, '61');
  const fill = { items: entries(60, 11), nextCursor: '11' };
  items = mergeChildPage(items, fill.items, gap.cursor); paging = olderPagination(paging, gap, fill);
  assert.deepEqual(ids(items), ids(entries(110, 1))); assert.equal(nextHistoryRequest(paging), null);
});

test('multiple new child windows merge at their own gap anchors instead of appending after old children', () => {
  let items = entries(55, 1);
  items = mergeChildPage(items, entries(110, 61));
  items = mergeChildPage(items, entries(165, 116));
  items = mergeChildPage(items, entries(115, 66), '116');
  items = mergeChildPage(items, entries(60, 11), '61');
  assert.deepEqual(ids(items), ids(entries(165, 1)));
  const updated = mergeChildPage(items, [{ id: '55', text: 'finished' }], '56');
  assert.equal(updated.length, 165); assert.equal(updated.find(item => item.id === '55')!.text, 'finished');
  assert.equal(items.find(item => item.id === '55')!.text, 'confirmed');
});

test('unknown child-page anchors fail instead of silently placing records in another window', () => {
  assert.throws(() => mergeChildPage(entries(5, 1), entries(10, 6), 'missing'), /分页边界/);
});
