import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, MiraLifeHost, personaPresets } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3221;
const origin = `http://127.0.0.1:${port}`;
const shots = path.join(sourceDirectory, 'test-results', 'memory-reset-real-screenshots');
const shot = async (page: Page, name: string) => { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name) }); };
const exists = (file: string) => stat(file).then(() => true, () => false);
const lastUser = (context: TranscriptContext) => {
  const user = [...context.messages].reverse().find(message => message.role === 'user');
  if (!user) return '';
  return typeof user.content === 'string' ? user.content : user.content.map(part => part.type === 'text' ? part.text : '').join('');
};
async function openMemory(page: Page) {
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: 'Memory' })).toBeVisible();
}
async function send(page: Page, name: string, text: string) {
  await page.getByLabel(`给 ${name} 发消息`, { exact: true }).fill(text);
  await page.getByLabel(`给 ${name} 发消息`, { exact: true }).press('Enter');
}

for (const device of [{ label: 'desktop', viewport: { width: 1440, height: 1000 } }, { label: 'phone', viewport: { width: 390, height: 844 } }] as const) {
  test(`${device.label}: clear long-term memory (A), then start over while busy (B)`, async ({ page, context }) => {
    await page.setViewportSize(device.viewport);
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-reset-real-')));
    const slot = `reset-${device.label}`;
    let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
    let host: MiraLifeHost | undefined;
    let app: ReturnType<typeof createLocalHttp> | undefined;
    const errors: string[] = [];
    const seen: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      db = await createTestDatabase();
      const memoryRoot = path.join(root, 'memory');
      host = await MiraLifeHost.open({ slot, miraHome: root, service: { connectionString: db.connectionString, schema: db.schema, sourceDirectory,
        workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), memoryRoot,
        synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
        syntheticStream: async (_model, transcript, options) => {
          const text = lastUser(transcript); seen.push(text);
          // One deliberately long task, so the dialog must offer 停止工作并重置.
          if (text.includes('慢慢整理')) return new Promise((_resolve, reject) => { options?.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true }); });
          return streamOf(assistant(text.includes('乌龙') ? '记下了，你喜欢乌龙茶。' : '你好，我们从头认识一下吧。'));
        } } });
      const persona = await host.backend.persona();
      await host.backend.savePersona(persona.revision, structuredClone(personaPresets.find(item => item.id === 'partner')!.persona!));
      const name = (await host.backend.persona()).persona!.name;
      app = createLocalHttp({ backend: host.backend, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
      await app.listen({ port, host: '127.0.0.1' });

      await page.goto(origin);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
      await send(page, name, '记住：我喜欢乌龙茶');
      await expect(page.locator('.message-bubble', { hasText: '记下了，你喜欢乌龙茶。' })).toBeVisible();
      await writeFile(path.join(memoryRoot, 'MEMORY.md'), '# 关于你\n\n- 喜欢乌龙茶。\n- 希望界面改动先看设计稿。\n');
      await writeFile(path.join(memoryRoot, 'tea.md'), '乌龙茶：冻顶、东方美人。\n');

      // Memory tab danger zone.
      await openMemory(page);
      const panel = page.getByRole('tabpanel', { name: 'Memory' });
      await expect(panel).toContainText('喜欢乌龙茶');
      const zone = panel.getByRole('region', { name: '重置记忆' });
      await expect(zone).toContainText(`清空${name}的长期记忆，或者让${name}从头开始认识你。旧数据先归档，不会立即删除。`);
      await zone.scrollIntoViewIfNeeded();
      await shot(page, `memory-tab-${device.label}.png`);

      // Dialog defaults: alertdialog, focus on 取消, 从头开始 selected, Esc cancels back to Settings.
      await zone.getByRole('button', { name: '重置记忆…' }).click();
      const dialog = page.getByRole('alertdialog', { name: `重置${name}的记忆？` });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
      await expect(dialog.getByRole('radio', { name: /从头开始/ })).toBeChecked();
      await expect(dialog.getByRole('region', { name: '这次会影响' })).toContainText('2 个');
      await expect(dialog.getByRole('region', { name: '这次会影响' })).toContainText('0 / 0 → 取消');
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.getByRole('tabpanel', { name: 'Memory' })).toBeVisible();

      // A: only long-term memory, as a revertible commit.
      await zone.getByRole('button', { name: '重置记忆…' }).click();
      await dialog.getByText('只清空长期记忆').click();
      await expect(dialog.getByRole('radio', { name: /只清空长期记忆/ })).toBeChecked();
      await expect(dialog).toContainText('→ 清空（可回退）');
      await expect(dialog).toContainText('旧内容保存在 Memory 的 Git 历史中');
      await expect(dialog.getByRole('checkbox', { name: /同时恢复默认人设/ })).not.toBeChecked();
      const confirm = dialog.getByRole('button', { name: '重置', exact: true });
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('输入“重置”以确认').fill('重');
      await expect(confirm).toBeDisabled();
      await dialog.getByLabel('输入“重置”以确认').fill('重置');
      await expect(confirm).toBeEnabled();
      await shot(page, `reset-a-${device.label}.png`);
      await confirm.click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      await expect(zone).toContainText('长期记忆已清空');
      await expect(panel).toContainText('还没有记忆内容');
      expect(await readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf8')).toBe('');
      expect(await exists(path.join(memoryRoot, 'tea.md'))).toBe(false);
      await page.getByRole('button', { name: '关闭设置' }).click();
      await expect(page.locator('.memory-reset-notice')).toContainText('长期记忆已清空 · 旧内容保存在 Memory Git 提交');
      await expect(page.locator('.message-bubble', { hasText: '记下了，你喜欢乌龙茶。' })).toBeVisible();
      const lifeBefore = (await host.status()).lifeId;
      expect(lifeBefore).toBe(slot);

      // B while busy: 停止工作并重置, persona kept, page reloads into a fresh chat.
      await writeFile(path.join(memoryRoot, 'MEMORY.md'), '- 正在整理旧笔记。\n');
      await send(page, name, '帮我慢慢整理一下所有旧笔记');
      await expect.poll(async () => (await host!.status()).state).toBe('working');
      const other = device.label === 'desktop' ? await context.newPage() : null;
      if (other) { await other.goto(origin); await expect(other.locator('.message-bubble', { hasText: '记下了，你喜欢乌龙茶。' })).toBeVisible(); }
      await openMemory(page);
      await zone.getByRole('button', { name: '重置记忆…' }).click();
      await expect(dialog.getByRole('radio', { name: /从头开始/ })).toBeChecked();
      await expect(dialog.locator('.busy-note')).toHaveText(`${name}正在处理一个任务。确认后会先停止当前工作；已经开始的操作不会被撤销。`);
      const stop = dialog.getByRole('button', { name: '停止工作并重置' });
      await expect(stop).toBeDisabled();
      await expect(dialog).toContainText(`归档位置：${path.join(root, 'archive')}`);
      await dialog.getByLabel('输入“重置”以确认').fill('重置');
      await expect(stop).toBeEnabled();
      await shot(page, `reset-b-${device.label}.png`);
      await stop.click();
      await expect(page.getByText(`和 ${name} 说点什么`)).toBeVisible({ timeout: 45_000 });
      expect(new URL(page.url()).hash).toBe('');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
      await expect(page.locator('.message-bubble')).toHaveCount(0);
      const lifeAfter = (await host.status()).lifeId;
      expect(lifeAfter).toBe(`${slot}~g1`);
      expect(await page.evaluate(() => window.sessionStorage.getItem('mira.life-id.v1'))).toBe(lifeAfter);
      expect(await readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf8').catch(() => '')).toBe('');
      await shot(page, `after-reset-${device.label}.png`);
      if (other) {
        // Another open tab notices the new life on its next status poll and reloads clean.
        await expect(other.getByText(`和 ${name} 说点什么`)).toBeVisible({ timeout: 30_000 });
        await other.close();
      }
      await send(page, name, '你好');
      await expect(page.locator('.message-bubble', { hasText: '你好，我们从头认识一下吧。' })).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await app?.close(); await host?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
    }
  });
}
