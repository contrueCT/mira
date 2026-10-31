import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { LocalWebService, createLocalHttp } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

async function settled(service: LocalWebService): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > deadline) throw Error('Service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const headers = { host: '127.0.0.1:4318', 'x-mira-client': 'web' };

test('real PG usage aggregates final requests per range, day, Wake and model; failures count without tokens; read-only', { timeout: 60_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-usage-service-'));
  let service: LocalWebService | undefined; let calls = 0;
  try {
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'usage',
      sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), miraHome: root,
      synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: async () => {
        calls++;
        if (calls === 3) return streamOf({ ...assistant(), stopReason: 'error' as const, errorMessage: 'synthetic failure', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
        return streamOf(assistant(`Reply ${calls}`));
      } });
    await settled(service);
    const empty = await service.usage('7d', 'UTC');
    assert.deepEqual(empty.totals, { requests: 0, failedRequests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 });
    assert.equal(empty.days.length, 7); assert.deepEqual(empty.topWakes, []); assert.deepEqual(empty.byModel, []);
    await service.submit({ id: 'u-1', text: 'first question about usage', occurredAt: new Date().toISOString() }); await settled(service);
    await service.submit({ id: 'u-2', text: 'second question', occurredAt: new Date().toISOString() }); await settled(service);
    await service.submit({ id: 'u-3', text: 'this one fails', occurredAt: new Date().toISOString() }); await settled(service);
    const before = (await db.admin.query('SELECT count(*)::int AS n FROM history_records')).rows[0].n;
    const today = await service.usage('today', 'Asia/Shanghai');
    // Fixture usage: input 10, output 2, cacheRead 3 per successful request.
    assert.deepEqual(today.totals, { requests: 3, failedRequests: 1, input: 20, output: 4, cacheRead: 6, cacheWrite: 0, total: 30 });
    assert.equal(today.timeZone, 'Asia/Shanghai'); assert.equal(today.days.length, 7);
    assert.deepEqual(today.days.at(-1)!.total + today.days.slice(0, -1).reduce((sum, day) => sum + day.total, 0), 30);
    assert.deepEqual(today.bySource.map(item => [item.source, item.requests, item.total]), [['main', 3, 30], ['subagent', 0, 0], ['compaction', 0, 0], ['dreaming', 0, 0]]);
    assert.equal(today.topWakes.length, 3);
    assert.deepEqual(today.topWakes.map(wake => wake.total), [15, 15, 0]);
    assert.deepEqual(today.topWakes.map(wake => wake.trigger), [{ source: 'user', type: 'web.message' }, { source: 'user', type: 'web.message' }, { source: 'user', type: 'web.message' }]);
    assert.ok(today.topWakes.some(wake => wake.preview === 'first question about usage'));
    assert.deepEqual(today.byModel.map(item => [item.provider, item.model, item.requests, item.failedRequests]), [['offline', 'offline', 3, 1]]);
    const month = await service.usage('30d', 'America/Los_Angeles');
    assert.equal(month.days.length, 30); assert.equal(month.totals.total, 30); assert.equal(month.previous.total, 0);
    assert.ok(Date.parse(month.since) < Date.parse(today.since) || month.timeZone !== today.timeZone);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM history_records')).rows[0].n, before, 'usage reads never write');
    const app = createLocalHttp({ backend: service, port: 4318 });
    try {
      const response = await app.inject({ url: '/api/usage?range=7d&tz=UTC', headers });
      assert.equal(response.statusCode, 200); assert.equal(response.json().totals.total, 30);
      assert.doesNotMatch(response.body, /cost/i);
      assert.deepEqual(Object.keys(response.json()).sort(), ['byModel', 'bySource', 'days', 'generatedAt', 'previous', 'range', 'since', 'timeZone', 'topWakes', 'totals']);
      for (const url of ['/api/usage?range=year&tz=UTC', '/api/usage?range=7d&tz=Not%2FA_Zone', '/api/usage?range=7d', '/api/usage?range=7d&tz=UTC&extra=1', "/api/usage?range=7d&tz=UTC'%3B--"])
        assert.equal((await app.inject({ url, headers })).statusCode, 400, url);
      assert.equal((await app.inject({ method: 'POST', url: '/api/usage?range=7d&tz=UTC', headers })).statusCode, 405);
    } finally { await app.close(); }
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
