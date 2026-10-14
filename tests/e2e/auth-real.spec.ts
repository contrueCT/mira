import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createLocalHttp, LocalWebService, WebAccessAuth } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3228;
// Chromium resolves this explicit non-loopback browser hostname to the isolated
// listener. Host/Origin checks still see the real configured remote authority.
const origin = `http://mira-auth.test:${port}`;
const password = 'synthetic-browser-password';
async function access(page: Page) {
  if (!await page.locator('dialog.settings-dialog').isVisible()) await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '访问', exact: true }).click();
  await expect(page.getByRole('switch', { name: '使用访问密码' })).toBeVisible();
}
async function login(page: Page, value: string) {
  await page.getByLabel('访问密码', { exact: true }).fill(value);
  await page.getByRole('button', { name: '进入 Mira', exact: true }).click();
}
async function status(page: Page, url: string) {
  return page.evaluate(async url => (await fetch(url, { headers: { 'x-mira-client': 'web' } })).status, url);
}

test('optional password gates real private HTTP and attachments with remote Host, logout, restart and setting changes', async ({ playwright }, testInfo) => {
  const browser = await playwright.chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP mira-auth.test 127.0.0.1', '--no-proxy-server'],
    ...(process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] ? { executablePath: process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'] } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  const otherContext = await browser.newContext(); const other = await otherContext.newPage();
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-auth-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  let auth: WebAccessAuth;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    db = await createTestDatabase();
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'auth-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
    const start = async () => {
      service = await LocalWebService.open(options);
      auth = await WebAccessAuth.open({ miraHome: root, sourceDirectory });
      app = createLocalHttp({ backend: service, auth, port, publicOrigin: origin, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
      await app.listen({ port, host: '127.0.0.1' });
    };
    await start(); await page.goto(origin);
    await expect(page.locator('form.composer')).toBeVisible();
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    // Exercise production draft UUID generation, upload, receipt, PG attachment
    // binding and runtime through the actual UI on an insecure LAN-style origin.
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await (await picker).setFiles({ name: 'synthetic.txt', mimeType: 'text/plain', buffer: Buffer.from('private synthetic attachment') });
    await page.locator('form.composer textarea').fill('Password access synthetic test');
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await service!.timeline()).items.length).toBeGreaterThan(1);
    const attachment = (await service!.timeline()).items.find(item => item.role === 'user')?.attachments?.[0];
    expect(attachment).toBeDefined();
    if (!attachment) throw Error('Actual user message did not persist its attachment');
    await access(page); await page.getByRole('switch', { name: '使用访问密码' }).check();
    await page.getByLabel('设置访问密码', { exact: true }).fill(password);
    await page.getByLabel('再次输入新密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '保存访问设置', exact: true }).click();
    await expect.poll(async () => page.evaluate(async () => { const state = await (await fetch('/api/auth/status', { headers: { 'x-mira-client': 'web' } })).json() as { enabled: boolean; authenticated: boolean }; return state.enabled && state.authenticated; })).toBe(true);
    await expect(page.locator('form.composer')).toBeVisible();
    await access(page);
    await expect(page.getByRole('switch', { name: '使用访问密码' })).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('password-settings-desktop.png'), fullPage: true });
    await other.goto(origin);
    await expect(other.getByLabel('访问密码', { exact: true })).toBeVisible();
    await expect(other.locator('form.composer')).toHaveCount(0);
    for (const url of ['/api/status', '/api/timeline', '/api/settings', '/api/memory', '/api/extensions', '/api/runs', `/api/attachments/${attachment.id}`]) expect(await status(other, url)).toBe(401);
    await login(other, 'synthetic-wrong-password');
    await expect(other.getByRole('alert')).toBeVisible();
    await expect(other.locator('form.composer')).toHaveCount(0);
    await other.screenshot({ path: testInfo.outputPath('password-login-desktop.png'), fullPage: true });
    await login(other, password); await expect(other.locator('form.composer')).toBeVisible();
    expect(await status(other, `/api/attachments/${attachment.id}`)).toBe(200);
    // Password change invalidates the second browser's previously valid session.
    // Hold the real rotation response while the app's next old-cookie poll is
    // rejected: private DOM must disappear, then the latest successful write
    // must restore authenticated access rather than being lost on unmount.
    await page.bringToFront();
    let releaseRotation!: () => void;
    const heldRotation = new Promise<void>(resolve => { releaseRotation = resolve; });
    await page.route(`${origin}/api/auth/settings`, async route => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      // Inject one delayed old-cookie failure: route.fetch may already update
      // Playwright's cookie jar before the browser receives the held response.
      await page.route(`${origin}/api/status`, route => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'Please sign in to Mira' }) }), { times: 1 });
      await heldRotation;
      await route.fulfill({ response });
    });
    await page.getByRole('button', { name: '更改访问密码', exact: true }).click();
    await page.getByLabel('当前访问密码', { exact: true }).fill(password);
    await page.getByLabel('新访问密码', { exact: true }).fill('synthetic-replacement-password');
    await page.getByLabel('再次输入新密码', { exact: true }).fill('synthetic-replacement-password');
    await page.getByRole('button', { name: '保存访问设置', exact: true }).click();
    await expect(page.getByText('正在确认访问设置…', { exact: true })).toBeVisible();
    await expect(page.locator('form.composer')).toHaveCount(0);
    releaseRotation();
    await expect(page.locator('form.composer')).toBeVisible();
    await page.unroute(`${origin}/api/auth/settings`);
    await access(page);
    await expect(page.getByRole('switch', { name: '使用访问密码' })).toBeChecked();
    await other.reload(); await expect(other.getByLabel('访问密码', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page.getByLabel('访问密码', { exact: true })).toBeVisible();
    expect(await status(page, `/api/attachments/${attachment.id}`)).toBe(401);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('password-login-mobile.png'), fullPage: true });
    await login(page, 'synthetic-replacement-password'); await expect(page.locator('form.composer')).toBeVisible();
    await app!.close(); await service!.close(); await start();
    await page.reload(); await expect(page.getByLabel('访问密码', { exact: true })).toBeVisible();
    await login(page, 'synthetic-replacement-password'); await expect(page.locator('form.composer')).toBeVisible();
    await access(page); await page.getByRole('switch', { name: '使用访问密码' }).uncheck();
    await page.getByLabel('当前访问密码', { exact: true }).fill('synthetic-replacement-password');
    await page.getByRole('button', { name: '保存访问设置', exact: true }).click();
    await expect(page.getByText('密码保护已关闭，能连接到此服务的人可以直接访问。')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('password-settings-mobile.png'), fullPage: true });
    await other.reload(); await expect(other.locator('form.composer')).toBeVisible();
    expect(await status(other, `/api/attachments/${attachment.id}`)).toBe(200);
    expect((await db.admin.query('SELECT current_database() AS name')).rows[0].name).toBe('mira_test');
    expect(errors).toEqual([]);
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath('first-failure.png'), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await context.tracing.stop({ path: testInfo.outputPath('auth-trace.zip') }).catch(() => undefined);
    await browser.close(); await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
  }
});
