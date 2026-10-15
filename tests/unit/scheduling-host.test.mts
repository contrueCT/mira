import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArtifactStore, ExtensionHost, readExtensionConfiguration, type ExtensionHostOptions } from '@mira/extension-host';
import type { ExtensionContext, ExtensionSchedule, ExtensionScheduleInput, ExtensionSchedules } from '@mira/extension-sdk';
import type { ScheduledDelivery, ScheduledDeliveryInput, SchedulingWriter } from '@mira/life';
import { DeliveryTimer, extensionScheduling } from '../../apps/server/src/scheduling.ts';

const receive: ExtensionHostOptions['receive'] = async () => 'inserted';
const timestamp = '2026-10-14T08:00:00.000Z';
const input: ExtensionScheduleInput = { key: 'reminder', dueAt: timestamp,
  event: { id: 'caller-event', type: 'fixture.reminder', occurredAt: timestamp, payload: { text: 'Reminder body' } },
  wake: { id: 'caller-wake', reason: 'A due reminder' } };
const pending: ExtensionSchedule = { ...input, version: 1, status: 'pending', createdAt: timestamp, updatedAt: timestamp };
const owners = (host: ExtensionHost) => host.withScheduledOwners(async values => values);
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}
async function directory(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-scheduling-host-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
interface State { contexts: ExtensionContext[]; cleaning: number; cleanupGate: Promise<void> }
async function manual(root: string) {
  const modulePath = path.join(root, 'manual.mjs');
  await writeFile(modulePath, `import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
    export const state = { contexts: [], cleaning: 0, cleanupGate: Promise.resolve() };
    export default defineExtension({ name: 'declared-name-is-not-the-owner', apply(ctx) {
      state.contexts.push(ctx);
      ctx.onCleanup(async () => { state.cleaning++; await state.cleanupGate; });
    } });`);
  return { modulePath, state: (await import(pathToFileURL(modulePath).href) as { state: State }).state };
}
function recordingService() {
  const calls: Array<{ owner: string; extensionId: string; method: string; arguments: unknown[] }> = [];
  const factory: NonNullable<ExtensionHostOptions['schedules']> = (owner, extensionId) => {
    const record = (method: string, args: unknown[]) => calls.push({ owner, extensionId, method, arguments: structuredClone(args) });
    return {
      create: async value => { record('create', [value]); return { status: 'updated', delivery: structuredClone(pending) }; },
      replace: async (version, value) => { record('replace', [version, value]); return { status: 'conflict', delivery: structuredClone(pending) }; },
      cancel: async (key, version) => { record('cancel', [key, version]); return { status: 'settled', delivery: { ...structuredClone(pending), status: 'enqueued', version: 2 } }; },
      get: async key => { record('get', [key]); return key === input.key ? structuredClone(pending) : null; },
      list: async () => { record('list', []); return [structuredClone(pending)]; },
    };
  };
  return { calls, factory };
}

// Only the scheduling persistence boundary is a recorder here. Cordis lifecycle,
// module loading and the existing atomic ConfigurationWriter are real adapters.
test('manual scheduling persists its installation before activation and keeps the owner across reload, disable/enable and host restart', async () => directory(async root => {
  const { modulePath, state } = await manual(root); const recording = recordingService();
  const configurationFile = path.join(root, 'extensions.json');
  await writeFile(configurationFile, JSON.stringify({ entries: [{ id: 'manual', path: modulePath }], unrelated: { preserve: true } }));
  const seen: string[] = []; let notifications = 0;
  const schedules: NonNullable<ExtensionHostOptions['schedules']> = (owner, id) => {
    const saved = JSON.parse(readFileSync(configurationFile, 'utf8')) as { entries: Array<{ installationId: string }> };
    assert.equal(owner, JSON.stringify(['extension', id, saved.entries[0]!.installationId]), 'identity is saved before an extension can schedule');
    assert.match(saved.entries[0]!.installationId, /^[0-9a-f-]{36}$/); seen.push(owner);
    return recording.factory(owner, id);
  };
  let host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive, schedules, onSchedulesChanged: () => notifications++ });
  try {
    await host.start(); const [owner] = await owners(host); assert.ok(owner);
    const first = state.contexts.at(-1)!.schedules;
    assert.equal((await first.create(input)).status, 'updated'); assert.equal(notifications, 1);
    assert.equal(await first.get('missing'), null); assert.deepEqual(await first.list(), [pending]);
    assert.equal(notifications, 1, 'read-only inspection does not schedule another timer pass');
    assert.equal((await first.replace(7, input)).status, 'conflict');
    const cancelled = await first.cancel(input.key, 1);
    assert.equal(cancelled.status, 'settled'); assert.equal(cancelled.delivery!.status, 'enqueued', 'already-enqueued delivery is not reported cancelled');
    assert.equal(notifications, 3);
    assert.equal((await host.requestChange('manual', { action: 'reload' })).status, 'applied');
    assert.deepEqual(await owners(host), [owner]);
    assert.equal((await host.requestChange('manual', { action: 'disable' })).status, 'applied');
    assert.deepEqual(await owners(host), [], 'disabled entries cannot dispatch pending deliveries');
    assert.equal((await host.requestChange('manual', { action: 'enable' })).status, 'applied');
    assert.deepEqual(await owners(host), [owner], 'enable resumes the same pending owner');
    await host.close();
    const saved = JSON.parse(await readFile(configurationFile, 'utf8')) as { entries: Array<{ installationId: string }>; unrelated: unknown };
    assert.deepEqual(saved.unrelated, { preserve: true });
    const identity = saved.entries[0]!.installationId;
    host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive, schedules });
    await host.start(); assert.deepEqual(await owners(host), [owner]);
    assert.equal((await readExtensionConfiguration(configurationFile)).entries[0]!.installationId, identity);
    assert.ok(seen.length >= 4); assert.ok(seen.every(value => value === owner));
    assert.ok(recording.calls.every(call => call.owner === owner && call.extensionId === 'manual'));
  } finally { await host.close(); }
}));

