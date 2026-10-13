import assert from 'node:assert/strict';
import test from 'node:test';
import { ExternalProtocolError, MAX_EXTERNAL_INPUT_BYTES, MAX_EXTERNAL_PAYLOAD_DEPTH, parseExternalEvent, parseExternalWake, parseExternalNotification, parseExternalReceipt, MAX_EXTERNAL_NOTIFICATION_TEXT_LENGTH, type ExternalEvent, type ExternalNotification, type ExternalReceipt, type Json } from '../../packages/external-sdk/src/protocol.ts';

const event = (payload: Json = { text: 'Synthetic external event' }): ExternalEvent => ({ id: 'event-1', type: 'worker.finished', occurredAt: '2026-10-11T12:00:00.000Z', payload });
const wake = () => ({ id: 'wake-1', reason: 'Synthetic attention request', event: event() });
const invalid = (error: unknown): boolean => {
  assert(error instanceof ExternalProtocolError);
  assert.equal(error.name, 'ExternalProtocolError');
  assert.equal(error.code, 'invalid_input');
  assert.equal(error.message, 'Invalid external request');
  assert.equal(error.cause, undefined);
  return true;
};

test('external protocol accepts independent event and atomic Wake envelopes with caller-owned receipts', () => {
  assert.deepEqual(parseExternalEvent(event()), event());
  assert.deepEqual(parseExternalWake(wake()), wake());
  for (const value of [null, true, false, 0, 1.5, 'text', [], {}] satisfies Json[]) assert.deepEqual(parseExternalEvent(event(value)).payload, value);
  const receipts: ExternalReceipt[] = [
    { operation: 'event', id: 'event-1', receipt: 'inserted', durability: 'persisted' },
    { operation: 'wake', id: 'wake-1', eventId: 'event-1', receipt: 'duplicate', durability: 'persisted' },
  ];
  assert.equal(receipts[0]?.id, 'event-1'); assert.equal(receipts[1]?.id, 'wake-1');
});

test('external event and Wake fields are exact own enumerable data properties', () => {
  for (const parse of [parseExternalEvent, parseExternalWake]) {
    for (const value of [null, false, 42, 'secret', [], () => null, new Date(), new Map()]) assert.throws(() => parse(value), invalid);
  }
  for (const [parse, original] of [[parseExternalEvent, event()], [parseExternalWake, wake()]] as const) {
    for (const key of Object.keys(original)) {
      const missing = { ...original } as Record<string, unknown>; delete missing[key];
      assert.throws(() => parse(missing), invalid);
      const undefinedValue = { ...original, [key]: undefined }; assert.throws(() => parse(undefinedValue), invalid);
      const hidden = Object.defineProperty({ ...original }, key, { enumerable: false }); assert.throws(() => parse(hidden), invalid);
    }
    assert.throws(() => parse({ ...original, extra: 'do not leak this' }), invalid);
    assert.throws(() => parse({ ...original, [Symbol('secret')]: 1 }), invalid);
    assert.throws(() => parse(Object.assign(Object.create({ inherited: true }), original)), invalid);
    assert.deepEqual(parse(Object.assign(Object.create(null), original)), original);
    assert.deepEqual(parse(Object.freeze({ ...original })), original);
  }
  assert.throws(() => parseExternalWake({ ...wake(), event: { ...event(), source: 'user' } }), invalid);
});

test('external identifiers, timestamps and Wake reasons enforce their exact bounds', () => {
  const validIds = ['0', 'A', 'a.b:c_d-e', 'a'.repeat(128)];
  for (const id of validIds) {
    assert.equal(parseExternalEvent({ ...event(), id, type: id }).id, id);
    assert.equal(parseExternalWake({ ...wake(), id }).id, id);
  }
  for (const id of ['', 'a'.repeat(129), '_first', '.first', ':first', '-first', 'two words', 'slash/id', 'é', 'x\n', 'x\0', 1]) {
    assert.throws(() => parseExternalEvent({ ...event(), id }), invalid);
    assert.throws(() => parseExternalEvent({ ...event(), type: id }), invalid);
    assert.throws(() => parseExternalWake({ ...wake(), id }), invalid);
  }
  for (const occurredAt of ['', 'bad date', '2026-10-11', '2026-10-11T12:00:00Z', '2026-10-11T12:00:00.000+00:00',
    '2026-02-30T12:00:00.000Z', '2026-10-11T12:00:00.0000Z', ' '.repeat(41), 0]) {
    assert.throws(() => parseExternalEvent({ ...event(), occurredAt }), invalid);
  }
  for (const reason of ['', ' \t\n', '\u00a0', 'a'.repeat(4097), 1, null]) assert.throws(() => parseExternalWake({ ...wake(), reason }), invalid);
  assert.equal(parseExternalWake({ ...wake(), reason: 'a'.repeat(4096) }).reason.length, 4096);
  assert.equal(parseExternalWake({ ...wake(), reason: '  keep original spacing  ' }).reason, '  keep original spacing  ');
});

