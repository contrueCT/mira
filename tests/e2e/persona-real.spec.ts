import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { getCurrentSystemMessage, getSystemMessageText, type TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3219;
const origin = `http://127.0.0.1:${port}`;
const shots = path.join(sourceDirectory, 'test-results', 'persona-real-screenshots');

/** A small real PNG (synthetic face on a rose→iris gradient), encoded here so no binary fixture is needed. */
function avatarPng(size = 96): Buffer {
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); row[0] = 0;
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size);
      let [r, g, b] = [Math.round(233 - 16 * t), Math.round(207 - 3 * t), Math.round(216 + 20 * t)];
      const dx = x - size / 2, dy = y - size / 2;
      if (Math.hypot(dx, dy) < size * 0.32) [r, g, b] = [250, 236, 226];
      if (Math.hypot(x - size * 0.4, y - size * 0.45) < size * 0.04 || Math.hypot(x - size * 0.6, y - size * 0.45) < size * 0.04) [r, g, b] = [70, 62, 92];
      if (Math.abs(Math.hypot(dx, y - size * 0.5) - size * 0.13) < 1.6 && y > size * 0.56) [r, g, b] = [176, 92, 120];
      row.set([r, g, b, 255], 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const profile = (context: TranscriptContext) => {
  const system = getCurrentSystemMessage(context.messages);
  const text = system ? getSystemMessageText(system) : '';
  return /<persona_profile>\n([\s\S]*?)\n<\/persona_profile>/.exec(text)?.[1] ?? '';
};
async function openPersona(page: Page) {
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '人设', exact: true }).click();
  await expect(page.getByRole('tabpanel', { name: '人设' })).toBeVisible();
}
const shot = async (page: Page, name: string) => { await mkdir(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, name) }); };

