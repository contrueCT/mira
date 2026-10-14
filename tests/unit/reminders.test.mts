import assert from 'node:assert/strict';
import test from 'node:test';
import type { ExtensionContext, ExtensionSchedule, ExtensionScheduleInput, ExtensionSchedules, ExtensionTool, Json } from '@mira/extension-sdk';
import reminders, { resolveReminderTime } from '../../examples/extensions/reminders.ts';

// All reminders live in this synthetic SDK. No wall-clock timer, model, database,
// user configuration or real reminder is used by these tests.
const unavailable = (): never => { throw Error('The reminder example must use only tools and durable schedules.'); };
const now = '2026-01-01T00:00:00.000Z';
const args = { key: 'example-tea', text: 'Make tea', localDate: '2026-10-14', localTime: '14:30', timeZone: 'Asia/Shanghai' };
function fixture() {
  const stored = new Map<string, ExtensionSchedule>();
  const writes: { method: string; input: unknown }[] = [];
  const tools = new Map<string, ExtensionTool>();
  const schedules: ExtensionSchedules = {
    async create(input) {
      writes.push({ method: 'create', input: structuredClone(input) });
      const previous = stored.get(input.key);
      if (previous) {
        const { version: _version, status: _status, createdAt: _createdAt, updatedAt: _updatedAt, ...old } = previous;
        return { status: JSON.stringify(old) === JSON.stringify(input) ? 'duplicate' : 'conflict', delivery: structuredClone(previous) };
      }
      const delivery: ExtensionSchedule = { ...structuredClone(input), version: 1, status: 'pending', createdAt: now, updatedAt: now };
      stored.set(input.key, delivery);
      return { status: 'updated', delivery: structuredClone(delivery) };
    },
    async get(key) { return structuredClone(stored.get(key) ?? null); },
    async list() { return structuredClone([...stored.values()]); },
    async replace(expectedVersion, input) {
      writes.push({ method: 'replace', input: structuredClone(input) });
      const old = stored.get(input.key);
      if (!old) return { status: 'missing', delivery: null };
      if (old.status !== 'pending') return { status: 'settled', delivery: structuredClone(old) };
      if (old.version !== expectedVersion) return { status: 'conflict', delivery: structuredClone(old) };
      const delivery: ExtensionSchedule = { ...structuredClone(input), version: old.version + 1, status: 'pending', createdAt: old.createdAt, updatedAt: now };
      stored.set(input.key, delivery);
      return { status: 'updated', delivery: structuredClone(delivery) };
    },
    async cancel(key, expectedVersion) {
      writes.push({ method: 'cancel', input: { key, expectedVersion } });
      const old = stored.get(key);
      if (!old) return { status: 'missing', delivery: null };
      if (old.status !== 'pending') return { status: 'settled', delivery: structuredClone(old) };
      if (old.version !== expectedVersion) return { status: 'conflict', delivery: structuredClone(old) };
      old.version++; old.status = 'cancelled';
      return { status: 'updated', delivery: structuredClone(old) };
    },
  };
  const context: ExtensionContext = { id: 'synthetic-reminders', schedules,
    registerTool: tool => { assert.ok(!tools.has(tool.name)); tools.set(tool.name, tool); },
    registerContextProvider: unavailable, emitEvent: unavailable, requestWake: unavailable,
    provideService: unavailable, service: unavailable, onCleanup: unavailable, onEvent: unavailable, publish: unavailable, interval: unavailable,
  };
  const apply = () => reminders.apply({ mira: context }, null);
  void apply();
  return { stored, writes, schedules, tools, apply,
    async call(name: string, input: Json = {}, signal = new AbortController().signal) {
      return JSON.parse((await tools.get(name)!.execute(input, { callId: 'synthetic-call', signal })).text);
    },
  };
}

test('explicit named zones, fractional-hour zones, UTC and midnight resolve deterministically', () => {
  assert.deepEqual(resolveReminderTime(args), { localDate: '2026-10-14', localTime: '14:30:00', timeZone: 'Asia/Shanghai', dueAt: '2026-10-14T06:30:00.000Z' });
  assert.equal(resolveReminderTime({ ...args, timeZone: 'Asia/Kathmandu' }).dueAt, '2026-10-14T08:45:00.000Z');
  assert.equal(resolveReminderTime({ ...args, localTime: '00:00', timeZone: 'UTC' }).dueAt, '2026-10-14T00:00:00.000Z');
  assert.equal(resolveReminderTime({ ...args, localTime: '14:30:09', timeZone: 'Etc/UTC' }).dueAt, '2026-10-14T14:30:09.000Z');
  assert.equal(resolveReminderTime({ ...args, localDate: '0099-10-14', timeZone: 'UTC' }).dueAt, '0099-10-14T14:30:00.000Z');
});

