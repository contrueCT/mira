import { expect, test, type Page, type Route } from '@playwright/test';
import type { TimelineItem, TimelinePage } from '../../apps/web/src/types.ts';

// Real React/browser interactions with synthetic HTTP pages; not a PostgreSQL gate.
function item(index: number): TimelineItem {
  return { id: `history-${index}`, role: 'assistant', text: `历史消息 ${index}`, occurredAt: new Date(Date.UTC(2026, 9, 16, 0, 0, index)).toISOString() };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const progressNotice = '这段历史较长，已保留读取进度，请继续加载。';
const olderButton = (page: Page) => page.getByRole('button', { name: '查看更早的消息', exact: true });
async function fixture(page: Page, latest: () => TimelinePage, older: (cursor: string, route: Route) => Promise<void>) {
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'idle', mode: 'synthetic', model: 'Fixture', error: null } }));
  await page.route('**/api/timeline', async route => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { before: string };
      await older(body.before, route);
    } else await route.fulfill({ json: latest() });
  });
  await page.goto('/');
  await expect(olderButton(page)).toBeEnabled();
}

test('a private-only first window fills itself from older history without showing the empty chat', async ({ page }) => {
  const reads: string[] = [];
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'idle', mode: 'synthetic', model: 'Fixture', error: null } }));
  await page.route('**/api/timeline', async route => {
    if (route.request().method() !== 'POST') { await route.fulfill({ json: { items: [], nextCursor: 'empty-0' } }); return; }
    reads.push((route.request().postDataJSON() as { before: string }).before);
    await route.fulfill({ json: reads.length < 3 ? { items: [], nextCursor: `empty-${reads.length}` } : { items: [item(1)], nextCursor: null } });
  });
  await page.goto('/');
  // Regression: the newest raw window held only private records, and the page
  // claimed there was no conversation at all.
  await expect(page.getByText('历史消息 1', { exact: true })).toBeVisible();
  await expect(page.getByText('和 Mira 说点什么')).toHaveCount(0);
  await expect(page.locator('.history-controls')).toHaveCount(0);
  expect(reads).toEqual(['empty-0', 'empty-1', 'empty-2']);
});

test('a long private-only stretch says older history exists instead of showing the empty chat', async ({ page }) => {
  const reads: string[] = [];
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'idle', mode: 'synthetic', model: 'Fixture', error: null } }));
  await page.route('**/api/timeline', async route => {
    if (route.request().method() !== 'POST') { await route.fulfill({ json: { items: [], nextCursor: 'hidden-0' } }); return; }
    reads.push((route.request().postDataJSON() as { before: string }).before);
    await route.fulfill({ json: { items: reads.length > 8 ? [item(1)] : [], nextCursor: reads.length > 8 ? null : `hidden-${reads.length}` } });
  });
  await page.goto('/');
  await expect(page.getByText('最近是 Mira 的内部处理记录')).toBeVisible();
  await expect(page.getByText('和 Mira 说点什么')).toHaveCount(0);
  expect(reads).toHaveLength(8);
  await olderButton(page).click();
  await expect(page.getByText('历史消息 1', { exact: true })).toBeVisible();
  await expect(page.getByText('最近是 Mira 的内部处理记录')).toHaveCount(0);
});

test('history load accumulates unique rows to 50 after sparse and duplicate pages', async ({ page }) => {
  const reads: string[] = [];
  const pages = [[item(99)], [item(97), item(98)], [item(97), ...Array.from({ length: 46 }, (_, i) => item(51 + i))], [item(50)]];
  await fixture(page, () => ({ items: [item(100)], nextCursor: 'page-0' }), async (cursor, route) => {
    reads.push(cursor);
    await route.fulfill({ json: { items: pages[reads.length - 1] ?? [], nextCursor: `page-${reads.length}` } });
  });
  await olderButton(page).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(51);
  await expect(olderButton(page)).toBeEnabled();
  expect(reads).toEqual(['page-0', 'page-1', 'page-2', 'page-3']);
  await expect(page.locator('.history-controls [role="alert"]')).toHaveCount(0);
  await expect(page.locator('[data-message-id="history-97"]')).toHaveCount(1);
});

