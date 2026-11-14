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
test('Feishu generic settings QR and multi-person private messaging reach the same durable Mira and explicit outbound tool', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  let wsOptions!: FeishuWsOptions;
  let dispatcher: Parameters<FeishuWsTransport['start']>[0]['eventDispatcher'];
  let closed = false, requests = 0;
  const effectful: Array<{ text: string; uuid: string; path?: string }> = [];
  let completeRegistration!: (value: { client_id: string; client_secret: string; user_info: { tenant_brand: 'feishu' } }) => void;
  type Request = { url?: string; data?: unknown };
  const response = async (request: Request) => {
    if (request.url?.includes('tenant_access_token')) return { code: 0, tenant_access_token: 'synthetic-token', expire: 7200 };
    if (request.url?.endsWith('/bot/v3/info')) return { code: 0, bot: { open_id: 'ou_bot' } };
    if (request.url?.endsWith('/application/v6/scopes')) return { code: 0, data: { scopes: FEISHU_REQUIRED_SCOPES.map(scope_name => ({ scope_name, grant_status: 1, scope_type: 'tenant' })) } };
    if (request.url?.includes('/contact/v3/users/')) { const id = request.url.split('/').at(-1)!; return {code:0,data:{user:{name:id === 'ou_owner' ? '合成用户' : '另一位用户',open_id:id}}}; }
    if (request.url?.includes('/im/v1/messages')) { const data = request.data as { content: string; uuid: string }; effectful.push({ text: JSON.parse(data.content).text, uuid: data.uuid, path: request.url }); return { code: 0, data: { message_id: `om_sent_${effectful.length}` } }; }
    throw Error('Unexpected synthetic SDK request');
  };
  const http = { request: response, post: (url: string, data: unknown) => response({ url, data }), get: (url: string) => response({ url }), put: () => { throw Error(); }, patch: () => { throw Error(); }, delete: () => { throw Error(); }, head: () => { throw Error(); }, options: () => { throw Error(); } } as FeishuHttpInstance;
  const dependencies: FeishuSdkDependencies = { httpInstance: http,
    registerApp: async options => { expect(options.addons?.scopes?.tenant).toEqual([...FEISHU_REQUIRED_SCOPES]); options.onQRCodeReady({ url: 'https://accounts.feishu.cn/synthetic-consent', expireIn: 600 }); return new Promise(resolve => { completeRegistration = resolve; }); },
    createWebSocket: options => { wsOptions = options; closed = false; return { async start(input) { dispatcher = input.eventDispatcher; queueMicrotask(() => wsOptions.onReady?.()); }, close() { closed = true; }, getConnectionStatus() { return { state: closed ? 'idle' : 'connected', reconnectAttempts: 0 }; } }; },
  };
  const registry = globalThis as typeof globalThis & { miraFeishuSynthetic?: FeishuSdkDependencies }; registry.miraFeishuSynthetic = dependencies;
  const deliver = async (id: string, text: string, sender = 'ou_owner') => {
    expect(dispatcher).toBeTruthy();
    await dispatcher!.invoke({ schema: '2.0', header: { event_type: 'im.message.receive_v1' }, event: { sender: { sender_type: 'user', sender_id: { open_id: sender }, tenant_key: 'tenant_fixture' }, message: { message_id: id, chat_id: sender === 'ou_owner' ? 'oc_owner' : 'oc_other', chat_type: 'p2p', create_time: '1792065600000', message_type: 'text', content: JSON.stringify({ text }) } } }, { needCheck: false });
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
      if (requests === 5) { expect(JSON.stringify(context)).toContain('ou_other'); expect(JSON.stringify(context)).toContain('om_other'); expect(JSON.stringify(context)).toContain('另一位用户'); return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'feishu-other-send', name: 'feishu_send_message', arguments: { text: '（合成测试）回复另一位发言者。', replyToMessageId: 'om_other' } }] }); }
      return streamOf(assistant('已通过飞书发送回复。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') }); await app.listen({ host: '127.0.0.1', port });
    await page.goto(origin); await expect(page.getByText('（合成测试）普通插件消息同样显示小号来源标记。', { exact: true })).toBeVisible();
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('（合成测试）请连接飞书。'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('已发起飞书连接，请打开设置 → 扩展查看授权二维码。此处为合成测试。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('tab', { name: '扩展', exact: true }).click();
    await page.getByRole('article', { name: '扩展 feishu', exact: true }).getByRole('button', { name: '连接设置', exact: true }).click();
    const panel = page.getByRole('region', { name: 'feishu 连接设置' });
    await expect(panel).toContainText('操作仍在进行'); expect(requests).toBe(2);
    await expect(panel.getByRole('img', { name: '授权二维码' })).toBeVisible();
    const qr = panel.getByRole('img', { name: '授权二维码' });
    await qr.scrollIntoViewIfNeeded(); await expect(qr).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('feishu-authorization-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await qr.scrollIntoViewIfNeeded(); await expect(qr).toBeInViewport({ ratio: 1 }); await page.screenshot({ path: testInfo.outputPath('feishu-authorization-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    completeRegistration({ client_id: 'cli_fixture', client_secret: fakeSecret, user_info: { tenant_brand: 'feishu' } });
    await expect(panel).toContainText('操作已完成'); await expect(panel).toContainText('cli_fixture');
    expect(await page.content()).not.toContain(fakeSecret); expect(await readFile(configuration, 'utf8')).not.toContain(fakeSecret);
    await expect(panel).toContainText('已连接'); await expect(panel.getByRole('button', {name:'生成本人配对码'})).toHaveCount(0); expect(requests).toBe(2);
    await expect(panel.getByRole('button', { name: '重新连接', exact: true })).not.toBeVisible();
    await expect(panel.getByRole('button', { name: '扫码连接', exact: true })).toHaveCount(0);
    expect(effectful).toHaveLength(0); await deliver('om_user', '（合成测试）请告诉我今天的任务进度。');
    await expect.poll(() => effectful.some(item => item.text === '（合成测试）已收到你的飞书消息，任务进度会在这里同步。')).toBe(true);
    await expect.poll(async () => (await service!.status()).state).toBe('idle'); expect(requests).toBe(4);
    await deliver('om_user', '（合成测试）请告诉我今天的任务进度。'); await new Promise(resolve => setTimeout(resolve, 50)); expect(effectful).toHaveLength(1);
    expect((await db.admin.query("SELECT count(*)::integer AS count FROM life_events WHERE event->>'type'='feishu.message'")).rows[0].count).toBe(1);
    await expect(panel).not.toContainText('/mira pair ');
    await panel.getByRole('heading', { name: '连接与设置' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: testInfo.outputPath('feishu-settings-connected-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await panel.getByRole('heading', { name: '连接与设置' }).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await page.screenshot({ path: testInfo.outputPath('feishu-settings-connected-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.keyboard.press('Escape');
    await expect(page.getByText('（合成测试）请告诉我今天的任务进度。', { exact: true })).toBeVisible();
    await expect(page.getByText('（合成测试）已收到你的飞书消息，任务进度会在这里同步。', { exact: true })).toBeVisible();
    await expect(page.locator('.message-source').filter({ hasText: '普通插件 · ordinary' })).toHaveCount(1);
    await expect(page.locator('.message-source').filter({ hasText: '飞书 · feishu · 收到' })).toHaveCount(1);
    await expect(page.locator('.message-source').first()).toHaveCSS('font-size', '11px');
    const checkSourceMetadata = async (narrow: boolean) => {
      for (const row of await page.locator('.message-row').filter({ has: page.locator('.message-source') }).all()) {
        const meta = row.locator('.message-meta');
        if (narrow) await row.focus();
        else {
          await page.getByRole('button', { name: '模型设置', exact: true }).focus();
          await page.mouse.move(0, 0);
          await expect(meta).toHaveCSS('opacity', '0');
          await row.hover();
        }
        // Source and time are revealed together outside the bubble, not a permanent footer.
        await expect(meta).toHaveCSS('opacity', '1');
        await expect(meta.locator('.message-source')).toBeVisible();
        await expect(meta.locator('time')).toBeVisible();
        const source = (await meta.locator('.message-source').boundingBox())!;
        const time = (await meta.locator('time').boundingBox())!;
        const block = (await meta.boundingBox())!;
        const bubble = (await row.locator('.message-bubble').boundingBox())!;
        if (narrow) {
          await expect(meta).toHaveCSS('flex-direction', 'column');
          expect(time.y).toBeGreaterThanOrEqual(source.y + source.height);
          expect(time.y - source.y - source.height).toBeLessThan(5);
        } else {
          await expect(meta).toHaveCSS('flex-direction', 'row');
          expect(Math.abs(source.y - time.y)).toBeLessThan(3);
          expect(time.x).toBeGreaterThanOrEqual(source.x + source.width);
        }
        if (await row.evaluate(element => element.classList.contains('user'))) expect(block.x + block.width).toBeLessThanOrEqual(bubble.x + 1);
        else expect(block.x).toBeGreaterThanOrEqual(bubble.x + bubble.width - 1);
        expect(block.x).toBeGreaterThanOrEqual(0);
        expect(block.x + block.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        expect(source.x).toBeGreaterThanOrEqual(block.x - 1);
        expect(time.x + time.width).toBeLessThanOrEqual(block.x + block.width + 1);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    };
    await checkSourceMetadata(false);
    await page.screenshot({ path: testInfo.outputPath('feishu-connected-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkSourceMetadata(true);
    await page.screenshot({ path: testInfo.outputPath('feishu-inbound-narrow.png'), fullPage: true });
    const outbound = page.getByText('（合成测试）已收到你的飞书消息，任务进度会在这里同步。', { exact: true });
    await outbound.scrollIntoViewIfNeeded(); await expect(outbound).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath('feishu-connected-narrow.png'), fullPage: true });
    await deliver('om_other', '（合成测试）另一位用户的私聊。', 'ou_other');
    await expect.poll(() => effectful.length).toBe(2);
    expect(effectful[1]!.path).toContain('/messages/om_other/reply');
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    const durableCounts = (await db.admin.query('SELECT (SELECT count(*) FROM wake_requests)::integer AS wakes, (SELECT count(*) FROM wake_runs)::integer AS runs')).rows[0];
    await app.close(); app = undefined; await service.close(); service = undefined; expect(closed).toBe(true);
    service = await LocalWebService.open({ ...common, extensions: await readExtensionConfiguration(configuration) });
    await deliver('om_user', '（合成测试）请告诉我今天的任务进度。');
    await deliver('om_other', '（合成测试）另一位用户的私聊。', 'ou_other'); expect(effectful).toHaveLength(2);
    expect((await db.admin.query('SELECT (SELECT count(*) FROM wake_requests)::integer AS wakes, (SELECT count(*) FROM wake_runs)::integer AS runs')).rows[0]).toEqual(durableCounts);
    expect((await db.admin.query("SELECT count(*)::integer AS count FROM life_events WHERE event->>'type'='feishu.message'")).rows[0].count).toBe(2);
  } finally { delete registry.miraFeishuSynthetic; await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});