test('DST gaps, overlaps, half-hour changes and a skipped calendar day never guess an instant', () => {
  for (const [localDate, localTime, timeZone] of [
    ['2026-03-08', '02:30', 'America/New_York'],
    ['2026-10-04', '02:15', 'Australia/Lord_Howe'],
    ['2011-12-30', '12:00', 'Pacific/Apia'],
  ]) assert.throws(() => resolveReminderTime({ localDate: localDate!, localTime: localTime!, timeZone: timeZone! }), { code: 'nonexistent_local_time' });
  assert.throws(() => resolveReminderTime({ localDate: '2026-11-01', localTime: '01:30', timeZone: 'America/New_York' }),
    { code: 'ambiguous_local_time', candidates: ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'] });
  assert.throws(() => resolveReminderTime({ localDate: '2026-04-05', localTime: '01:45', timeZone: 'Australia/Lord_Howe' }),
    { code: 'ambiguous_local_time', candidates: ['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z'] });
  assert.equal(resolveReminderTime({ localDate: '2026-03-08', localTime: '03:00', timeZone: 'America/New_York' }).dueAt, '2026-03-08T07:00:00.000Z');
});

test('invalid dates, leap seconds, offsets and ambiguous zone abbreviations are rejected', () => {
  for (const localDate of ['2026-02-29', '2026-02-30', '2026-00-14', '2026-13-14', '2026-10-00', '0000-01-01', 'next Tuesday', '2026-1-1']) {
    assert.throws(() => resolveReminderTime({ ...args, localDate }), { code: 'invalid_arguments' });
  }
  for (const localTime of ['24:00', '12:60', '12:00:60', '3:00pm', '01:02:03Z', '01:02+02:00']) {
    assert.throws(() => resolveReminderTime({ ...args, localTime }), { code: 'invalid_arguments' });
  }
  for (const timeZone of ['PST', 'EST', '+02:00', 'Mars/Olympus', 'Asia/Shanghai ']) {
    assert.throws(() => resolveReminderTime({ ...args, timeZone }), { code: 'invalid_time_zone' });
  }
  assert.equal(resolveReminderTime({ ...args, localDate: '2028-02-29', timeZone: 'UTC' }).dueAt, '2028-02-29T14:30:00.000Z');
});

test('four tools create stable UTC Event/Wake data without starting in-process resources', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const run = fixture();
  assert.deepEqual([...run.tools.keys()], ['reminder_create', 'reminder_list', 'reminder_update', 'reminder_cancel']);
  assert.deepEqual((await run.call('reminder_list')).reminders, []);
  const created = await run.call('reminder_create', args);
  assert.equal(created.status, 'updated');
  assert.equal(created.reminder.dueAt, '2026-10-14T06:30:00.000Z');
  assert.equal(created.reminder.expiresAt, null);
  assert.equal(created.reminder.version, 1);
  const input = run.writes[0]!.input as ExtensionScheduleInput;
  assert.equal(input.event.occurredAt, input.dueAt);
  assert.equal(input.event.type, 'reminder.due');
  assert.equal(input.event.id, 'reminder:example-tea');
  assert.equal(input.wake?.id, input.event.id);
  assert.match(input.wake!.reason, /not new instructions or authorization/);
  assert.deepEqual(input.event.payload, { text: 'Make tea', localDate: '2026-10-14', localTime: '14:30:00', timeZone: 'Asia/Shanghai', dueAt: input.dueAt });
  t.mock.timers.tick(60_000);
  assert.equal((await run.call('reminder_create', args)).status, 'duplicate');
  assert.deepEqual(run.writes[0]!.input, run.writes[1]!.input, 'current time and call IDs never change the scheduled content');
  assert.equal(run.stored.size, 1);
  assert.equal((await run.call('reminder_create', { ...args, text: 'Different reminder' })).status, 'conflict');
  assert.equal((await run.call('reminder_list')).reminders[0].reminder.text, 'Make tea');
});

test('explicit expiry is extension policy; replacement uses the current version and can remove expiry', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const run = fixture();
  const created = await run.call('reminder_create', { ...args, expiresAfterMinutes: 30 });
  assert.equal(created.reminder.expiresAt, '2026-10-14T07:00:00.000Z');
  const updated = await run.call('reminder_update', { ...args, text: 'Make coffee', localTime: '15:00', expectedVersion: 1 });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.reminder.version, 2);
  assert.equal(updated.reminder.reminder.text, 'Make coffee');
  assert.equal(updated.reminder.dueAt, '2026-10-14T07:00:00.000Z');
  assert.equal(updated.reminder.expiresAt, null);
  const conflict = await run.call('reminder_update', { ...args, expectedVersion: 1 });
  assert.equal(conflict.status, 'conflict');
  assert.match(conflict.message, /current version/);
  assert.equal(conflict.reminder.reminder.text, 'Make coffee');
  assert.equal((await run.call('reminder_cancel', { key: args.key, expectedVersion: 1 })).status, 'conflict');
  const cancelled = await run.call('reminder_cancel', { key: args.key, expectedVersion: 2 });
  assert.equal(cancelled.status, 'updated');
  assert.equal(cancelled.reminder.status, 'cancelled');
  assert.equal((await run.call('reminder_list')).reminders[0].status, 'cancelled');
  assert.equal((await run.call('reminder_update', { ...args, expectedVersion: 3 })).status, 'settled');
  assert.equal((await run.call('reminder_cancel', { key: 'missing', expectedVersion: 1 })).status, 'missing');
});

