import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { createTestDatabase, testHistoryId } from '../integration/database.mts';

const port = 3221, origin = `http://127.0.0.1:${port}`;

async function seededService(db: Awaited<ReturnType<typeof createTestDatabase>>, root: string, miraId: string, shown: boolean[], listenPort: number) {
  const writer = await db.acquire(miraId); await writer.close();
  const entries = shown.map((visible, i) => ({ id: testHistoryId(`${miraId}-${i}`), event: { id: `seed-${i}`, source: visible ? 'user' : 'external', type: visible ? 'web.message' : 'synthetic.internal',
    occurredAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), payload: { text: visible ? `合成历史消息 ${i}，周末沿湖散步的安排。` : 'PRIVATE_HIDDEN_EVENT' } } }));
  await db.admin.query(`WITH input AS (SELECT * FROM json_to_recordset($1::json) AS x(id uuid, event json)),
    reserved AS (INSERT INTO history_records(id, mira_id, kind) SELECT id, $2, 'event' FROM input)
    INSERT INTO life_events(mira_id, history_id, event_id, event) SELECT $2, id, event->>'id', event FROM input`, [JSON.stringify(entries), miraId]);
  const service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory: process.cwd(), workingDirectory: root,
    miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, dreaming: { enabled: false } });
  const app = createLocalHttp({ backend: service, port: listenPort, assetsDirectory: path.join(process.cwd(), 'apps/web/dist') });
  await app.listen({ port: listenPort, host: '127.0.0.1' });
  return { service, app, ids: entries.map(entry => entry.id), origin: `http://127.0.0.1:${listenPort}` };
}

test('real PG: a newest window of private records loads older chat instead of the empty state', async ({ page }, testInfo) => {
  const db = await createTestDatabase(), root = await realpath(await mkdtemp('/tmp/mira-pagination-'));
  let fixture: Awaited<ReturnType<typeof seededService>> | undefined;
  try {
    // 60 visible messages, then 400 newer private records: more than the 300-record latest window.
    fixture = await seededService(db, root, 'hidden-newest', [...Array.from({ length: 60 }, () => true), ...Array.from({ length: 400 }, () => false)], port + 1);
    await page.goto(fixture.origin);
    await expect(page.locator('[data-message-id]')).toHaveCount(60);
    await expect(page.getByText('和 Mira 说点什么')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('hidden-newest.png') });
  } finally {
    await fixture?.app.close(); await fixture?.service.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});