test('history load stops after eight sparse pages and resumes at the saved cursor', async ({ page }) => {
  const reads: string[] = [];
  await fixture(page, () => ({ items: [item(100)], nextCursor: 'sparse-0' }), async (cursor, route) => {
    reads.push(cursor);
    await route.fulfill({ json: { items: [item(100 - reads.length)], nextCursor: reads.length === 9 ? null : `sparse-${reads.length}` } });
  });
  await olderButton(page).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(9);
  await expect(olderButton(page)).toBeEnabled();
  expect(reads).toEqual(Array.from({ length: 8 }, (_, i) => `sparse-${i}`));
  await expect(page.getByText(progressNotice, { exact: true })).toBeVisible();
  await olderButton(page).click();
  await expect(page.locator('.history-controls')).toHaveCount(0);
  expect(reads.at(-1)).toBe('sparse-8');
  await expect(page.locator('[data-message-id]')).toHaveCount(10);
});

test('history load stops repeated cursor cycles without dropping accepted rows', async ({ page }) => {
  const reads: string[] = [];
  await fixture(page, () => ({ items: [item(100)], nextCursor: 'cycle-a' }), async (cursor, route) => {
    reads.push(cursor);
    await route.fulfill({ json: { items: [item(100 - reads.length)], nextCursor: cursor === 'cycle-a' ? 'cycle-b' : 'cycle-a' } });
  });
  await olderButton(page).click();
  await expect(page.locator('[data-message-id]')).toHaveCount(3);
  await expect(olderButton(page)).toBeEnabled();
  expect(reads).toEqual(['cycle-a', 'cycle-b']);
  await expect(page.getByText(progressNotice, { exact: true })).toBeVisible();
});

test('history load retains partial success and retries only the failed frontier', async ({ page }) => {
  const reads: string[] = [];
  await fixture(page, () => ({ items: [item(100)], nextCursor: 'retry-0' }), async (cursor, route) => {
    reads.push(cursor);
    if (reads.length === 2) { await route.fulfill({ status: 503, json: { error: 'synthetic page unavailable' } }); return; }
    await route.fulfill({ json: { items: [item(cursor === 'retry-0' ? 99 : 98)], nextCursor: cursor === 'retry-0' ? 'retry-1' : null } });
  });
  await olderButton(page).click();
  await expect(page.locator('.history-controls [role="alert"]')).toContainText('synthetic page unavailable');
  await expect(page.locator('[data-message-id="history-99"]')).toHaveCount(1);
  await expect(olderButton(page)).toBeEnabled();
  await olderButton(page).click();
  await expect(page.locator('.history-controls')).toHaveCount(0);
  await expect(page.locator('[data-message-id]')).toHaveCount(3);
  expect(reads).toEqual(['retry-0', 'retry-1', 'retry-1']);
});

test('history load times out at 15 seconds, retaining the successful page and retry cursor', async ({ page }) => {
  const now = new Date('2026-10-16T12:00:00Z');
  await page.clock.install({ time: now });
  const release = deferred(); const reads: string[] = [];
  await fixture(page, () => ({ items: [item(100)], nextCursor: 'timeout-0' }), async (cursor, route) => {
    reads.push(cursor);
    if (reads.length === 2) {
      await release.promise;
      // The browser has already aborted this request when its deadline expires.
      await route.abort('aborted').catch(() => {});
      return;
    }
    await route.fulfill({ json: { items: [item(cursor === 'timeout-0' ? 99 : 98)], nextCursor: cursor === 'timeout-0' ? 'timeout-1' : null } });
  });
  // Let initialization finish before freezing timers for the exact deadline.
  await page.clock.pauseAt(new Date(now.getTime() + 60_000));
  try {
    await olderButton(page).click();
    await expect.poll(() => reads.length).toBe(2);
    await expect(page.locator('[data-message-id="history-99"]')).toHaveCount(1);
    await page.clock.fastForward(14_999);
    await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
    await expect(page.locator('.history-controls [role="alert"]')).toHaveCount(0);
    await page.clock.fastForward(1);
    await expect(page.locator('.history-controls [role="alert"]')).toHaveText('读取较久，已保留进度，请再试一次。');
    await expect(olderButton(page)).toBeEnabled();
    await expect(page.locator('[data-message-id="history-99"]')).toHaveCount(1);
    expect(reads).toEqual(['timeout-0', 'timeout-1']);
    release.resolve();
    await olderButton(page).click();
    await expect(page.locator('.history-controls')).toHaveCount(0);
    await expect(page.locator('[data-message-id]')).toHaveCount(3);
    expect(reads).toEqual(['timeout-0', 'timeout-1', 'timeout-1']);
  } finally { release.resolve(); }
});