test('retiring and retired activations cannot call any scheduling method, including after a same-name replacement', async () => directory(async root => {
  const { modulePath, state } = await manual(root); const recording = recordingService();
  const configurationFile = path.join(root, 'extensions.json');
  await writeFile(configurationFile, JSON.stringify({ entries: [{ id: 'manual', path: modulePath }] }));
  const host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive, schedules: recording.factory });
  const release = Promise.withResolvers<void>();
  try {
    await host.start(); const previous = state.contexts.at(-1)!.schedules;
    state.cleanupGate = release.promise;
    const reload = host.requestChange('manual', { action: 'reload' });
    await until(() => state.cleaning > 0, 'Reload did not enter cleanup');
    const actions = (api: ExtensionSchedules) => [() => api.create(input), () => api.get(input.key), () => api.list(),
      () => api.replace(1, input), () => api.cancel(input.key, 1)];
    for (const action of actions(previous)) await assert.rejects(action);
    assert.equal(recording.calls.length, 0, 'the persistence adapter is not touched while the activation retires');
    release.resolve(); assert.equal((await reload).status, 'applied');
    const current = state.contexts.at(-1)!.schedules; assert.notEqual(current, previous);
    for (const action of actions(previous)) await assert.rejects(action);
    assert.equal(recording.calls.length, 0, 'old handles never switch to the new implementation');
    await current.create(input); assert.equal(recording.calls.length, 1);
    await host.close();
    for (const action of actions(current)) await assert.rejects(action);
    assert.equal(recording.calls.length, 1);
  } finally { release.resolve(); await host.close(); }
}));

test('manual scheduling without a persisted identity fails explicitly instead of creating restart-unstable schedules', async () => directory(async root => {
  const { modulePath, state } = await manual(root); const recording = recordingService();
  const host = new ExtensionHost({ entries: [{ id: 'manual', path: modulePath }], receive, schedules: recording.factory });
  try {
    await host.start(); assert.equal(host.inspect()[0]!.status, 'active'); assert.deepEqual(await owners(host), []);
    await assert.rejects(() => state.contexts[0]!.schedules.create(input), /durable installation identity/);
    await assert.rejects(() => state.contexts[0]!.schedules.list(), /durable installation identity/);
    assert.deepEqual(recording.calls, []);
  } finally { await host.close(); }
}));

