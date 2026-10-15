import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { readExtensionConfiguration } from '@mira/extension-host';
import type { FeishuSdkDependencies, FeishuWsOptions, FeishuWsTransport, FeishuHttpInstance } from '../../packages/feishu-channel/src/sdk.ts';
import { FEISHU_REQUIRED_SCOPES } from '../../packages/feishu-channel/src/sdk.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = path.resolve(import.meta.dirname, '../..');
const port = 3219, origin = `http://127.0.0.1:${port}`;
const fakeSecret = 'synthetic-feishu-secret-never-real';
// Production browser/HTTP/settings/Host/PG/Wake/runtime/outbound tool; only model
// responses and official SDK HTTP/WS transport are synthetic, with no real account.
test('Feishu generic settings QR and explicit pairing reach the same durable Mira and explicit outbound tool', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  let wsOptions!: FeishuWsOptions;
  let dispatcher: Parameters<FeishuWsTransport['start']>[0]['eventDispatcher'];
  let closed = false, requests = 0;
  const effectful: Array<{ text: string; uuid: string }> = [];
  let completeRegistration!: (value: { client_id: string; client_secret: string; user_info: { tenant_brand: 'feishu' } }) => void;
  type Request = { url?: string; data?: unknown };
  const response = async (request: Request) => {
    if (request.url?.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 };
    if (request.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'ou_bot' } };
    if (request.url?.endsWith('/application/v6/scopes')) return { code: 0, data: { scopes: FEISHU_REQUIRED_SCOPES.map(scope_name => ({ scope_name, grant_status: 1, scope_type: 'tenant' })) } };
    if (request.url?.includes('/im/v1/messages')) { const data = request.data as { content: string; uuid: string }; effectful.push({ text: JSON.parse(data.content).text, uuid: data.uuid }); return { code: 0, data: { message_id: `om_sent_${effectful.length}` } }; }
    throw Error('Unexpected synthetic SDK request');
  };
  const http = { request: response, post: (url: string, data: unknown) => response({ url, data }), get: (url: string) => response({ url }), put: () => { throw Error(); }, patch: () => { throw Error(); }, delete: () => { throw Error(); }, head: () => { throw Error(); }, options: () => { throw Error(); } } as FeishuHttpInstance;
  const dependencies: FeishuSdkDependencies = { httpInstance: http,
    registerApp: async options => { expect(options.addons?.scopes?.tenant).toEqual([...FEISHU_REQUIRED_SCOPES]); options.onQRCodeReady({ url: 'https://accounts.feishu.cn/synthetic-consent', expireIn: 600 }); return new Promise(resolve => { completeRegistration = resolve; }); },
    createWebSocket: options => { wsOptions = options; closed = false; return { async start(input) { dispatcher = input.eventDispatcher; queueMicrotask(() => wsOptions.onReady?.()); }, close() { closed = true; }, getConnectionStatus() { return { state: closed ? 'idle' : 'connected', reconnectAttempts: 0 }; } }; },
  };
  const registry = globalThis as typeof globalThis & { miraFeishuSynthetic?: FeishuSdkDependencies }; registry.miraFeishuSynthetic = dependencies;
  const deliver = async (id: string, text: string) => {
    expect(dispatcher).toBeTruthy();
    await dispatcher!.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: 'user', sender_id: { open_id: 'ou_owner' }, tenant_key: 'tenant_fixture' }, message: { message_id: id, chat_id: 'oc_owner', chat_type: 'p2p', create_time: '1792065600000', message_type: 'text', content: JSON.stringify({ text }) } } }, { needCheck: false });
  };
  try {
    db = await createTestDatabase();
    const entry = path.join(root, 'feishu-fixture.mjs');
    await writeFile(entry, `import { createFeishuExtension } from ${JSON.stringify(pathToFileURL(path.join(sourceDirectory, 'packages/feishu-channel/src/index.ts')).href)};\nimport { createFeishuSdk } from ${JSON.stringify(pathToFileURL(path.join(sourceDirectory, 'packages/feishu-channel/src/sdk.ts')).href)};\nexport default createFeishuExtension(createFeishuSdk(globalThis.miraFeishuSynthetic));\n`);
    const ordinary = path.join(root, 'ordinary-fixture.mjs');
    await writeFile(ordinary, `export default { name: 'ordinary-display', async apply({mira}) { await mira.emitEvent({ id: 'sample-in', type: 'ordinary.message', occurredAt: '2026-10-15T01:00:00Z', payload: { sensor: 'sample' }, message: { direction: 'inbound', text: '（合成测试）普通插件消息同样显示小号来源标记。', sourceLabel: '普通插件', senderId: 'sample-sender', senderVerified: false } }); } };`);
    const configuration = path.join(root, 'extensions.json'); await writeFile(configuration, JSON.stringify({ entries: [{ id: 'feishu', path: entry, config: { domain: 'feishu' } }, { id: 'ordinary', path: ordinary, config: {} }] }));
    const common = { connectionString: db.connectionString, schema: db.schema, miraId: 'feishu-real', sourceDirectory, workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
    service = await LocalWebService.open({ ...common, extensions: await readExtensionConfiguration(configuration), syntheticStream: (_model, context) => {
      requests++; expect(JSON.stringify(context)).not.toContain(fakeSecret); expect(JSON.stringify(context)).not.toContain('synthetic-consent');
      if (requests === 1) { expect(JSON.stringify(context)).toContain('（合成测试）请连接飞书。'); return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'feishu-connect', name: 'feishu_connect', arguments: {} }] }); }
      if (requests === 2) return streamOf(assistant('已发起飞书连接，请打开设置 → 扩展查看授权二维码。此处为合成测试。'));
      if (requests === 3) { expect(JSON.stringify(context)).toContain('（合成测试）请告诉我今天的任务进度。'); return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'feishu-explicit-send', name: 'feishu_send_message', arguments: { text: '（合成测试）已收到你的飞书消息，任务进度会在这里同步。', replyToMessageId: 'om_user' } }] }); }
      return streamOf(assistant('已通过飞书发送回复。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') }); await app.listen({ host: '127.0.0.1', port });
    await page.goto(origin); await expect(page.getByText('（合成测试）普通插件消息同样显示小号来源标记。', { exact: true })).toBeVisible();
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('（合成测试）请连接飞书。'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('已发起飞书连接，请打开设置 → 扩展查看授权二维码。此处为合成测试。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('tab', { name: '扩展', exact: true }).click();
    const panel = page.getByRole('region', { name: 'feishu 连接设置' });
    await expect(panel).toContainText('操作仍在进行'); expect(requests).toBe(2);
    await expect(panel.getByRole('img', { name: '授权二维码' })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('feishu-authorization-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('feishu-authorization-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    completeRegistration({ client_id: 'cli_fixture', client_secret: fakeSecret, user_info: { tenant_brand: 'feishu' } });
    await expect(panel).toContainText('操作已完成'); await expect(panel).toContainText('cli_fixture');
    expect(await page.content()).not.toContain(fakeSecret); expect(await readFile(configuration, 'utf8')).not.toContain(fakeSecret);
    await panel.getByRole('button', { name: '生成本人配对码', exact: true }).click();
    await expect(panel).toContainText('/mira pair ');
    const challenge = (await panel.innerText()).match(/\/mira pair [A-Za-z0-9_-]+/)?.[0]; expect(challenge).toBeTruthy();
    await deliver('om_pair', challenge!); await expect(panel).toContainText('ou_owner'); expect(requests).toBe(2);
    await page.screenshot({ path: testInfo.outputPath('feishu-pairing-desktop.png'), fullPage: true, mask: [panel.getByText(challenge!, { exact: true })] });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('feishu-pairing-narrow.png'), fullPage: true, mask: [panel.getByText(challenge!, { exact: true })] });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.getByRole('button', { name: '确认这是本人并发送测试消息', exact: true }).click(); await expect(panel).toContainText('已连接');
    expect(effectful).toHaveLength(1); await deliver('om_user', '（合成测试）请告诉我今天的任务进度。');
    await expect.poll(() => effectful.some(item => item.text === '（合成测试）已收到你的飞书消息，任务进度会在这里同步。')).toBe(true);
    await expect.poll(async () => (await service!.status()).state).toBe('idle'); expect(requests).toBe(4);
    await deliver('om_user', '（合成测试）请告诉我今天的任务进度。'); await new Promise(resolve => setTimeout(resolve, 50)); expect(effectful).toHaveLength(2);
    expect((await db.admin.query("SELECT count(*)::integer AS count FROM life_events WHERE event->>'type'='feishu.owner_message'")).rows[0].count).toBe(1);
    await expect(panel).not.toContainText('/mira pair ');
    await page.screenshot({ path: testInfo.outputPath('feishu-settings-connected-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('feishu-settings-connected-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press('Escape');
    await expect(page.getByText('（合成测试）请告诉我今天的任务进度。', { exact: true })).toBeVisible();
    await expect(page.getByText('（合成测试）已收到你的飞书消息，任务进度会在这里同步。', { exact: true })).toBeVisible();
    await expect(page.locator('.message-source').filter({ hasText: '普通插件 · ordinary' })).toHaveCount(1);
    await expect(page.locator('.message-source').filter({ hasText: '飞书 · feishu · 收到' })).toHaveCount(1);
    await expect(page.locator('.message-source').first()).toHaveCSS('font-size', '10px');
    await page.screenshot({ path: testInfo.outputPath('feishu-connected-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: testInfo.outputPath('feishu-connected-narrow.png'), fullPage: true });
    const durableCounts = (await db.admin.query('SELECT (SELECT count(*) FROM wake_requests)::integer AS wakes, (SELECT count(*) FROM wake_runs)::integer AS runs')).rows[0];
    await app.close(); app = undefined; await service.close(); service = undefined; expect(closed).toBe(true);
    service = await LocalWebService.open({ ...common, extensions: await readExtensionConfiguration(configuration) });
    await deliver('om_user', '（合成测试）请告诉我今天的任务进度。'); expect(effectful).toHaveLength(2);
    expect((await db.admin.query('SELECT (SELECT count(*) FROM wake_requests)::integer AS wakes, (SELECT count(*) FROM wake_runs)::integer AS runs')).rows[0]).toEqual(durableCounts);
    expect((await db.admin.query("SELECT count(*)::integer AS count FROM life_events WHERE event->>'type'='feishu.owner_message'")).rows[0].count).toBe(1);
  } finally { delete registry.miraFeishuSynthetic; await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});