test('external payloads reject non-JSON values, custom prototypes, sparse arrays and extra properties', () => {
  const sparse = new Array(2); sparse[0] = 'first';
  const extra = Object.assign(['first'], { extra: true });
  const hidden = Object.defineProperty({ value: true }, 'hidden', { value: 'secret' });
  const hiddenIndex = Object.defineProperty(['first'], '0', { enumerable: false });
  const customArray = Object.setPrototypeOf([], Object.create(Array.prototype));
  for (const payload of [undefined, NaN, Infinity, -Infinity, 1n, Symbol('secret'), () => null,
    new Date(), new Map(), new Set(), /secret/, new Number(1), new Uint8Array([1]), Object.create({ secret: true }),
    sparse, extra, hidden, hiddenIndex, customArray, { [Symbol('secret')]: 1 }, Object.assign([], { [Symbol('secret')]: true }),
    { nested: undefined }, { nested: NaN }, [undefined], { toJSON() { throw Error('must not execute'); } }]) {
    assert.throws(() => parseExternalEvent({ ...event(), payload }), invalid);
  }
});

test('external parsing does not invoke accessors or toJSON, and native/trap errors stay generic', () => {
  let reads = 0;
  const getter = { enumerable: true, get() { reads++; throw Error('SECRET getter value'); } };
  for (const input of [Object.defineProperty(event(), 'id', getter), { ...event(), payload: Object.defineProperty({}, 'secret', getter) },
    { ...event(), payload: Object.defineProperty([null], '0', getter) }, { ...event(), payload: Object.defineProperty({}, 'toJSON', getter) }]) {
    assert.throws(() => parseExternalEvent(input), invalid);
  }
  assert.throws(() => parseExternalWake(Object.defineProperty(wake(), 'reason', getter)), invalid);
  assert.equal(reads, 0);
  const poisoned = new Proxy({}, { getPrototypeOf() { throw Error('SECRET proxy content'); } });
  assert.throws(() => parseExternalEvent(poisoned), invalid);
  assert.throws(() => parseExternalEvent({ ...event(), payload: poisoned }), invalid);
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  assert.throws(() => parseExternalWake(revoked.proxy), invalid);
});

test('external payload snapshots reject cycles, bound container depth, and allow repeated acyclic values', () => {
  const cyclic: Record<string, unknown> = {}; cyclic['self'] = cyclic;
  const array: unknown[] = []; array.push(array);
  for (const payload of [cyclic, array]) assert.throws(() => parseExternalEvent({ ...event(), payload }), invalid);
  const shared = { value: 'shared' };
  const parsed = parseExternalEvent(event([shared, shared]));
  assert.deepEqual(parsed.payload, [shared, shared]);
  assert(Array.isArray(parsed.payload)); assert.notEqual(parsed.payload[0], parsed.payload[1]);
  for (const wrap of [(value: Json): Json => [value], (value: Json): Json => ({ child: value })]) {
    let payload: Json = null;
    for (let i = 0; i < MAX_EXTERNAL_PAYLOAD_DEPTH; i++) payload = wrap(payload);
    assert.deepEqual(parseExternalEvent(event(payload)).payload, payload);
    assert.throws(() => parseExternalEvent(event(wrap(payload))), invalid);
    assert.throws(() => parseExternalWake({ ...wake(), event: event(wrap(payload)) }), invalid);
  }
});

