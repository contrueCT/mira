import { expect, test } from '@playwright/test';

test('render the real chat with synthetic everyday conversation for README', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const conversation = [
    { role: 'user', text: '周末想给自己放个假，不想把时间排得太满。' },
    { role: 'assistant', text: '那就只留一件想做的事，剩下的时间随意。最近有没有什么地方一直想去？' },
    { role: 'user', text: '想去河边走走，顺便找家书店。' },
    { role: 'assistant', text: '挺好。下午沿河慢慢走，累了就进书店坐一会儿。晚饭也不用提前安排，看到想吃的再决定。' },
  ];
  await page.route('**/api/timeline', route => route.fulfill({ json: {
    items: conversation.map((item, index) => ({ ...item, id: `10000000-0000-4000-8000-00000000000${index + 1}`, occurredAt: `2026-10-15T16:0${index}:00.000Z` })), nextCursor: null,
  } }));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  for (const item of conversation) await expect(page.getByText(item.text, { exact: true })).toBeVisible();
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeVisible();
  await expect(page.locator('.identity-detail').filter({ hasText: '模拟模型' })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('mira-chat.png'), fullPage: true });
});