test('generated scheduling keeps the first installation revision through update/rollback and gives reinstall a different owner', async () => directory(async root => {
  const source = path.join(root, 'source'); await mkdir(path.join(source, 'node_modules/@mira'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../packages/extension-sdk/', import.meta.url)), path.join(source, 'node_modules/@mira/extension-sdk'));
  await writeFile(path.join(source, 'package.json'), '{"type":"module","private":true}');
  await writeFile(path.join(source, 'entry.mjs'), "import { defineExtension } from '@mira/extension-sdk'; export default defineExtension({ name: 'generated', apply() {} });\n");
  const store = new ArtifactStore(path.join(root, 'artifacts')); const first = await store.stage(source, 'entry.mjs');
  const configurationFile = path.join(root, 'extensions.json');
  await writeFile(configurationFile, JSON.stringify({ entries: [], artifactsDirectory: store.root }));
  const recording = recordingService(); let host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive, schedules: recording.factory });
  try {
    await host.start(); await host.requestChange('generated', { action: 'install', digest: first.digest });
    assert.deepEqual(await owners(host), [], 'install remains disabled');
    const originalRevision = host.inspect()[0]!.generated!.revision; assert.ok(originalRevision);
    await host.requestChange('generated', { action: 'activate' });
    const [owner] = await owners(host); assert.equal(owner, JSON.stringify(['extension', 'generated', originalRevision]));
    await writeFile(path.join(source, 'entry.mjs'), "import { defineExtension } from '@mira/extension-sdk'; export default defineExtension({ name: 'updated', apply() {} });\n");
    const second = await store.stage(source, 'entry.mjs');
    assert.equal((await host.requestChange('generated', { action: 'update', digest: second.digest })).status, 'applied');
    assert.notEqual(host.inspect()[0]!.generated!.revision, originalRevision); assert.deepEqual(await owners(host), [owner]);
    assert.equal((await host.requestChange('generated', { action: 'rollback', revision: originalRevision })).status, 'applied');
    assert.deepEqual(await owners(host), [owner]);
    await host.close(); host = new ExtensionHost({ ...await readExtensionConfiguration(configurationFile), receive, schedules: recording.factory });
    await host.start(); assert.deepEqual(await owners(host), [owner]);
    await host.requestChange('generated', { action: 'remove' }); assert.deepEqual(await owners(host), []);
    await host.requestChange('generated', { action: 'install', digest: first.digest });
    await host.requestChange('generated', { action: 'activate' });
    const [reinstalled] = await owners(host); assert.ok(reinstalled); assert.notEqual(reinstalled, owner);
    assert.equal(reinstalled, JSON.stringify(['extension', 'generated', host.inspect()[0]!.generated!.history[0]!.id]));
  } finally { await host.close(); }
}));