test('external snapshots isolate mutations, canonicalize keys/negative zero, and preserve prototype-like data', () => {
  const input = { id: 'wake-1', reason: ' original ', event: event({ z: [{ text: 'original' }], a: -0 }) };
  const parsed = parseExternalWake(input);
  const originalPayload = input.event.payload as { z: { text: string }[]; a: number };
  const parsedPayload = parsed.event.payload as { z: { text: string }[]; a: number };
  input.id = 'changed'; input.event.type = 'changed'; originalPayload.z[0]!.text = 'changed';
  assert.equal(parsed.id, 'wake-1'); assert.equal(parsed.event.type, 'worker.finished'); assert.equal(parsedPayload.z[0]!.text, 'original');
  parsed.reason = 'changed snapshot'; parsedPayload.z.push({ text: 'new' });
  assert.equal(input.reason, ' original '); assert.equal(originalPayload.z.length, 1);
  assert.deepEqual(Object.keys(parsedPayload), ['a', 'z']); assert.equal(Object.is(parsedPayload.a, -0), false);
  const data = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":"data"}}') as Json;
  const snapshot = parseExternalEvent(event(data)).payload;
  assert.deepEqual(snapshot, data); assert.equal(Object.getPrototypeOf(snapshot), Object.prototype);
  assert(Object.hasOwn(snapshot as object, '__proto__')); assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

test('external wire budget counts the whole UTF-8 envelope, escaping and embedded Wake event', () => {
  const encoder = new TextEncoder();
  const eventOverhead = encoder.encode(JSON.stringify(event(''))).byteLength;
  const exactly = event('a'.repeat(MAX_EXTERNAL_INPUT_BYTES - eventOverhead));
  assert.equal(encoder.encode(JSON.stringify(exactly)).byteLength, MAX_EXTERNAL_INPUT_BYTES);
  assert.deepEqual(parseExternalEvent(exactly), exactly);
  assert.throws(() => parseExternalEvent(event(`${exactly.payload}a`)), invalid);
  assert.throws(() => parseExternalWake({ ...wake(), event: exactly }), invalid);
  const wakeOverhead = encoder.encode(JSON.stringify({ ...wake(), event: event('') })).byteLength;
  const exactWake = { ...wake(), event: event('a'.repeat(MAX_EXTERNAL_INPUT_BYTES - wakeOverhead)) };
  assert.equal(encoder.encode(JSON.stringify(exactWake)).byteLength, MAX_EXTERNAL_INPUT_BYTES);
  assert.deepEqual(parseExternalWake(exactWake), exactWake);
  assert.throws(() => parseExternalWake({ ...exactWake, event: event(`${exactWake.event.payload}a`) }), invalid);
  assert.throws(() => parseExternalEvent(event('你'.repeat(30_000))), invalid);
  assert.throws(() => parseExternalEvent(event('\n'.repeat(33_000))), invalid);
  assert.deepEqual(parseExternalEvent(event('你'.repeat(1000))), event('你'.repeat(1000)));
});

const notification = (text = 'Synthetic local notification'): ExternalNotification => ({ id: 'notification-1', occurredAt: '2026-10-11T12:00:00.000Z', text });

test('external notifications are independent exact snapshots with caller-owned IDs and timestamps', () => {
  const original = notification('  preserve spacing\n');
  const snapshot = parseExternalNotification(original);
  original.id = 'changed'; original.text = 'changed';
  assert.deepEqual(snapshot, notification('  preserve spacing\n'));
  assert.deepEqual(parseExternalNotification(Object.assign(Object.create(null), notification())), notification());
  for (const field of ['id', 'occurredAt', 'text']) {
    const missing = { ...notification() } as Record<string, unknown>; delete missing[field];
    assert.throws(() => parseExternalNotification(missing), invalid);
    const hidden = Object.defineProperty(notification(), field, { enumerable: false });
    assert.throws(() => parseExternalNotification(hidden), invalid);
  }
  for (const input of [null, [], { ...notification(), event: event() }, { ...notification(), [Symbol('secret')]: true },
    { ...notification(), id: '../secret' }, { ...notification(), occurredAt: '2026-10-11' }, Object.create(notification())]) {
    assert.throws(() => parseExternalNotification(input), invalid);
  }
  let reads = 0;
  const accessor = Object.defineProperty(notification(), 'text', { enumerable: true, get() { reads++; throw Error('SECRET'); } });
  assert.throws(() => parseExternalNotification(accessor), invalid); assert.equal(reads, 0);
});

test('external notification text must be nonblank, at most 16000 UTF-16 characters and within the UTF-8 wire budget', () => {
  for (const text of ['', ' \t\n', '\u00a0', 1, null, 'a'.repeat(MAX_EXTERNAL_NOTIFICATION_TEXT_LENGTH + 1)]) {
    assert.throws(() => parseExternalNotification({ ...notification(), text }), invalid);
  }
  assert.equal(parseExternalNotification(notification('a'.repeat(MAX_EXTERNAL_NOTIFICATION_TEXT_LENGTH))).text.length, 16000);
  const overhead = new TextEncoder().encode(JSON.stringify(notification(''))).byteLength;
  const remaining = MAX_EXTERNAL_INPUT_BYTES - overhead;
  const exact = notification('\0'.repeat(Math.floor(remaining / 6)) + 'a'.repeat(remaining % 6));
  assert.equal(new TextEncoder().encode(JSON.stringify(exact)).byteLength, MAX_EXTERNAL_INPUT_BYTES);
  assert.deepEqual(parseExternalNotification(exact), exact);
  assert.throws(() => parseExternalNotification({ ...exact, text: `${exact.text}a` }), invalid);
  assert.throws(() => parseExternalNotification(notification('\0'.repeat(16000))), invalid);
});

test('external receipt parsing accepts only exact persisted operation-specific fields', () => {
  const receipts: ExternalReceipt[] = [
    { operation: 'event', id: 'event-1', receipt: 'inserted', durability: 'persisted' },
    { operation: 'wake', id: 'wake-1', eventId: 'event-1', receipt: 'duplicate', durability: 'persisted' },
    { operation: 'notification', id: 'notification-1', receipt: 'inserted', durability: 'persisted' },
  ];
  for (const receipt of receipts) {
    assert.deepEqual(parseExternalReceipt(receipt), receipt);
    assert.notEqual(parseExternalReceipt(receipt), receipt);
    for (const key of Object.keys(receipt)) {
      const missing = { ...receipt } as Record<string, unknown>; delete missing[key];
      assert.throws(() => parseExternalReceipt(missing), invalid);
    }
    for (const value of [{ ...receipt, ignored: 'SECRET' }, { ...receipt, durability: 'queued' }, { ...receipt, receipt: 'ok' },
      { ...receipt, id: '' }, Object.create(receipt)]) assert.throws(() => parseExternalReceipt(value), invalid);
  }
  for (const value of [null, [], { operation: 'unknown' }, { ...receipts[0], eventId: 'event-1' },
    { ...receipts[1], eventId: '../bad' }, { ...receipts[2], eventId: 'event-1' }]) assert.throws(() => parseExternalReceipt(value), invalid);
  let reads = 0;
  assert.throws(() => parseExternalReceipt(Object.defineProperty({}, 'operation', { get() { reads++; throw Error('SECRET'); } })), invalid);
  assert.equal(reads, 0);
});

test('tiny repeated-reference DAGs stop at the expanded byte budget before exponential allocation', () => {
  // Only 29 input arrays, but naive deep cloning would allocate 2^29 branches.
  // A proxy counts traversal rather than asserting environment-dependent timing.
  let visits = 0;
  let shared: unknown = null;
  for (let depth = 0; depth < 29; depth++) {
    shared = new Proxy([shared, shared], { getPrototypeOf(target) {
      visits++;
      if (visits > MAX_EXTERNAL_INPUT_BYTES) throw Error('Stop the regression probe before unbounded allocation');
      return Reflect.getPrototypeOf(target);
    } });
  }
  assert.throws(() => parseExternalEvent({ ...event(), payload: shared }), invalid);
  assert.ok(visits < MAX_EXTERNAL_INPUT_BYTES, `Traversal must stop within the byte budget, got ${visits}`);
  // Quoted keys, escaping and UTF-8 bytes count, even when references repeat.
  const unicode = { ['键\\"']: '😀'.repeat(1_000) };
  assert.throws(() => parseExternalEvent(event(Array.from({ length: 20 }, () => unicode))), invalid);
});
