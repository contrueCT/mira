import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptRunRequests, beginRunRequests, cancelRunRequests, emptyRunRequests, finishRunRequests, matchesRunRequests, seedRunRequests } from '../src/run-requests.ts';
import { acceptRunRecords, emptyRunRecords, nextRunRecords } from '../src/run-records.ts';
import type { RunRequest } from '../src/types.ts';

const member = (eventId: string): RunRequest => ({ eventId, source: 'user', type: 'web.message', reason: null });

test('bounded members paginate independently from executions and first-page refresh does not rewind', () => {
  const members = Array.from({ length: 50 }, (_, index) => member(`event-${index}`));
  let requests = seedRunRequests(emptyRunRequests('run-a'), 'run-a', members, 'members-50');
  const records = acceptRunRecords(emptyRunRecords(), { executions: [], nextCursor: 'executions-50' });
  requests = beginRunRequests(requests); const read = requests.reading!;
  assert.equal(read.cursor, 'members-50');
  requests = acceptRunRequests(requests, read, { items: [members.at(-1)!, member('event-50')], nextCursor: 'members-51' });
  assert.equal(requests.items.length, 51);
  assert.equal(requests.nextCursor, 'members-51');
  assert.equal(nextRunRecords(records)?.cursor, 'executions-50');
  requests = seedRunRequests(requests, 'run-a', members, 'members-50');
  assert.equal(requests.items.length, 51);
  assert.equal(requests.nextCursor, 'members-51');
  requests = beginRunRequests(requests);
  requests = acceptRunRequests(requests, requests.reading!, { items: [member('event-51')], nextCursor: null });
  requests = seedRunRequests(requests, 'run-a', members, 'members-50');
  assert.equal(requests.nextCursor, null);
  assert.equal(requests.items.length, 52);
});

test('repeated clicks have only one member-page request until it finishes', () => {
  const state = beginRunRequests(seedRunRequests(emptyRunRequests('run-a'), 'run-a', [member('one')], 'next'));
  assert.equal(beginRunRequests(state), state);
  const finished = finishRunRequests(state, state.reading!);
  const retry = beginRunRequests(finished);
  assert.notEqual(retry.reading?.generation, state.reading?.generation);
  assert.equal(retry.reading?.cursor, 'next');
});

test('switching tabs cancels member read; late success or failure cannot finish the newer read', () => {
  let state = beginRunRequests(seedRunRequests(emptyRunRequests('run-a'), 'run-a', [member('one')], 'next'));
  const oldRead = state.reading!;
  state = cancelRunRequests(state);
  state = beginRunRequests(state); const newRead = state.reading!;
  assert.equal(matchesRunRequests(state, oldRead), false);
  assert.equal(acceptRunRequests(state, oldRead, { items: [member('stale')], nextCursor: null }), state);
  assert.equal(finishRunRequests(state, oldRead), state);
  assert.equal(state.reading, newRead);
  state = acceptRunRequests(state, newRead, { items: [member('two')], nextCursor: null });
  assert.deepEqual(state.items.map(item => item.eventId), ['two', 'one']);
  assert.equal(state.reading, null);
});

test('switching run identities rejects late reads and first-page data from the old run', () => {
  const old = beginRunRequests(seedRunRequests(emptyRunRequests('run-a'), 'run-a', [member('a')], 'same-cursor'));
  const next = beginRunRequests(seedRunRequests(emptyRunRequests('run-b'), 'run-b', [member('b')], 'same-cursor'));
  assert.equal(acceptRunRequests(next, old.reading!, { items: [member('late-a')], nextCursor: null }), next);
  assert.equal(seedRunRequests(next, 'run-a', [member('late-a')], null), next);
  assert.equal(finishRunRequests(next, old.reading!), next);
});


test('55 trigger members retain complete receipt order across latest and older pages', () => {
  const all = Array.from({ length: 55 }, (_, index) => member(`event-${index + 1}`));
  const latest = all.slice(5);
  let state = seedRunRequests(emptyRunRequests('run-a'), 'run-a', latest, 'before-event-6');
  assert.deepEqual(state.items.map(item => item.eventId), all.slice(5).map(item => item.eventId));
  state = beginRunRequests(state);
  state = acceptRunRequests(state, state.reading!, { items: all.slice(0, 5), nextCursor: null });
  assert.deepEqual(state.items.map(item => item.eventId), all.map(item => item.eventId));
  assert.equal(state.nextCursor, null);
  state = seedRunRequests(state, 'run-a', latest, 'before-event-6');
  assert.deepEqual(state.items.map(item => item.eventId), all.map(item => item.eventId));
  assert.equal(state.nextCursor, null);
});