test('real PG and HTTP history loads enough visible messages across hidden pages', async ({ page }, testInfo) => {
  const db = await createTestDatabase(), root = await realpath(await mkdtemp('/tmp/mira-pagination-'));
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  const errors: string[] = [], responses: { method: string; count: number; ms: number }[] = [];
  const requests = new Map<object, number>();
  let connections = 0;
  const connect = Client.prototype.connect;
  // Instrument the real driver; every connection/query still reaches PostgreSQL.
  Client.prototype.connect = function (this: Client, ...args: Parameters<typeof connect>) { connections++; return Reflect.apply(connect, this, args); } as typeof connect;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/timeline') requests.set(request, performance.now()); });
  page.on('response', async response => {
    const start = requests.get(response.request());
    if (start !== undefined && response.ok()) responses.push({ method: response.request().method(), count: (await response.json()).items.length, ms: performance.now() - start });
  });
  try {
    const writer = await db.acquire('pagination'); await writer.close();
    const entries = Array.from({ length: 2850 }, (_, i) => {
      const shown = i >= 2800 || (i < 2500 && i % 25 === 0);
      return { id: testHistoryId(`pagination-${i}`), event: { id: `seed-${i}`, source: shown ? 'user' : 'external', type: shown ? 'web.message' : 'synthetic.internal',
        occurredAt: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), payload: { text: shown ? `合成历史消息 ${i}，周末沿湖散步的安排。` : 'PRIVATE_HIDDEN_EVENT' } } };
    });
    await db.admin.query(`WITH input AS (SELECT * FROM json_to_recordset($1::json) AS x(id uuid, event json)),
      reserved AS (INSERT INTO history_records(id, mira_id, kind) SELECT id, 'pagination', 'event' FROM input)
      INSERT INTO life_events(mira_id, history_id, event_id, event) SELECT 'pagination', id, event->>'id', event FROM input`, [JSON.stringify(entries)]);
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'pagination', sourceDirectory: process.cwd(), workingDirectory: root,
      miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, dreaming: { enabled: false } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(process.cwd(), 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.goto(origin);
    await expect(page.locator('[data-message-id]')).toHaveCount(50);
    await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = 0; });
    const initialConnections = connections, initialResponses = responses.length;
    const start = performance.now();
    const button = page.locator('.history-controls button');
    await button.click();
    await expect.poll(() => page.locator('[data-message-id]').count()).toBeGreaterThanOrEqual(100);
    await expect(button).toBeEnabled();
    const result = { totalMs: performance.now() - start, initialConnections, historyConnections: connections - initialConnections, responses };
    console.log(JSON.stringify(result));
    await writeFile(testInfo.outputPath('metrics.json'), JSON.stringify(result, null, 2));
    expect(responses.filter(response => response.method === 'POST')).toHaveLength(1);
    // Each timeline response, including any overlapping latest poll, reads one snapshot.
    expect(result.historyConnections).toBeLessThanOrEqual(responses.length - initialResponses + 1);
    await page.screenshot({ path: testInfo.outputPath('history-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('history-narrow.png'), fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    Client.prototype.connect = connect;
    await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});

test('real PG: a far quoted message is found in one lookup, focused, and the skipped stretch stays readable', async ({ page }, testInfo) => {
  const db = await createTestDatabase(), root = await realpath(await mkdtemp('/tmp/mira-pagination-'));
  let fixture: Awaited<ReturnType<typeof seededService>> | undefined;
  try {
    fixture = await seededService(db, root, 'far-quote', Array.from({ length: 1_500 }, () => true), port + 2);
    // A newest user message quoting the fourth-oldest one, through the ordinary service API.
    await fixture.service.submit({ id: 'far-quote-reply', text: '回复很早以前的那条', occurredAt: new Date(Date.UTC(2026, 9, 3)).toISOString(), replyToMessageId: fixture.ids[3]! });
    const locates: number[] = []; let olderPosts = 0;
    page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname === '/api/timeline/locate') locates.push(performance.now()); else if (pathname === '/api/timeline' && request.method() === 'POST') olderPosts++; });
    await page.goto(fixture.origin);
    const quote = page.getByRole('button', { name: '查看引用的消息' });
    await expect(quote).toBeVisible();
    const start = performance.now();
    await quote.click();
    await expect(page.locator(`[data-message-id="${fixture.ids[3]}"]`)).toBeFocused();
    const ms = performance.now() - start;
    console.log(JSON.stringify({ farQuoteMs: Math.round(ms), locates: locates.length, olderPosts }));
    await writeFile(testInfo.outputPath('far-quote.json'), JSON.stringify({ farQuoteMs: ms, locates: locates.length, olderPosts }, null, 2));
    expect(locates).toHaveLength(1); expect(olderPosts).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('far-quote.png') });
    // The unread messages between the located window and the newest page remain reachable.
    const fill = page.getByRole('button', { name: '补齐尚未读取的消息' });
    for (let clicks = 0; clicks < 40 && await fill.count(); clicks++) { await fill.click(); await expect(fill).not.toHaveText('正在读取…').catch(() => {}); }
    await expect(fill).toHaveCount(0);
    const shown = await page.locator('[data-message-id]').evaluateAll(elements => elements.map(element => element.getAttribute('data-message-id')));
    expect(new Set(shown).size).toBe(shown.length);
    // Every seeded message plus the reply (and any synthetic answer to it) is shown exactly once.
    expect(fixture.ids.filter(id => !shown.includes(id))).toEqual([]);
    expect(shown.length).toBeGreaterThan(fixture.ids.length);
  } finally {
    await fixture?.app.close(); await fixture?.service.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});
