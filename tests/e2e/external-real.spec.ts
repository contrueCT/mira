import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { createMiraClient, type ExternalEvent, type MiraCredentials } from '@mira/external-sdk';
import type { LifeEvent } from '@mira/life';
import { createLocalHttp, ExternalAccessStore, LocalWebService, type ExternalAccessStatus } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3212;
const origin = `http://127.0.0.1:${port}`;
const senderId = 'synthetic-build-watcher';
const miraId = 'external-real-browser';
const occurredAt = '2026-10-13T01:02:00.000Z';
const namespace = (id: string) => JSON.stringify(['external', senderId, id]);
const noticeNamespace = (id: string) => JSON.stringify(['external-notification', senderId, id]);
type Database = Awaited<ReturnType<typeof createTestDatabase>>;

async function settled(service: LocalWebService): Promise<void> {
  await expect.poll(async () => (await service.status()).state).toBe('idle');
}
async function events(db: Database) {
  return (await db.admin.query<{ event_id: string; event: LifeEvent; history_id: string; requested_wake: unknown }>(
    'SELECT event_id, event, history_id, requested_wake FROM life_events ORDER BY event_id')).rows;
}
async function durableState(db: Database) {
  const state: Record<string, unknown[]> = {};
  for (const [table, order] of [
    ['mira_owners', 'mira_id'], ['life_events', 'event_id'], ['history_records', 'id'],
    ['wake_requests', 'receipt_order'], ['wake_runs', 'run_id'], ['wake_run_requests', 'wake_id'],
    ['context_records', 'version'], ['tool_executions', 'call_id'],
  ]) state[table!] = (await db.admin.query(`SELECT * FROM ${table} ORDER BY ${order}`)).rows;
  return state;
}
function sourceEvent(event: ExternalEvent): LifeEvent {
  return { id: namespace(event.id), type: event.type, source: 'external', occurredAt: event.occurredAt,
    payload: { senderId, operation: 'event', eventId: event.id, data: event.payload } };
}
async function visibleNotice(page: Page, historyId: string, text: string): Promise<void> {
  const notice = page.getByRole('article', { name: '服务通知', exact: true });
  await expect(notice).toHaveCount(1);
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('data-message-id', historyId);
  await expect(notice.locator('.message-bubble')).toHaveText(`外部程序 ${senderId}\n${text}`);
  await expect(notice.locator('time')).toHaveAttribute('datetime', occurredAt);
  await expect(notice.locator('time')).toHaveText('01:02');
  await expect(notice.locator('img, script')).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window, 'externalNoticeExecuted'))).toBe(false);
}

