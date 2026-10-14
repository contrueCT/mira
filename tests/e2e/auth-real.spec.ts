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
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
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
    // Actual immutable attachment storage and PG receipt precede enabling auth.
    const attachment = await page.evaluate(async () => {
      const response = await fetch('/api/attachments?name=synthetic.txt', { method: 'POST', headers: { 'x-mira-client': 'web', 'content-type': 'application/octet-stream' }, body: 'private synthetic attachment' });
      if (response.status !== 201) throw Error(`Upload failed: ${response.status}`);
      return await response.json() as { id: string };
    });
    await page.locator('form.composer textarea').fill('Password access synthetic test');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(async () => (await service!.timeline()).items.length).toBeGreaterThan(1);
    await access(page); await page.getByRole('switch', { name: '使用访问密码' }).check();
    await page.getByLabel('设置访问密码', { exact: true }).fill(password);
    await page.getByLabel('再次输入新密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '保存访问设置', exact: true }).click();
    await expect(page.getByText('访问密码已保存，当前浏览器已登录，其他浏览器需重新登录。')).toBeVisible();
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
    await page.getByRole('button', { name: '更改访问密码', exact: true }).click();
    await page.getByLabel('当前访问密码', { exact: true }).fill(password);
    await page.getByLabel('新访问密码', { exact: true }).fill('synthetic-replacement-password');
    await page.getByLabel('再次输入新密码', { exact: true }).fill('synthetic-replacement-password');
    await page.getByRole('button', { name: '保存访问设置', exact: true }).click();
    await expect(page.getByText('访问密码已保存，当前浏览器已登录，其他浏览器需重新登录。')).toBeVisible();
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
  } finally {
    await browser.close(); await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
  }
});
