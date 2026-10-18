import assert from 'node:assert/strict';
import test from 'node:test';
import { PENDING_KEY, latestPagination, nextHistoryRequest, olderPagination, mergeTimeline, readPending, reconcilePending, writePending } from '../src/timeline.ts';
import type { PendingMessage, TimelineItem } from '../src/types.ts';

const envelope = { id: 'a5017dbb-0c3f-4cfe-ab34-63997612ebcd', text: '一条保留原样的消息\n第二行', occurredAt: '2026-10-06T07:00:00.000Z' };
const item = (id: string, occurredAt: string, text = id): TimelineItem => ({ id, occurredAt, role: 'user', text });
function memoryStorage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}

test('latest and older history merge by ID without duplicating the timeline', () => {
  const original = item('two', '2026-10-06T02:00:00.000Z');
  const newer = item('three', '2026-10-06T03:00:00.000Z');
  const older = item('one', '2026-10-06T01:00:00.000Z');
  const merged = mergeTimeline(mergeTimeline([original], [original, newer]), [older, original]);
  assert.deepEqual(merged.map(value => value.id), ['one', 'two', 'three']);
});

test('unconfirmed sends recover their exact envelope and become uncertain, never auto-sending', () => {
  const storage = memoryStorage();
  writePending(storage, [{ ...envelope, state: 'sending', error: 'do not persist diagnostics' }]);
  assert.deepEqual(readPending(storage), [{ ...envelope, state: 'uncertain' }]);
  assert.equal(storage.getItem(PENDING_KEY)?.includes('diagnostics'), false);
});

test('a receipt stays queued across refresh and does not imply a completed model reply', () => {
  const storage = memoryStorage();
  writePending(storage, [{ ...envelope, state: 'queued' }]);
  assert.deepEqual(readPending(storage), [{ ...envelope, state: 'queued' }]);
});

test('only the exact durable event ID clears the pending message', () => {
  const pending: PendingMessage[] = [{ ...envelope, state: 'uncertain' }];
  assert.equal(reconcilePending(pending, [item(envelope.id, envelope.occurredAt)]).length, 1);
  assert.equal(reconcilePending(pending, [{ ...item('10000000-0000-4000-8000-000000000001', envelope.occurredAt), role: 'user', externalEventId: envelope.id }]).length, 0);
});

test('confirmed envelopes are removed from this tab storage', () => {
  const storage = memoryStorage();
  writePending(storage, [{ ...envelope, state: 'sending' }]);
  writePending(storage, []);
  assert.equal(storage.getItem(PENDING_KEY), null);
  assert.deepEqual(readPending(storage), []);
});

test('unavailable storage fails before a new send and malformed storage is not silently cleared', () => {
  assert.throws(() => writePending({ setItem: () => { throw new Error('blocked'); }, removeItem: () => {} }, [{ ...envelope, state: 'sending' }]), /blocked/u);
  const storage = memoryStorage();
  storage.setItem(PENDING_KEY, 'not-json');
  assert.throws(() => readPending(storage));
  assert.equal(storage.getItem(PENDING_KEY), 'not-json');
  storage.setItem(PENDING_KEY, JSON.stringify([{ ...envelope, id: 'invalid' }]));
  assert.throws(() => readPending(storage), /无法读取/u);
});


test('ordering uses timestamp instants and retains sub-millisecond precision', () => {
  const merged = mergeTimeline([], [item('offset', '2026-10-06T09:00:00+02:00'), item('utc', '2026-10-06T08:00:00Z'), item('z-micro', '2026-10-06T08:00:00.000001Z'), item('a-micro', '2026-10-06T08:00:00.000002Z')]);
  assert.deepEqual(merged.map(value => value.id), ['offset', 'utc', 'z-micro', 'a-micro']);
});

