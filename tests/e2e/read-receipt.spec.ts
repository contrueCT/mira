import { expect, test } from '@playwright/test';

const at = (minute: number) => `2026-10-31T08:${String(minute).padStart(2, '0')}:00.000Z`;
const timeline = (read: boolean) => ({ nextCursor: null, items: [
  { id: 'u1', role: 'user', text: '日报的格式改成先列标题再写摘要', occurredAt: at(20), externalEventId: 'e1' },
  { id: 'a1', role: 'assistant', text: '改好了，明天那期开始用新格式。', occurredAt: at(21) },
  { id: 'u2', role: 'user', text: '好的，谢谢', occurredAt: at(22), externalEventId: 'e2', ...(read ? { read: true } : {}) },
] });

test('已读 appears only under the newest user message, with no notice for a silent reply', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let read = false;
  await page.route('**/api/timeline', route => route.fulfill({ json: timeline(read) }));
  await page.goto('/');
  await expect(page.getByText('好的，谢谢', { exact: true })).toBeVisible();
  await expect(page.locator('.message-receipt.read')).toHaveCount(0);
  read = true; await page.reload();
  const receipt = page.locator('.message-receipt.read');
  await expect(receipt).toHaveCount(1); await expect(receipt).toHaveText('已读');
  await expect(page.locator('article', { has: receipt }).getByText('好的，谢谢', { exact: true })).toBeVisible();
  await expect(page.getByText(/选择不回复|NO_REPLY/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('a newer message being sent hides the older 已读', async ({ page }) => {
  await page.route('**/api/timeline', route => route.fulfill({ json: timeline(true) }));
  await page.route('**/api/messages', () => { /* never answered: the message stays pending */ });
  await page.goto('/');
  await expect(page.locator('.message-receipt.read')).toHaveCount(1);
  const input = page.getByLabel('给 Mira 发消息', { exact: true });
  await input.fill('还有一件事'); await input.press('Enter');
  await expect(page.getByText('正在发送…')).toBeVisible();
  await expect(page.locator('.message-receipt.read')).toHaveCount(0);
});