test('history load ignores rapid repeated clicks while a page is in flight', async ({ page }) => {
  const release = deferred(); const reads: string[] = [];
  await fixture(page, () => ({ items: [item(100)], nextCursor: 'busy-0' }), async (cursor, route) => {
    reads.push(cursor); await release.promise;
    await route.fulfill({ json: { items: [item(99)], nextCursor: null } });
  });
  try {
    await olderButton(page).evaluate(element => {
      // Dispatch in the same event-loop turn to exercise the ref guard before render.
      for (let i = 0; i < 3; i++) element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await expect.poll(() => reads.length).toBe(1);
    await expect(page.getByRole('button', { name: '正在读取…', exact: true })).toBeDisabled();
  } finally { release.resolve(); }
  await expect(page.locator('.history-controls')).toHaveCount(0);
  expect(reads).toEqual(['busy-0']);
});

test('history load does not count newly polled messages toward its 50 historical rows', async ({ page }) => {
  const release = deferred(); const reads: string[] = []; let live = false;
  await fixture(page, () => ({ items: live ? [item(100), ...Array.from({ length: 50 }, (_, i) => item(101 + i))] : [item(100)], nextCursor: 'live-0' }), async (cursor, route) => {
    reads.push(cursor);
    if (reads.length === 1) await release.promise;
    // The delayed page overlaps rows already accepted by the latest poll.
    // Those 50 live rows must not satisfy this click's historical row budget.
    await route.fulfill({ json: { items: reads.length === 1 ? [item(99), ...Array.from({ length: 50 }, (_, i) => item(101 + i))] : Array.from({ length: 49 }, (_, i) => item(50 + i)), nextCursor: `live-${reads.length}` } });
  });
  try {
    await olderButton(page).click(); await expect.poll(() => reads.length).toBe(1);
    live = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.locator('[data-message-id="history-150"]')).toHaveCount(1);
  } finally { release.resolve(); }
  await expect(page.locator('[data-message-id="history-50"]')).toHaveCount(1);
  await expect(olderButton(page)).toBeEnabled();
  expect(reads).toEqual(['live-0', 'live-1']);
  await expect(page.locator('[data-message-id]')).toHaveCount(101);
});

for (const width of [1200, 390]) {
  test(`history load preserves the visible reading anchor across successive pages at width ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const releases = [deferred(), deferred()]; const reads: string[] = [];
    await fixture(page, () => ({ items: Array.from({ length: 30 }, (_, i) => item(100 + i)), nextCursor: 'anchor-0' }), async (cursor, route) => {
      const index = reads.length; reads.push(cursor);
      await releases[index]!.promise;
      await route.fulfill({ json: { items: Array.from({ length: 25 }, (_, i) => item(75 - 25 * index + i)), nextCursor: `anchor-${index + 1}` } });
    });
    // Clicking the top history control intentionally places the reader at the top.
    await olderButton(page).click();
    await expect.poll(() => reads.length).toBe(1);
    const anchor = page.locator('[data-message-id="history-100"]');
    const offset = () => anchor.evaluate(element => element.getBoundingClientRect().top - document.querySelector('.timeline-scroll')!.getBoundingClientRect().top);
    const before = await offset();
    try {
      releases[0]!.resolve();
      await expect.poll(() => reads.length).toBe(2);
      await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThan(2);
      releases[1]!.resolve();
      await expect(page.locator('[data-message-id]')).toHaveCount(80);
      await expect(olderButton(page)).toBeEnabled();
      await expect.poll(async () => Math.abs(await offset() - before)).toBeLessThan(2);
    } finally { releases.forEach(release => release.resolve()); }
    expect(reads).toEqual(['anchor-0', 'anchor-1']);
  });
}

test('history load leaves reply navigation able to focus the original without fetching again', async ({ page }) => {
  const original = item(1); const reply = { ...item(100), role: 'user' as const, reply: { messageId: original.id, role: 'assistant' as const, text: original.text } };
  const reads: string[] = [];
  await fixture(page, () => ({ items: [reply], nextCursor: 'quote-0' }), async (cursor, route) => {
    reads.push(cursor);
    await route.fulfill({ json: reads.length === 1 ? { items: [], nextCursor: 'quote-1' } : { items: [original], nextCursor: null } });
  });
  await olderButton(page).click();
  await expect(page.locator('.history-controls')).toHaveCount(0);
  await page.getByRole('button', { name: '查看引用的消息' }).click();
  await expect(page.locator('[data-message-id="history-1"]')).toBeFocused();
  expect(reads).toEqual(['quote-0', 'quote-1']);
  await expect(page.locator('.reply-quote')).toContainText(original.text);
});