test('disconnected latest pages expose missing history before the existing older frontier', () => {
  const original = [item('10', '2026-10-06T01:00:00Z'), item('59', '2026-10-06T02:00:00Z')];
  const initial = latestPagination({ latestCursor: null, oldestCursor: null, gaps: [] }, [], { items: original, nextCursor: 'before-10' }, false);
  const gap = latestPagination(initial, original, { items: [item('80', '2026-10-06T03:00:00Z'), item('129', '2026-10-06T04:00:00Z')], nextCursor: 'before-80' }, true);
  assert.deepEqual(nextHistoryRequest(gap), { cursor: 'before-80', gapId: 'before-80' });
  const middle = olderPagination(gap, nextHistoryRequest(gap)!, { items: [item('60', '2026-10-06T02:01:00Z')], nextCursor: 'before-60' });
  assert.deepEqual(nextHistoryRequest(middle), { cursor: 'before-60', gapId: 'before-80' });
  const filled = olderPagination(middle, nextHistoryRequest(middle)!, { items: [original[1]!], nextCursor: 'before-59' });
  assert.deepEqual(nextHistoryRequest(filled), { cursor: 'before-10', gapId: null });
});

test('history grown after an initially exhausted page still creates a reachable gap', () => {
  const original = [item('one', '2026-10-06T01:00:00Z')];
  const gap = latestPagination({ latestCursor: null, oldestCursor: null, gaps: [] }, original, { items: [item('newest', '2026-10-06T03:00:00Z')], nextCursor: 'before-newest' }, true);
  assert.equal(nextHistoryRequest(gap)?.cursor, 'before-newest');
  const filled = olderPagination(gap, nextHistoryRequest(gap)!, { items: original, nextCursor: null });
  assert.equal(nextHistoryRequest(filled), null);
});

test('overlapping latest windows retain the already loaded older-history frontier', () => {
  const original = [item('known', '2026-10-06T01:00:00Z')];
  const pagination = { latestCursor: null, oldestCursor: 'oldest-unread', gaps: [] };
  assert.deepEqual(latestPagination(pagination, original, { items: original, nextCursor: 'duplicate-page' }, true), { ...pagination, latestCursor: 'duplicate-page' });
});

test('multiple disconnected windows keep independent gap frontiers', () => {
  const first = item('first', '2026-10-06T01:00:00Z'); const second = item('second', '2026-10-06T03:00:00Z'); const third = item('third', '2026-10-06T05:00:00Z');
  const gapA = latestPagination({ latestCursor: null, oldestCursor: 'oldest', gaps: [] }, [first], { items: [second], nextCursor: 'gap-a' }, true);
  const gapB = latestPagination(gapA, [first, second], { items: [third], nextCursor: 'gap-b' }, true);
  const fillB = olderPagination(gapB, nextHistoryRequest(gapB)!, { items: [second], nextCursor: 'ignored' });
  assert.equal(nextHistoryRequest(fillB)?.cursor, 'gap-a');
  const fillA = olderPagination(fillB, nextHistoryRequest(fillB)!, { items: [first], nextCursor: 'ignored' });
  assert.equal(nextHistoryRequest(fillA)?.cursor, 'oldest');
});


test('empty visible pages keep pagination progress across repeated latest polls', () => {
  const latest = { items: [], nextCursor: 'before-150' };
  let pagination = latestPagination({ latestCursor: null, oldestCursor: null, gaps: [] }, [], latest, false);
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [], nextCursor: 'before-100' });
  pagination = latestPagination(pagination, [], latest, true);
  assert.equal(nextHistoryRequest(pagination)?.cursor, 'before-100');
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [], nextCursor: 'before-50' });
  pagination = latestPagination(pagination, [], latest, true);
  assert.equal(nextHistoryRequest(pagination)?.cursor, 'before-50');
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [item('old-message', '2026-10-06T01:00:00Z')], nextCursor: null });
  assert.equal(nextHistoryRequest(pagination), null);
});