test('real CLI → SDK → HTTP → PostgreSQL → continuous runtime → browser, with live rotation and revoke', async ({ page }, testInfo) => {
  // No HTTP fulfillment, authentication stub or in-memory writer. Only the
  // provider response is synthetic; the complete application path is real.
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-external-real-'));
  const home = path.join(root, 'home');
  let database: Database | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  const contexts: TranscriptContext[] = [];
  const browserErrors: string[] = [];
  const browserOrigins = new Set<string>();
  page.on('pageerror', error => browserErrors.push(error.message));
  page.on('request', request => browserOrigins.add(new URL(request.url()).origin));
  const execute = promisify(execFile);
  const command = async (operation: string, id?: string): Promise<ExternalAccessStatus> => {
    const { stdout, stderr } = await execute(process.execPath, [
      path.join(sourceDirectory, 'apps/server/src/external-access-cli.mts'), operation, '--home', home,
      ...(id === undefined ? [] : ['--id', id]),
    ], { timeout: 10_000, env: {
      PATH: process.env['PATH'], HOME: root, TMPDIR: root, TMP: root, TEMP: root, XDG_CACHE_HOME: root,
    } });
    expect(stderr).toBe(''); expect(stdout.includes('"token"')).toBe(false);
    return JSON.parse(stdout) as ExternalAccessStatus;
  };
  try {
    const db = await createTestDatabase(); database = db;
    const opened = await LocalWebService.open({
      connectionString: db.connectionString, schema: db.schema, miraId, sourceDirectory,
      workingDirectory: root, miraHome: home, spoolDirectory: path.join(root, 'spool'),
      settingsFile: path.join(home, 'models.json'), synthetic: true,
      syntheticStream: (_model, context) => {
        contexts.push(structuredClone(context));
        return streamOf({ ...assistant(`真实链路合成回复 ${contexts.length}`), timestamp: Date.now() });
      },
    }); service = opened;
    await settled(opened);
    const access = new ExternalAccessStore({ miraHome: home, sourceDirectory });
    const http = createLocalHttp({ backend: opened, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist'),
      external: { access, ingress: opened.external } }); app = http;
    await http.listen({ port, host: '127.0.0.1' });

    expect((await command('status')).enabled).toBe(false);
    const created = await command('create', senderId);
    expect(created.enabled).toBe(false); expect(created.sender?.state).toBe('active');
    const credentialFile = created.sender!.credentialFile;
    let loads = 0;
    const load = async (): Promise<MiraCredentials> => {
      loads++;
      const credential = JSON.parse(await readFile(credentialFile, 'utf8')) as { id: string; token: string | null };
      if (credential.id !== senderId || typeof credential.token !== 'string') throw Error('Disposable credential unavailable');
      return { senderId: credential.id, token: credential.token };
    };
    // Credentials enter the SDK only through a runtime file loader, never the
    // browser, command line, provider context or persisted event payload.
    const client = createMiraClient({ baseUrl: origin, credentials: load });
    const originalCredential = await load();
    const staleClient = createMiraClient({ baseUrl: origin, credentials: () => originalCredential });
    const fact: ExternalEvent = { id: 'build-7-fact', type: 'fixture.build', occurredAt,
      payload: { recordId: 'build-7', text: 'SILENT_SOURCE_FACT', details: { count: 2, labels: ['synthetic'] } } };
    await expect(client.emitEvent(fact)).rejects.toMatchObject({ code: 'http_error', outcome: 'rejected', status: 401 });
    expect(await events(db)).toEqual([]);
    expect((await command('enable')).enabled).toBe(true);

    await page.goto(origin);
    await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeEditable();
    const notification = { id: 'build-7-notice', occurredAt,
      text: '构建已完成 <img src=x onerror="window.externalNoticeExecuted=true"> <script>window.externalNoticeExecuted=true</script>' };
    expect(await client.emitEvent(fact)).toEqual({ operation: 'event', id: fact.id, receipt: 'inserted', durability: 'persisted' });
    expect(await client.sendNotification(notification)).toEqual({ operation: 'notification', id: notification.id, receipt: 'inserted', durability: 'persisted' });
    await settled(opened);
    const silent = await events(db);
    expect(silent).toHaveLength(2);
    const savedFact = silent.find(row => row.event_id === namespace(fact.id))!;
    const savedNotice = silent.find(row => row.event_id === noticeNamespace(notification.id))!;
    expect(savedFact.event).toEqual(sourceEvent(fact)); expect(savedFact.requested_wake).toBeNull();
    expect(savedNotice.event).toEqual({ id: noticeNamespace(notification.id), type: 'external.notification', source: 'external', occurredAt,
      payload: { senderId, operation: 'notification', notificationId: notification.id, text: notification.text } });
    expect(savedNotice.requested_wake).toBeNull();
    for (const saved of silent) {
      expect(saved.history_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      const history = await db.store.history(miraId).read({ id: saved.history_id });
      expect(history?.kind).toBe('event');
      if (history?.kind !== 'event') throw Error('Expected durable external History event');
      expect(history.event).toEqual(saved.event);
    }
    expect(new Set(silent.map(row => row.history_id)).size).toBe(2);
    const silentState = await durableState(db);
    for (const table of ['wake_requests', 'wake_runs', 'wake_run_requests', 'context_records', 'tool_executions']) expect(silentState[table]).toEqual([]);
    expect(contexts).toHaveLength(0);
    await visibleNotice(page, savedNotice.history_id, notification.text);
    await expect(page.getByRole('article', { name: 'Mira 的消息', exact: true })).toHaveCount(0);
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toHaveCount(0);
    await expect(page.getByText('SILENT_SOURCE_FACT', { exact: false })).toHaveCount(0);
    expect((await client.emitEvent(fact)).receipt).toBe('duplicate');
    expect((await client.sendNotification(notification)).receipt).toBe('duplicate');
    await page.reload(); await visibleNotice(page, savedNotice.history_id, notification.text);
    await settled(opened); expect(contexts).toHaveLength(0);
    expect(await durableState(db)).toEqual(silentState);

    const originalUserText = '请记住这条浏览器输入，继续同一个 Mira。';
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill(originalUserText);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByRole('article', { name: 'Mira 的消息', exact: true }).getByText('真实链路合成回复 1', { exact: true })).toBeVisible();
    await settled(opened); expect(contexts).toHaveLength(1);
    const beforeWake = await durableState(db);
    const wake = { id: 'build-8-attention', reason: 'Synthetic build attention rule matched', event: {
      id: 'build-8-result', type: 'web.message', occurredAt,
      payload: { text: 'EXTERNAL_WAKE_FACT', source: 'user', senderId: 'forged-owner', result: { failed: 2 } },
    } };
    expect(await client.requestWake(wake)).toEqual({ operation: 'wake', id: wake.id, eventId: wake.event.id, receipt: 'inserted', durability: 'persisted' });
    await expect(page.getByRole('article', { name: 'Mira 的消息', exact: true }).getByText('真实链路合成回复 2', { exact: true })).toBeVisible();
    await settled(opened); expect(contexts).toHaveLength(2);
    const savedWake = (await events(db)).find(row => row.event_id === namespace(wake.event.id))!;
    expect(savedWake.event).toEqual(sourceEvent(wake.event));
    expect(savedWake.requested_wake).toEqual({ id: namespace(wake.id), reason: wake.reason });
    const firstInputs = contexts[0]!.messages.filter(message => message.role === 'user');
    const continuedInputs = contexts[1]!.messages.filter(message => message.role === 'user');
    expect(firstInputs).toHaveLength(1); expect(JSON.stringify(firstInputs[0])).toContain(originalUserText);
    expect(continuedInputs).toHaveLength(2); expect(continuedInputs[0]).toEqual(firstInputs[0]);
    const externalInput = JSON.stringify(continuedInputs[1]);
    for (const value of ['[external |', savedWake.history_id, senderId, wake.reason, 'EXTERNAL_WAKE_FACT', 'forged-owner']) expect(externalInput).toContain(value);
    expect(JSON.stringify(contexts[1]!.messages)).toContain('真实链路合成回复 1');
    expect(JSON.stringify(contexts)).not.toContain('SILENT_SOURCE_FACT');
    expect(JSON.stringify(contexts)).not.toContain(notification.text);
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toHaveCount(1);
    await expect(page.getByRole('article', { name: 'Mira 的消息', exact: true })).toHaveCount(2);
    await expect(page.getByText('EXTERNAL_WAKE_FACT', { exact: false })).toHaveCount(0);
    const completed = await durableState(db);
    expect(completed['life_events']).toHaveLength(4); expect(completed['wake_requests']).toHaveLength(2);
    expect(completed['wake_run_requests']).toHaveLength(2); expect(completed['wake_runs']).toHaveLength(2);
    expect(completed['tool_executions']).toEqual([]);
    for (const run of completed['wake_runs'] as Array<{ mira_id: string; completed: boolean; input_record_id: string; final_record_id: string }>) {
      expect(run.mira_id).toBe(miraId); expect(run.completed).toBe(true);
      expect(run.input_record_id).toBeTruthy(); expect(run.final_record_id).toBeTruthy();
    }
    const owner = completed['mira_owners'] as Array<{ mira_id: string; epoch: string }>;
    expect(owner).toHaveLength(1); expect(owner[0]?.mira_id).toBe(miraId); expect(owner[0]?.epoch).toBe('1');
    const previousRecords = beforeWake['context_records']!;
    expect(completed['context_records']!.slice(0, previousRecords.length)).toEqual(previousRecords);
    expect((await client.requestWake(wake)).receipt).toBe('duplicate');
    expect((await client.sendNotification(notification)).receipt).toBe('duplicate');
    await settled(opened); expect(contexts).toHaveLength(2); expect(await durableState(db)).toEqual(completed);

    expect((await command('rotate', senderId)).sender?.state).toBe('active');
    await expect(staleClient.requestWake({ ...wake, id: 'stale-wake', event: { ...wake.event, id: 'stale-event' } }))
      .rejects.toMatchObject({ code: 'http_error', outcome: 'rejected', status: 401 });
    const rotatedCredential = await load(); expect(originalCredential.token !== rotatedCredential.token).toBe(true);
    const beforeReload = loads;
    expect((await client.requestWake(wake)).receipt).toBe('duplicate'); expect(loads).toBe(beforeReload + 1);
    const cachedRotated = createMiraClient({ baseUrl: origin, credentials: () => rotatedCredential });
    expect((await command('revoke', senderId)).sender?.state).toBe('revoked');
    await expect(cachedRotated.requestWake({ ...wake, id: 'revoked-wake', event: { ...wake.event, id: 'revoked-event' } }))
      .rejects.toMatchObject({ code: 'http_error', outcome: 'rejected', status: 401 });
    await expect(client.requestWake(wake)).rejects.toMatchObject({ code: 'credentials_unavailable', outcome: 'not_sent' });
    await settled(opened); expect(contexts).toHaveLength(2); expect(await durableState(db)).toEqual(completed);
    await page.reload(); await visibleNotice(page, savedNotice.history_id, notification.text);
    await expect(page.getByRole('article', { name: 'Mira 的消息', exact: true })).toHaveCount(2);
    await expect(page.getByRole('article', { name: '你的消息', exact: true }).getByText(originalUserText, { exact: true })).toBeVisible();
    for (const secret of [originalCredential.token, rotatedCredential.token]) {
      expect(JSON.stringify(completed).includes(secret)).toBe(false);
      expect(JSON.stringify(contexts).includes(secret)).toBe(false);
      expect((await page.content()).includes(secret)).toBe(false);
    }
    await page.screenshot({ path: testInfo.outputPath('external-real-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await visibleNotice(page, savedNotice.history_id, notification.text);
    await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('external-real-narrow.png'), fullPage: true });
    await settled(opened); expect(contexts).toHaveLength(2); expect(await durableState(db)).toEqual(completed);
    expect(browserErrors).toEqual([]); expect([...browserOrigins]).toEqual([origin]);
  } finally {
    try { await app?.close(); } finally {
      try { await service?.close(); } finally {
        try { await database?.close(); } finally { await rm(root, { recursive: true, force: true }); }
      }
    }
  }
});