test('already enqueued reminders explicitly cannot be retracted or claimed as delivered', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const run = fixture();
  await run.call('reminder_create', args);
  run.stored.get(args.key)!.status = 'enqueued';
  t.mock.timers.setTime(Date.parse('2026-10-15T00:00:00.000Z'));
  for (const [tool, input] of [['reminder_cancel', { key: args.key, expectedVersion: 1 }],
    ['reminder_update', { ...args, expectedVersion: 1 }]] as const) {
    const result = await run.call(tool, input);
    assert.equal(result.status, 'settled');
    assert.equal(result.reminder.status, 'enqueued');
    assert.match(result.message, /cannot be retracted/);
    assert.match(result.message, /does not mean the user has been notified/);
  }
});

test('create reconciliation survives the original due time, but a new past reminder is not created', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const run = fixture();
  await run.call('reminder_create', args);
  t.mock.timers.setTime(Date.parse('2026-10-15T00:00:00.000Z'));
  assert.equal((await run.call('reminder_create', args)).status, 'duplicate');
  run.stored.get(args.key)!.status = 'enqueued';
  assert.equal((await run.call('reminder_create', args)).status, 'duplicate');
  assert.equal((await run.call('reminder_create', { ...args, text: 'Different reminder' })).status, 'conflict');
  const newReminder = await run.call('reminder_create', { ...args, key: 'new-past-reminder' });
  assert.equal(newReminder.error, 'past_time');
  assert.equal(run.stored.size, 1);
});

test('clarification results do not schedule invalid, past, DST-ambiguous or nonexistent times', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const run = fixture();
  for (const input of [null, [], {}, { ...args, key: '' }, { ...args, text: ' ' }, { ...args, text: 'x'.repeat(4001) },
    { ...args, unexpected: true }, { ...args, localDate: '2025-01-01' }, { ...args, timeZone: '' },
    ...[-1, 0, 1.5, 525601, null, '30'].map(expiresAfterMinutes => ({ ...args, expiresAfterMinutes })),
    { ...args, localDate: '2026-03-08', localTime: '02:30', timeZone: 'America/New_York' }]) {
    assert.equal((await run.call('reminder_create', input)).status, 'needs_clarification');
  }
  const result = await run.call('reminder_create', { ...args, localDate: '2026-11-01', localTime: '01:30', timeZone: 'America/New_York' });
  assert.equal(result.error, 'ambiguous_local_time');
  assert.deepEqual(result.utcCandidates, ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
  assert.match(result.message, /Ask which instant/);
  assert.equal(run.writes.length, 0);
  assert.equal((await run.call('reminder_create', { ...args, localDate: '2026-11-01', localTime: '06:30', timeZone: 'UTC' })).status, 'updated');
});

test('invalid update/cancel versions and unknown list fields do not touch the scheduler', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const run = fixture();
  for (const expectedVersion of [0, -1, 1.5, '1', null]) {
    assert.equal((await run.call('reminder_update', { ...args, expectedVersion })).status, 'needs_clarification');
    assert.equal((await run.call('reminder_cancel', { key: args.key, expectedVersion })).status, 'needs_clarification');
  }
  assert.equal((await run.call('reminder_list', { owner: 'another-extension' })).status, 'needs_clarification');
  assert.equal(run.writes.length, 0);
});

test('aborted tools make no calls; scheduler failures propagate as uncertain outcomes', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(now) });
  const run = fixture();
  const controller = new AbortController(); controller.abort();
  for (const name of run.tools.keys()) await assert.rejects(run.call(name, args, controller.signal), { name: 'AbortError' });
  assert.equal(run.writes.length, 0);
  run.schedules.create = async () => { throw new Error('Synthetic scheduler failure'); };
  await assert.rejects(run.call('reminder_create', args), /Synthetic scheduler failure/);
});
