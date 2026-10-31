import { expect, test, type Page } from '@playwright/test';
import { balanceTimeline, pausedStatus, usageReport } from './usage-fixtures.ts';

async function stubUsage(page: Page, seen: string[] = []) {
  await page.route('**/api/usage?*', route => {
    const url = new URL(route.request().url()); seen.push(url.search);
    return route.fulfill({ json: usageReport(url.searchParams.get('range') as 'today' | '7d' | '30d') });
  });
}

test('用量 tab follows 运行记录, switches ranges with the local time zone and shows no cost', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const seen: string[] = []; await stubUsage(page, seen);
  await page.setViewportSize({ width: 1280, height: 900 }); await page.goto('/');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const tabs = await page.getByRole('tab').allTextContents();
  expect(tabs.indexOf('用量')).toBe(tabs.indexOf('运行记录') + 1);
  await page.getByRole('tab', { name: '用量', exact: true }).click();
  const panel = page.getByRole('tabpanel', { name: '用量' });
  await expect(panel.getByText('模型请求', { exact: true })).toBeVisible();
  await expect(panel.locator('.usage-stat strong').first()).toHaveText('128');
  await expect(panel.getByText('缓存命中 73%')).toBeVisible();
  await expect(panel.locator('.usage-bar')).toHaveCount(7);
  await expect(panel.getByRole('cell', { name: /子任务\s*23 个任务/u })).toBeVisible();
  await expect(panel.getByText('“把浏览器面板的锁定状态重新设计一下”')).toBeVisible();
  await expect(panel.getByText(/\$|¥|费用：|cost/iu)).toHaveCount(0);
  await expect(panel.getByText('费用请以供应商账单为准', { exact: false })).toBeVisible();
  expect(seen[0]).toMatch(/^\?range=today&tz=[A-Za-z_%0-9]+/u);
  await panel.getByRole('button', { name: '最近 30 天', exact: true }).click();
  await expect(panel.getByRole('button', { name: '最近 30 天', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(panel.locator('.usage-stat strong').first()).toHaveText('3,204');
  expect(seen.some(search => search.startsWith('?range=30d&'))).toBe(true);
  await expect(panel.locator('.balance-card')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('phone settings tabs scroll horizontally instead of squeezing, and the usage tab fits', async ({ page }) => {
  await stubUsage(page);
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const strip = page.locator('.settings-tabs');
  const metrics = await strip.evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth, overflow: getComputedStyle(element).overflowX }));
  expect(metrics.overflow).toBe('auto'); expect(metrics.scroll).toBeGreaterThan(metrics.client);
  for (const button of await strip.getByRole('tab').all()) expect(await button.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.getByRole('tab', { name: '用量', exact: true }).click();
  await expect(page.getByRole('tab', { name: '用量', exact: true })).toBeInViewport();
  await expect(page.locator('.usage-stats')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('balance pause: header says only 余额不足，已暂停, the notice spans the chat column and hides internal state', async ({ page }) => {
  await page.route('**/api/status', route => route.fulfill({ json: pausedStatus }));
  await page.route('**/api/timeline', route => route.fulfill({ json: balanceTimeline }));
  await stubUsage(page);
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await page.goto('/');
    await expect(page.locator('.identity-detail')).toContainText('余额不足，已暂停');
    await expect(page.locator('.identity-detail .status-dot.warning')).toHaveCount(1);
    await expect(page.locator('.identity-detail')).not.toContainText(/402|request|子任务|工具/u);
    const notice = page.getByRole('article', { name: '余额不足提示' });
    await expect(notice).toContainText('模型余额不足，Mira 已暂停');
    await expect(notice).toContainText('所有动作都已停下'); await expect(notice).toContainText('充值后发一条消息');
    await expect(notice).not.toContainText(/结果未知|工具调用/u);
    await expect(page.locator('.working-indicator')).toHaveCount(0);
    await expect(page.locator('.runtime-notice')).toHaveCount(0);
    // Edge alignment: the card spans the same column as the conversation rows.
    const card = await notice.locator('.message-bubble').boundingBox();
    const row = await page.locator('.message-row.user .message-bubble').first().boundingBox();
    const assistant = await page.locator('.message-row.assistant .message-bubble').first().boundingBox();
    expect(card && row && assistant).toBeTruthy();
    expect(Math.abs(card!.x - assistant!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs((card!.x + card!.width) - (row!.x + row!.width))).toBeLessThanOrEqual(1);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '用量', exact: true }).click();
  await expect(page.locator('.balance-card')).toContainText('模型余额不足，Mira 已暂停');
  await expect(page.locator('.balance-card')).toContainText('所有动作都已停下');
});
