import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { JsonObject, TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3224;
const origin = `http://127.0.0.1:${port}`;
const shots = process.env['MIRA_UNSTUCK_SHOTS'] ?? path.join(sourceDirectory, 'test-results', 'unstuck-real-screenshots');
async function shot(page: Page, name: string) {
  await mkdir(shots, { recursive: true });
  await page.screenshot({ path: path.join(shots, `${name}-desktop.png`) });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText(/已读/).last().scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(shots, `${name}-phone.png`) });
  await page.setViewportSize({ width: 1440, height: 1000 });
}
const conversation = (context: TranscriptContext) => context.messages.filter(message => message.role !== 'system');
const lastUserText = (context: TranscriptContext) => {
  const message = conversation(context).findLast(item => item.role === 'user');
  return typeof message?.content === 'string' ? message.content : '';
};
const withCall = (text: string, id: string, name: string, args: JsonObject) => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'text', text }, { type: 'toolCall', id, name, arguments: args }] });

test('real PG + browser: a check-in during a stuck tool is answered at once, NO_REPLY stays invisible, and 已读 sits under the latest message only', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const db = await createTestDatabase(); const root = await mkdtemp(path.join(os.tmpdir(), 'mira-unstuck-real-'));
  const release = path.join(root, 'release');
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  try {
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'unstuck-real', sourceDirectory, workingDirectory: root, miraHome: root,
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, autoCompaction: { enabled: false }, dreaming: { enabled: false },
      foreground: { steerGraceMs: 300, hardLimitMs: 60_000 },
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        const last = lastUserText(context); const all = JSON.stringify(conversation(context));
        if (last.includes('好的，谢谢')) return streamOf(assistant('NO_REPLY'));
        if (last.includes('怎么样了')) return streamOf(assistant('还在跑，已经过半了，目前没有失败。跑完我告诉你结果。'));
        // The runtime status block names the settled event too; match user text first.
        if (last.includes('tool.background.settled') && last.includes('214 passed')) return streamOf(assistant('构建跑完了，214 个测试全部通过。'));
        if (last.includes('跑一下完整构建') && !all.includes('backgrounded')) return withCall('好，我先跑一遍完整构建，可能要几分钟。', 'build', 'bash',
          { command: `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; echo "214 passed"` });
        return streamOf(assistant('NO_REPLY'));
      } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.goto(origin);
    const composer = page.getByLabel('给 Mira 发消息', { exact: true });
    const receipts = page.locator('.message-receipt.read');
    await composer.fill('跑一下完整构建'); await composer.press('Enter');
    await expect(page.getByText('好，我先跑一遍完整构建，可能要几分钟。', { exact: true })).toBeVisible();
    await expect(receipts).toHaveCount(1);
    await expect(page.locator('article', { has: receipts }).getByText('跑一下完整构建')).toBeVisible();
    // The build is still running; the check-in is answered without waiting for it.
    await composer.fill('怎么样了？'); await composer.press('Enter');
    await expect(page.getByText('还在跑，已经过半了，目前没有失败。跑完我告诉你结果。', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(receipts).toHaveCount(1);
    await expect(page.locator('article', { has: receipts }).getByText('怎么样了？')).toBeVisible();
    await expect(page.locator('.working-indicator')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText(/backgrounded|runtime status|后台|分钟前|job/);
    await shot(page, 'steered-reply');
    // The real result arrives later and Mira reports it on her own.
    await writeFile(release, '');
    await expect(page.getByText('构建跑完了，214 个测试全部通过。', { exact: true })).toBeVisible({ timeout: 15_000 });
    // A message that needs no answer: Mira reads it and stays silent.
    await composer.fill('好的，谢谢'); await composer.press('Enter');
    await expect(page.locator('article', { has: receipts }).getByText('好的，谢谢')).toBeVisible({ timeout: 15_000 });
    await expect(receipts).toHaveCount(1);
    await expect(page.locator('.working-indicator')).toHaveCount(0);
    await expect(page.locator('body')).not.toContainText('NO_REPLY');
    await expect(page.locator('.message-row.assistant').last()).toContainText('构建跑完了');
    await shot(page, 'no-reply');
    // Reload: 已读 is derived from durable evidence.
    await page.reload();
    await expect(page.locator('article', { has: receipts }).getByText('好的，谢谢')).toBeVisible();
    await expect(receipts).toHaveCount(1);
    await expect(page.locator('body')).not.toContainText('NO_REPLY');
    expect(errors).toEqual([]);
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