test('an unchanged hidden-only latest window cannot recreate or rewind its advanced gap', () => {
  const known = [item('known', '2026-10-06T01:00:00Z')];
  let pagination = latestPagination({ latestCursor: 'before-50', oldestCursor: 'before-50', gaps: [] }, known, { items: [], nextCursor: 'before-150' }, true);
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [], nextCursor: 'before-100' });
  const unchanged = latestPagination(pagination, known, { items: [], nextCursor: 'before-150' }, true);
  assert.equal(unchanged.gaps.length, 1);
  assert.equal(unchanged.gaps[0]?.id, 'before-150');
  assert.equal(nextHistoryRequest(unchanged)?.cursor, 'before-100');
});

test('a changed hidden-only latest window opens a gap even before visible history is found', () => {
  let pagination = latestPagination({ latestCursor: null, oldestCursor: null, gaps: [] }, [], { items: [], nextCursor: 'before-100' }, false);
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [], nextCursor: 'before-50' });
  pagination = latestPagination(pagination, [], { items: [], nextCursor: 'before-200' }, true);
  assert.equal(pagination.oldestCursor, 'before-50');
  assert.equal(nextHistoryRequest(pagination)?.cursor, 'before-200');
  // This newly reachable page includes a message which aged out of the latest
  // raw-record window before the client ever saw a visible message.
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [item('missed-150', '2026-10-06T02:00:00Z')], nextCursor: 'before-100' });
  assert.equal(nextHistoryRequest(pagination)?.cursor, 'before-100');
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [], nextCursor: null });
  assert.equal(nextHistoryRequest(pagination), null);
  assert.equal(pagination.oldestCursor, null);
});

test('finishing an older gap keeps a newer gap added during the outstanding request', () => {
  const first = item('first', '2026-10-06T01:00:00Z');
  let pagination = latestPagination({ latestCursor: 'before-50', oldestCursor: 'before-50', gaps: [] }, [first], { items: [], nextCursor: 'before-150' }, true);
  const outstanding = nextHistoryRequest(pagination)!;
  pagination = latestPagination(pagination, [first], { items: [item('newer', '2026-10-06T03:00:00Z')], nextCursor: 'before-250' }, true);
  pagination = olderPagination(pagination, outstanding, { items: [], nextCursor: null });
  assert.equal(pagination.oldestCursor, null);
  assert.equal(pagination.gaps.length, 1);
  assert.equal(nextHistoryRequest(pagination)?.cursor, 'before-250');
});

test('repeated hidden-only latest windows replace the newest gap instead of adding one per poll', () => {
  const first = item('first', '2026-10-06T01:00:00Z');
  let pagination = latestPagination({ latestCursor: 'before-50', oldestCursor: 'before-50', gaps: [] }, [first], { items: [], nextCursor: 'before-150' }, true);
  const outstanding = nextHistoryRequest(pagination)!;
  for (const cursor of ['before-160', 'before-170', 'before-900']) pagination = latestPagination(pagination, [first], { items: [], nextCursor: cursor }, true);
  assert.deepEqual(pagination.gaps, [{ id: 'before-900', cursor: 'before-900', boundaryIds: ['first'] }], 'one gap spans everything newer than the boundary');
  assert.equal(pagination.oldestCursor, 'before-50');
  // A late result for the replaced gap cannot skip the wider replacement range.
  pagination = olderPagination(pagination, outstanding, { items: [], nextCursor: null });
  assert.equal(nextHistoryRequest(pagination)?.cursor, 'before-900');
  // Visible rows in a disconnected window change the boundary and keep both gaps.
  const second = item('second', '2026-10-06T04:00:00Z');
  pagination = latestPagination(pagination, [first], { items: [second], nextCursor: 'before-1000' }, true);
  pagination = latestPagination(pagination, [first, second], { items: [], nextCursor: 'before-1100' }, true);
  assert.deepEqual(pagination.gaps.map(gap => gap.cursor), ['before-1100', 'before-1000', 'before-900']);
  // Reading the newest gap down to its boundary leaves the older gap reachable.
  pagination = olderPagination(pagination, nextHistoryRequest(pagination)!, { items: [second], nextCursor: 'before-999' });
  assert.deepEqual(pagination.gaps.map(gap => gap.cursor), ['before-1000', 'before-900']);
});


