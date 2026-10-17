import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { LocalWebService } from '@mira/server';
import { readExtensionConfiguration } from '@mira/extension-host';
import { extensionScheduling } from '../../apps/server/src/scheduling.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, streamOf } from './fixtures.mts';

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(predicate: () => Promise<boolean>, message: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (!await predicate()) { if (Date.now() > end) throw new Error(message); await pause(10); }
}
type Database = Awaited<ReturnType<typeof createTestDatabase>>;
async function setup(db: Database, root: string) {
  const file = path.resolve('examples/extensions/reminders.ts');
  const config = path.join(root, 'extensions.json');
  await writeFile(config, JSON.stringify({ entries: [{ id: 'reminders', path: file }] }));
  const common = { connectionString: db.connectionString, schema: db.schema, miraId: 'scheduling-service',
    sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    synthetic: true, autoCompaction: { enabled: false }, dreaming: { enabled: false } };
  return { common, config };
}

// Real PostgreSQL, host, ordinary tool persistence, timer and WakeLoop. Only the
// provider is synthetic. A queued deadline cannot join or preempt an active run.
test('scheduled Wake enqueues during active cognition and executes only in the next run', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-scheduling-service-'));
  const gate = deferred(); let service: LocalWebService | undefined; let requests = 0;
  try {
    const { common, config } = await setup(db, root);
    service = await LocalWebService.open({ ...common, extensions: await readExtensionConfiguration(config), syntheticStream: (_m, context) => {
      requests++;
      if (requests === 1) {
        const dueAt = new Date(Math.ceil((Date.now() + 2_000) / 1000) * 1000).toISOString();
        return streamOf({ ...assistant(), stopReason: 'toolUse',
        content: [{ type: 'toolCall', id: 'schedule-call', name: 'reminder_create', arguments: { key: 'during-active', text: 'REMINDER_DURING_ACTIVE', localDate: dueAt.slice(0, 10), localTime: dueAt.slice(11, 19), timeZone: 'UTC' } }] });
      }
      if (requests === 2) {
        const stream = createAssistantMessageEventStream();
        void gate.promise.then(() => stream.push({ type: 'done', reason: 'stop', message: assistant('First run complete') }));
        return stream;
      }
      assert.equal(requests, 3);
      const lastInput = context.messages.filter(message => message.role === 'user').at(-1);
      assert.match(JSON.stringify(lastInput), /REMINDER_DURING_ACTIVE/);
      return streamOf(assistant('Due reminder processed'));
    } });
    await service.submit({ id: randomUUID(), text: 'Create the synthetic reminder', occurredAt: new Date().toISOString() });
    await until(async () => requests === 2, 'schedule tool did not reach active cognition');
    await until(async () => (await db.admin.query("SELECT status FROM scheduled_deliveries WHERE schedule_key='during-active'")).rows[0]?.status === 'enqueued', 'deadline did not enqueue while active');
    assert.equal(requests, 2, 'timer must not create concurrent cognition');
    assert.equal((await db.admin.query('SELECT count(*)::integer AS count FROM wake_runs')).rows[0].count, 1);
    gate.resolve();
    await until(async () => requests === 3 && (await service!.status()).state === 'idle', 'next Wake did not drain');
    assert.equal((await db.admin.query('SELECT count(*)::integer AS count FROM wake_runs WHERE completed')).rows[0].count, 2);
    assert.equal((await db.admin.query("SELECT count(*)::integer AS count FROM life_events WHERE event->>'type'='reminder.due'")).rows[0].count, 1);
  } finally { gate.resolve(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('service restart catches up once, skips expired deadlines and preserves installation identity', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-scheduling-restart-'));
  let service: LocalWebService | undefined; let requests = 0;
  try {
    const { common, config } = await setup(db, root);
    service = await LocalWebService.open({ ...common, extensions: await readExtensionConfiguration(config) });
    await service.close(); service = undefined;
    const saved = await readExtensionConfiguration(config);
    const identity = saved.entries[0]!.installationId; assert(identity);
    const writer = await db.acquire(common.miraId);
    const api = extensionScheduling(writer)(JSON.stringify(['extension', 'reminders', identity]), 'reminders');
    const dueAt = '2020-01-01T00:00:00.000Z';
    for (const key of ['catch-up', 'expired']) await api.create({ key, dueAt,
      ...(key === 'expired' ? { expiresAt: dueAt } : {}),
      event: { id: key, type: 'fixture.reminder', occurredAt: dueAt, payload: { key } }, wake: { id: key, reason: 'Synthetic offline deadline' } });
    await writer.close();
    const reopen = async () => LocalWebService.open({ ...common, extensions: await readExtensionConfiguration(config), syntheticStream: () => {
      requests++; return streamOf(assistant('Caught up'));
    } });
    service = await reopen();
    await until(async () => requests === 1 && (await service!.status()).state === 'idle', 'restart did not catch up');
    const states = (await db.admin.query('SELECT schedule_key, status FROM scheduled_deliveries ORDER BY schedule_key')).rows;
    assert.deepEqual(states, [{ schedule_key: 'catch-up', status: 'enqueued' }, { schedule_key: 'expired', status: 'expired' }]);
    await service.close(); service = await reopen();
    await pause(100);
    assert.equal(requests, 1, 'restart cannot repeat already-enqueued input');
    assert.equal((await readExtensionConfiguration(config)).entries[0]!.installationId, identity);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
