import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createLocalHttp, LocalWebService, WebSettingsStore } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { retryConfiguration, retrySelection, retryResponse, syntheticRetryKey } from '../recovery/model-retry-fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3223;
const origin = `http://127.0.0.1:${port}`;
const shots = path.join(sourceDirectory, 'test-results', 'usage-real-screenshots');
const shot = async (page: Page, name: string) => { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name) }); };
/** OpenAI-compatible stream with a usage chunk, as DeepSeek returns it. */
function reply(text: string, usage = { prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 900 } }): Response {
  return new Response([
    { id: 'usage-response', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'usage-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { id: 'usage-response', choices: [], usage }, '[DONE]',
  ].map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
const insufficient = () => new Response(JSON.stringify({ error: { message: 'Insufficient Balance', type: 'unknown_error', param: null, code: 'invalid_request_error' } }), { status: 402, headers: { 'content-type': 'application/json', 'x-request-id': 'real-402' } });

test('real PG + service: usage tab counts provider usage; a 402 pauses with one notice, survives reload, and one message resumes', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const db = await createTestDatabase(); const root = await mkdtemp(path.join(os.tmpdir(), 'mira-usage-real-'));
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  const plan: Array<() => Response> = [() => reply('第一条回复'), () => insufficient(), () => reply('充值后继续完成了')]; let calls = 0;
  try {
    const settingsFile = path.join(root, 'models.json');
    const store = new WebSettingsStore(settingsFile, sourceDirectory); const current = await store.get();
    await store.save({ revision: current.revision, selection: retrySelection, configuration: { builtinCredentials: {}, customConnections: retryConfiguration.customConnections.map(({ apiKeyEnv: _env, ...connection }) => ({ ...connection, apiKey: syntheticRetryKey })) } });
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'usage-real', sourceDirectory, workingDirectory: root, miraHome: root,
      spoolDirectory: path.join(root, 'spool'), settingsFile, autoCompaction: { enabled: false }, dreaming: { enabled: false },
      modelFetch: (async () => { calls++; const next = plan.shift(); if (!next) return retryResponse('unexpected'); return next(); }) as typeof globalThis.fetch });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.goto(origin);
    const composer = page.getByLabel('给 Mira 发消息', { exact: true });
    await composer.fill('你好'); await composer.press('Enter');
    await expect(page.getByText('第一条回复', { exact: true })).toBeVisible();
    // Usage: one request, input = uncached 300 + cached 900, output 80.
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '用量', exact: true }).click();
    const panel = page.getByRole('tabpanel', { name: '用量' });
    await expect(panel.locator('.usage-stat strong')).toHaveText(['1', '1,200', '80', '1,280']);
    await expect(panel.getByText('缓存命中 75%')).toBeVisible();
    await expect(panel.getByText('“你好”')).toBeVisible();
    await shot(page, 'usage-desktop.png');
    await page.keyboard.press('Escape');
    // 402: paused, one notice, no error banner, no retries.
    await composer.fill('再帮我做一件事'); await composer.press('Enter');
    const notice = page.getByRole('article', { name: '余额不足提示' });
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('所有动作都已停下');
    await expect(page.locator('.identity-detail')).toContainText('余额不足，已暂停');
    await expect(page.locator('.runtime-notice')).toHaveCount(0);
    expect(calls).toBe(2);
    await shot(page, 'balance-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 }); await page.reload();
    await expect(notice).toBeVisible(); await expect(page.locator('.identity-detail')).toContainText('余额不足，已暂停');
    await shot(page, 'balance-phone.png');
    await page.setViewportSize({ width: 1440, height: 1000 });
    // One user message resumes the same task directly.
    await composer.fill('充好了'); await composer.press('Enter');
    await expect(page.getByText('充值后继续完成了', { exact: true })).toBeVisible();
    await expect(page.locator('.identity-detail')).not.toContainText('余额不足');
    await expect(notice).toHaveCount(1);
    expect(calls).toBe(3);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '用量', exact: true }).click();
    await expect(panel.locator('.usage-stat strong').first()).toHaveText('3');
    await expect(panel.locator('.usage-stat small').first()).toHaveText('其中失败 1');
    expect(errors).toEqual([]);
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