test('server schedule projection binds unforgeable owner/source namespaces and preserves missing, conflict and settled inspection results', async () => {
  const calls: Array<{ method: string; owner: string; key?: string; version?: number; input?: ScheduledDeliveryInput }> = [];
  const owner = JSON.stringify(['extension', 'configured', 'installation']);
  let current: ScheduledDelivery | null = null;
  const writer: SchedulingWriter = {
    createScheduledDelivery: async (bound, value) => {
      calls.push({ method: 'create', owner: bound, input: structuredClone(value) });
      current = { ...structuredClone(value), owner: bound, version: 1, status: 'pending', createdAt: timestamp, updatedAt: timestamp };
      return { status: 'updated', delivery: current };
    },
    getScheduledDelivery: async (bound, key) => { calls.push({ method: 'get', owner: bound, key }); return key === input.key ? current : null; },
    listScheduledDeliveries: async bound => { assert.ok(bound); calls.push({ method: 'list', owner: bound }); return current ? [current] : []; },
    replaceScheduledDelivery: async (bound, version, value) => { calls.push({ method: 'replace', owner: bound, version, input: value }); return { status: 'conflict', delivery: current! }; },
    cancelScheduledDelivery: async (bound, key, version) => {
      calls.push({ method: 'cancel', owner: bound, key, version });
      if (key !== input.key) return { status: 'missing', delivery: null };
      current = { ...current!, version: 2, status: 'enqueued' }; return { status: 'settled', delivery: current };
    },
    dispatchScheduledDeliveries: async () => { throw Error('Not called by the extension-facing API'); },
  };
  const api = extensionScheduling(writer)(owner, 'configured');
  assert.equal(await api.get('missing'), null); assert.deepEqual(await api.list(), []);
  const spoofed = { ...structuredClone(input), owner: 'other-owner', event: { ...input.event, source: 'user' } };
  assert.deepEqual(await api.create(spoofed), { status: 'updated', delivery: pending });
  const created = calls.find(call => call.method === 'create')!.input!;
  assert.deepEqual(created.event, { id: JSON.stringify(['scheduled', owner, input.key, 'event']), source: 'extension',
    type: input.event.type, occurredAt: input.event.occurredAt,
    payload: { extensionId: 'configured', eventId: input.event.id, data: input.event.payload, wakeId: input.wake!.id } });
  assert.deepEqual(created.wake, { id: JSON.stringify(['scheduled', owner, input.key, 'wake']), reason: input.wake!.reason });
  assert.deepEqual(await api.get(input.key), pending); assert.deepEqual(await api.list(), [pending]);
  assert.deepEqual(await api.replace(99, input), { status: 'conflict', delivery: pending });
  assert.deepEqual(await api.cancel('missing', 1), { status: 'missing', delivery: null });
  const enqueued = { ...pending, version: 2, status: 'enqueued' };
  assert.deepEqual(await api.cancel(input.key, 1), { status: 'settled', delivery: enqueued });
  assert.deepEqual(await api.get(input.key), enqueued); assert.deepEqual(await api.list(), [enqueued]);
  assert.ok(calls.every(call => call.owner === owner));
  assert.deepEqual(calls.filter(call => call.method === 'replace').map(call => call.version), [99]);
  const message = { direction: 'outbound' as const, text: 'Scheduled notification', sourceLabel: 'Ordinary plugin' };
  const projected = await api.create({ ...input, event: { ...input.event, message } });
  assert.deepEqual(projected.delivery?.event.message, message);
  const envelope = calls.filter(call => call.method === 'create').at(-1)!.input!.event;
  assert.deepEqual(envelope.payload, { extensionId: 'configured', eventId: input.event.id, data: input.event.payload, wakeId: input.wake!.id, scheduleOwner: owner, scheduleKey: input.key, message });
});

test('delivery timer coalesces notifications without overlapping passes and drains cleanly on close', async () => {
  const release = Promise.withResolvers<void>(); let checks = 0, active = 0, maxActive = 0; const errors: unknown[] = [];
  const timer = new DeliveryTimer(async () => {
    checks++; active++; maxActive = Math.max(maxActive, active);
    if (checks === 1) await release.promise;
    active--; return null;
  }, error => errors.push(error));
  try {
    timer.schedule(); await until(() => checks === 1, 'Timer did not start');
    timer.schedule(); timer.schedule(); release.resolve();
    await until(() => checks === 2, 'Changes during dispatch did not produce a follow-up pass');
    assert.equal(maxActive, 1); await timer.close(); timer.schedule(); await delay(10);
    assert.equal(checks, 2); assert.deepEqual(errors, []);
  } finally { release.resolve(); await timer.close(); }
});


test('delivery timer backs off an overdue local hint instead of hot-looping against a slower database clock', async () => {
  const originalNow = Date.now;
  const deadline = new Date(originalNow() + 60_000).toISOString();
  let checks = 0; const errors: unknown[] = [];
  const timer = new DeliveryTimer(async () => { checks++; return deadline; }, error => errors.push(error));
  try {
    Date.now = () => originalNow() + 3_600_000;
    timer.schedule();
    await delay(150);
    assert.equal(checks, 1, 'an ineligible deadline must not produce one transaction per millisecond');
    assert.deepEqual(errors, []);
  } finally { Date.now = originalNow; await timer.close(); }
});