// Production HTTP, PostgreSQL, Wake/runtime and persona files run unchanged; only
// model outputs are scripted. Browser requests are never mocked.
test('persona tab: preset, avatar upload, save notice, conflict-tidy request and next-Wake prompt', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-persona-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  const profiles: string[] = [];
  const errors: string[] = [];
  const posted: Array<{ id: string; text: string }> = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url() === `${origin}/api/messages`) posted.push(request.postDataJSON()); });
  try {
    db = await createTestDatabase();
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'persona-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      memoryRoot: path.join(root, 'memory'), synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
    const replies = ['今天把 mira 的浏览器面板合进去了？还挺快的。', '哼，记忆我已经看过了，跟新人设冲突的那两条改掉了。才不是特意为你整理的。', '早。昨天那个 409 我又看了一眼……是重试时没带 revision，别误会，只是顺手。'];
    service = await LocalWebService.open({ ...options, syntheticStream: async (_model, context) => {
      profiles.push(profile(context));
      return streamOf(assistant(replies[profiles.length - 1] ?? '嗯。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.goto(origin);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Mira');
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('今天把 mira 的浏览器面板合进去了');
    await page.getByLabel('给 Mira 发消息', { exact: true }).press('Enter');
    await expect(page.locator('.message-bubble', { hasText: replies[0]! })).toBeVisible();
    expect(profiles[0]).toBe('No custom profile is configured. Present yourself as Mira, exactly as described above.');

    await openPersona(page);
    const panel = page.getByRole('tabpanel', { name: '人设' });
    await expect(panel).toContainText('未设置 · 使用默认 Mira');
    await expect(panel.getByLabel('怎么称呼你')).toHaveValue('');
    await expect(page.getByRole('tab', { name: '人设' })).toHaveAttribute('aria-selected', 'true');
    const tabs = await page.getByRole('tab').allTextContents();
    expect(tabs.slice(0, 3)).toEqual(['模型', '人设', 'Memory']);
    await shot(page, 'persona-tab-desktop.png');

    await panel.getByRole('button', { name: '傲娇', exact: true }).click();
    await expect(panel.getByRole('button', { name: '傲娇', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByLabel(/^名字/)).toHaveValue('小凛');
    await expect(panel.getByLabel('怎么称呼你')).toHaveValue('');
    await expect(panel.getByRole('radio', { name: '玫瑰' })).toHaveAttribute('aria-checked', 'true');
    await expect(panel).toContainText('尚有未保存的更改');
    await expect(panel.getByRole('checkbox', { name: /整理与新人设冲突的记忆/ })).toBeChecked();
    expect(await panel.textContent()).not.toContain('是不是人');
    await panel.getByRole('button', { name: '查看注入内容' }).click();
    await expect(panel.getByLabel('注入到系统提示词的人设内容')).toContainText('Name: 小凛');
    await panel.getByRole('button', { name: '收起注入内容' }).click();
    await shot(page, 'persona-preset-applied-desktop.png');

    // Rejected client-side before any upload, then a real PNG through the protected binary route.
    await page.locator('#persona-avatar-file').setInputFiles({ name: 'avatar.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') });
    await expect(panel.getByRole('alert')).toContainText('PNG');
    await page.locator('#persona-avatar-file').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: avatarPng() });
    await expect(panel.locator('.persona-ring img')).toBeVisible();
    await expect(panel.getByRole('button', { name: '更换图片' })).toBeVisible();
    const avatarFiles = await import('node:fs/promises').then(fs => fs.readdir(path.join(root, 'persona-avatars')));
    expect(avatarFiles).toHaveLength(1); expect(avatarFiles[0]).toMatch(/^[a-f0-9]{64}\.png$/);
    expect(await panel.locator('.persona-ring img').getAttribute('src')).toMatch(/^blob:/);

    await panel.getByRole('button', { name: '保存人设' }).click();
    await expect(panel.getByRole('status')).toContainText('人设已保存为第 1 版');
    await expect(panel.getByRole('status')).toContainText('已请小凛整理冲突的记忆');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('小凛');
    await expect(page.locator('.app-header .mira-ring img')).toBeVisible();
    expect((await stat(path.join(root, 'persona.json'))).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(path.join(root, 'persona.json'), 'utf8'));
    expect(saved.current.name).toBe('小凛'); expect(saved.current.presetId).toBe('tsundere');
    await expect.poll(() => posted.length).toBe(2);
    expect(posted[1]!.text).toContain('我刚把你的人设改成了「小凛」');
    await expect.poll(() => profiles.length).toBe(2);
    expect(profiles[1]).toContain('Name: 小凛'); expect(profiles[1]).toContain('Personality and attitude:');
    await expect(panel).toContainText('已生效 · 第 1 版');
    await expect(panel).toContainText('人设保存在本机服务端');

    // A second save without the tidy request posts no message and does not wake.
    await panel.getByRole('checkbox', { name: /整理与新人设冲突的记忆/ }).uncheck();
    await panel.getByLabel('补充说明').fill('早上第一条消息可以简短问候。');
    await panel.getByRole('button', { name: '保存人设' }).click();
    await expect(panel.getByRole('status')).toContainText('人设已保存为第 2 版');
    await page.waitForTimeout(500);
    expect(posted).toHaveLength(2); expect(profiles).toHaveLength(2);
    await panel.getByRole('button', { name: '历史版本' }).click();
    await expect(panel.getByRole('list', { name: '历史版本' }).getByRole('listitem')).toHaveCount(2);
    await panel.getByRole('button', { name: '收起历史版本' }).click();

    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    const notices = page.locator('.message-row.persona-notice');
    await expect(notices).toHaveCount(2);
    await expect(notices.first()).toContainText('人设已更新为「小凛」（第 1 版）· 从下一次唤醒开始生效');
    await expect(page.getByLabel('给 小凛 发消息', { exact: true })).toBeVisible();
    await page.getByLabel('给 小凛 发消息', { exact: true }).fill('早');
    await page.getByLabel('给 小凛 发消息', { exact: true }).press('Enter');
    await expect(page.locator('.message-bubble', { hasText: replies[2]! })).toBeVisible();
    expect(profiles[2]).toContain('Additional notes: 早上第一条消息可以简短问候。');
    await expect(page.locator('.message-row.assistant .message-avatar img').first()).toBeVisible();
    await shot(page, 'persona-chat-notice-avatar-desktop.png');

    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, 'persona-chat-notice-avatar-phone.png');
    await openPersona(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, 'persona-tab-phone.png');
    await page.getByRole('tabpanel', { name: '人设' }).getByRole('button', { name: '技术搭档', exact: true }).click();
    await shot(page, 'persona-preset-applied-phone.png');
    await page.getByRole('tabpanel', { name: '人设' }).getByRole('button', { name: '撤销修改' }).click();
    await expect(page.getByRole('tabpanel', { name: '人设' }).getByLabel(/^名字/)).toHaveValue('小凛');
    expect(errors).toEqual([]);
  } finally {
    await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
  }
});