test('pending acknowledgement uses original request identity, never a History UUID or assistant reference', () => {
  const pending: PendingMessage[] = [{ ...envelope, state: 'uncertain' }];
  assert.deepEqual(reconcilePending(pending, [{ ...item(envelope.id, envelope.occurredAt), role: 'user' }]), pending);
  assert.deepEqual(reconcilePending(pending, [{ ...item('other-history-id', envelope.occurredAt), role: 'assistant', externalEventId: envelope.id }]), pending);
  assert.deepEqual(reconcilePending(pending, [{ ...item('other-history-id', envelope.occurredAt), role: 'user', externalEventId: envelope.id }]), []);
});

test('reply target survives exact durable retry storage alongside ordered attachments', () => {
  const storage = memoryStorage();
  const replyToMessageId = '11111111-1111-4111-8111-111111111111';
  const message: PendingMessage = { ...envelope, replyToMessageId, attachmentIds: ['22222222-2222-4222-8222-222222222222'], state: 'sending' };
  writePending(storage, [message]);
  assert.deepEqual(readPending(storage), [{ ...message, state: 'uncertain' }]);
  const confirmed: TimelineItem = { ...item('server', envelope.occurredAt), externalEventId: envelope.id };
  assert.equal(reconcilePending([message], [confirmed]).length, 1);
  assert.equal(reconcilePending([message], [{ ...confirmed, reply: { messageId: replyToMessageId, role: 'assistant', text: 'original' } }]).length, 0);
  storage.setItem(PENDING_KEY, JSON.stringify([{ ...message, replyToMessageId: 'bad target' }]));
  assert.throws(() => readPending(storage), /消息引用/u);
});

test('sparse timestamps use strictly more than five minutes and local calendar days', async () => {
  const { timelineSpacing } = await import('../src/timeline.ts');
  const first = item('first', new Date(2026, 9, 16, 12, 0).toISOString());
  const boundary = item('boundary', new Date(2026, 9, 16, 12, 5).toISOString());
  assert.deepEqual(timelineSpacing(first, boundary), { divider: false, compact: true });
  assert.deepEqual(timelineSpacing(first, { ...boundary, occurredAt: new Date(new Date(boundary.occurredAt).getTime() + 1).toISOString() }), { divider: true, compact: false });
  assert.equal(timelineSpacing(item('night', new Date(2026, 9, 16, 23, 59).toISOString()), item('morning', new Date(2026, 9, 17, 0, 0).toISOString())).divider, true);
  assert.deepEqual(timelineSpacing(first, { ...boundary, role: 'assistant' }), { divider: false, compact: false });
  assert.deepEqual(timelineSpacing(first, { ...boundary, occurredAt: 'invalid' }), { divider: false, compact: false });
  assert.deepEqual(timelineSpacing({ ...first, occurredAt: 'invalid' }, boundary), { divider: true, compact: false });
  assert.deepEqual(timelineSpacing(undefined, first), { divider: true, compact: false });
});

test('local day divider follows timezone rather than the timestamp UTC date', async () => {
  const { timelineSpacing } = await import('../src/timeline.ts');
  const original = process.env['TZ'];
  try {
    process.env['TZ'] = 'Asia/Shanghai';
    assert.equal(timelineSpacing(item('a', '2026-10-16T15:59:00Z'), item('b', '2026-10-16T16:01:00Z')).divider, true);
    assert.equal(timelineSpacing(item('a', '2026-10-16T23:59:00Z'), item('b', '2026-10-17T00:01:00Z')).divider, false);
  } finally { if (original === undefined) delete process.env['TZ']; else process.env['TZ'] = original; }
});
