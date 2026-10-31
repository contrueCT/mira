import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LifeRegistryError, migrate, PostgresLives } from '@mira/persistence';
import { createTestDatabase } from './database.mts';

const reset = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('the lives migration registers the existing local Mira as generation 0 and rolls back only without later generations', async () => {
  const db = await createTestDatabase();
  try {
    // Roll back the background-job index (ADR 0049) and usage indexes (ADR 0048) first, then the lives registry.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    assert.equal((await db.admin.query(`SELECT to_regclass('mira_lives') AS t`)).rows[0].t, null);
    await db.admin.query(`INSERT INTO mira_owners(mira_id) VALUES ('mira')`);
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'up' });
    const lives = new PostgresLives({ connectionString: db.connectionString, schema: db.schema });
    assert.deepEqual(await lives.active('mira'), { miraId: 'mira', generation: 0 });
    assert.deepEqual((await lives.list('mira')).map(life => [life.miraId, life.generation, life.active, life.resetId]), [['mira', 0, true, null]]);
    assert.deepEqual(await lives.active('other'), { miraId: 'other', generation: 0 }, 'unregistered slots are their own generation 0');
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'up' });
  } finally { await db.close(); }
});

test('a life switch is fenced, compare-and-set, and idempotent per reset ID', async () => {
  const db = await createTestDatabase();
  try {
    const lives = new PostgresLives({ connectionString: db.connectionString, schema: db.schema });
    const writer = await db.acquire('slot');
    await assert.rejects(lives.startNewLife({ slot: 'slot', from: 'slot', resetId: reset(1), archivePath: '/tmp/archive-1', reason: 'reset' }),
      (error: unknown) => error instanceof LifeRegistryError && error.code === 'ownership', 'a running writer blocks the switch');
    const epoch = writer.epoch; await writer.close();
    const first = await lives.startNewLife({ slot: 'slot', from: 'slot', resetId: reset(1), archivePath: '/tmp/archive-1', reason: 'reset' });
    assert.deepEqual(first, { from: 'slot', to: 'slot~g1', generation: 1, created: true, cancelledDeliveries: 0 });
    assert.ok(BigInt((await db.admin.query(`SELECT epoch FROM mira_owners WHERE mira_id = 'slot'`)).rows[0].epoch) > BigInt(epoch), 'the old life is fenced by epoch');
    assert.deepEqual(await lives.startNewLife({ slot: 'slot', from: 'slot', resetId: reset(1), archivePath: '/tmp/archive-1', reason: 'reset' }),
      { from: 'slot', to: 'slot~g1', generation: 1, created: false, cancelledDeliveries: 0 }, 'replaying the same reset is a receipt');
    await assert.rejects(lives.startNewLife({ slot: 'slot', from: 'slot', resetId: reset(2), archivePath: '/tmp/archive-2', reason: 'reset' }),
      (error: unknown) => error instanceof LifeRegistryError && error.code === 'conflict', 'a stale preflight cannot switch again');
    const next = await db.acquire('slot~g1'); await next.close();
    assert.deepEqual(await lives.active('slot'), { miraId: 'slot~g1', generation: 1 });
    assert.equal((await lives.byReset(reset(1)))?.miraId, 'slot~g1');
    await assert.rejects(lives.restoreLife({ slot: 'slot', target: 'slot~g1', archivePath: '/tmp/x' }), (error: unknown) => error instanceof LifeRegistryError && error.code === 'conflict');
    const restored = await lives.restoreLife({ slot: 'slot', target: 'slot', archivePath: '/tmp/archive-g1' });
    assert.deepEqual(restored, { from: 'slot~g1', to: 'slot', targetArchivePath: '/tmp/archive-1' });
    assert.deepEqual((await lives.list('slot')).map(life => [life.miraId, life.active, life.archivePath]), [['slot', true, null], ['slot~g1', false, '/tmp/archive-g1']]);
  } finally { await db.close(); }
});
