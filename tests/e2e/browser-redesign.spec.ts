import { expect, test } from '@playwright/test';
import type { Page, WebSocketRoute } from '@playwright/test';

// Browser panel redesign v2: states, focus, keyboard and motion behaviours on
// desktop and phone with fixture routes (no real browser). Real agent-browser
// coverage lives in the ad-hoc locked/real UX runs.
type Status = Record<string, unknown> & { id: string; state: string; epoch: number };
const shots = process.env['MIRA_REDESIGN_PREVIEW'];
const tabs = [
  { tabId: 't1', active: true, title: '', domain: 'httpbin.org', url: 'https://httpbin.org/forms/post' },
  { tabId: 't2', active: false, title: 'Example Domain', domain: 'example.com', url: 'https://example.com/' },
  { tabId: 't3', active: false, title: 'Root Zone Database', domain: 'www.iana.org', url: 'https://www.iana.org/domains/root/db' },
];

async function fixture(page: Page, initial: Status[]) {
  let browsers = initial;
  const received: Record<string, unknown>[] = [];
  const sockets: WebSocketRoute[] = [];
  const control: Record<string, number> = {};
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers } }));
  await page.route('**/api/browser/*/ticket', route => route.fulfill({ json: { ticket: 'fixture-ticket', epoch: 0 } }));
  for (const action of ['takeover', 'return']) await page.route(`**/api/browser/*/${action}`, async route => {
    control[action] = (control[action] ?? 0) + 1;
    const id = route.request().url().split('/').at(-2)!;
    browsers = browsers.map(item => item.id === id ? { ...item, state: action === 'takeover' ? 'human' : 'agent', epoch: item.epoch + 1 } : item);
    await route.fulfill({ json: browsers.find(item => item.id === id) });
  });
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 800;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, 1280, 800);
    ctx.fillStyle = '#000'; ctx.font = '20px serif';
    ['Customer name: Mira', 'Telephone:', 'E-mail address:', 'Pizza Size', 'Pizza Toppings', 'Delivery instructions:'].forEach((line, index) => ctx.fillText(line, 24, 44 + index * 56));
    ctx.strokeRect(190, 24, 260, 28);
    return canvas.toDataURL('image/jpeg').split(',')[1]!;
  });
  await page.routeWebSocket('**/api/browser/stream', ws => {
    sockets.push(ws);
    ws.onMessage(message => received.push(JSON.parse(String(message)) as Record<string, unknown>));
    const current = browsers.find(item => item.state !== 'closed')!;
    ws.send(JSON.stringify({ type: 'mira_state', browser: current }));
    ws.send(JSON.stringify({ type: 'tabs', generation: 1, tabs }));
    ws.send(JSON.stringify({ type: 'frame', seq: 1, generation: 1, epoch: current.epoch, data, metadata: { deviceWidth: 1280, deviceHeight: 800 } }));
  });
  return {
    received, sockets, control,
    set(next: Status[]) { browsers = next; },
    get: () => browsers,
    frame(seq: number, epoch: number) { sockets.at(-1)!.send(JSON.stringify({ type: 'frame', seq, generation: 1, epoch, data, metadata: { deviceWidth: 1280, deviceHeight: 800 } })); },
    push(status: Status) { browsers = browsers.map(item => item.id === status.id ? status : item); sockets.at(-1)!.send(JSON.stringify({ type: 'mira_state', browser: status })); },
  };
}
const open = async (page: Page) => { await page.goto('/'); await page.getByRole('button', { name: '浏览器', exact: true }).click(); return page.getByRole('dialog', { name: '浏览器' }); };
const shot = async (page: Page, name: string) => { if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: `${shots}/${name}.png` }); } };
const agent: Status = { id: 'b1', state: 'agent', epoch: 1, ownerLabel: 'Mira', domain: 'httpbin.org' };

test('desktop: Mira operating shows the flowing frame, read-only chrome and focuses the primary action', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page, [agent]);
  const dialog = await open(page);
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBeGreaterThan(1380); expect(box.height).toBeGreaterThan(950);
  await expect(page.getByRole('status').filter({ hasText: 'Mira 正在操作 · 你在旁观' })).toBeVisible();
  const primary = page.getByRole('button', { name: '接手操作', exact: true });
  await expect(primary).toBeFocused();
  await expect(page.getByRole('button', { name: '刷新', exact: true })).toHaveCount(0);
  const tablist = page.getByRole('tablist', { name: '标签页' });
  await expect(tablist).toHaveAttribute('aria-disabled', 'true');
  await expect(tablist.getByRole('tab')).toHaveCount(3);
  // A tab without a title falls back to host + path.
  await expect(tablist.getByRole('tab', { selected: true })).toContainText('httpbin.org/forms/post');
  await expect(page.getByRole('textbox', { name: '浏览器地址' })).toHaveAttribute('aria-readonly', 'true');
  await expect(page.getByRole('button', { name: '前往', exact: true })).toHaveCount(0);
  await expect(page.getByText('接手后可切换标签页、输入网址').first()).toBeVisible();
  await expect(page.locator('.bp-tag')).toHaveText('只读画面 · Mira 实时操作中');
  await expect(page.locator('.bp-screen')).toHaveClass(/is-ai/);
  await expect.poll(() => page.locator('.bp-ring').evaluate(el => getComputedStyle(el).opacity)).toBe('1');
  expect(await page.locator('.bp-ring b').evaluate(el => getComputedStyle(el).animationName)).toBe('bp-sweep');
  expect(await page.locator('.bp-ring b').evaluate(el => getComputedStyle(el).animationPlayState)).toBe('running');
  // The screen scales the 1280×800 frame up to the stage, not down to a card.
  const screen = (await page.locator('.bp-screen').boundingBox())!;
  expect(screen.width).toBeGreaterThan(1100); expect(Math.abs(screen.width / screen.height - 1.6)).toBeLessThan(0.02);
  // Arrow keys move between tabs even while read-only; Enter does not switch.
  await tablist.getByRole('tab', { selected: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tablist.getByRole('tab', { name: /Example Domain/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await shot(page, 'p01-desktop-agent');
  // Pause when the page is hidden.
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect(page.locator('.bp-screen')).toHaveClass(/is-paused/);
  expect(await page.locator('.bp-ring b').evaluate(el => getComputedStyle(el).animationPlayState)).toBe('paused');
});

test('desktop: user control has a calm static border, live chrome, keyboard tag and layered Escape', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fx = await fixture(page, [agent]);
  await open(page);
  await page.getByRole('button', { name: '接手操作', exact: true }).click();
  await expect.poll(() => fx.control['takeover']).toBe(1);
  await expect(page.getByRole('status').filter({ hasText: '由你操作 · Mira 已暂停' })).toBeVisible();
  // Input stays fenced until a frame for the new epoch has rendered.
  fx.frame(2, 2); await expect.poll(() => fx.received.some(item => item.type === 'ack' && item.seq === 2)).toBe(true);
  await expect(page.locator('.bp-screen')).toHaveClass(/is-user/);
  await expect.poll(() => page.locator('.bp-clip').evaluate(el => getComputedStyle(el).outlineColor)).toBe('rgb(147, 194, 255)');
  await expect.poll(() => page.locator('.bp-ring').evaluate(el => getComputedStyle(el).opacity)).toBe('0');
  expect(await page.locator('.bp-ring b').evaluate(el => getComputedStyle(el).animationPlayState)).toBe('paused');
  const tablist = page.getByRole('tablist', { name: '标签页' });
  await expect(tablist).not.toHaveAttribute('aria-disabled', 'true');
  // A late title arrives as a list-only update: the label changes, the rendered frame (and input) stays valid.
  await expect(tablist.getByRole('tab').first()).toContainText('httpbin.org/forms/post');
  fx.sockets.at(-1)!.send(JSON.stringify({ type: 'tab_list', generation: 1, tabs: [{ ...tabs[0], title: 'HTTPBin form' }, tabs[1], tabs[2]] }));
  await expect(tablist.getByRole('tab').first()).toContainText('HTTPBin form');
  await expect(page.getByLabel('浏览器键盘输入，按 Escape 离开', { exact: true })).toBeEnabled();
  await tablist.getByRole('tab', { name: /Example Domain/ }).click();
  await expect.poll(() => fx.received.find(item => item.type === 'nav_tab')).toEqual({ type: 'nav_tab', tabId: 't2', epoch: 2 });
  fx.sockets.at(-1)!.send(JSON.stringify({ type: 'nav_done' }));
  const address = page.getByRole('textbox', { name: '浏览器地址' });
  await expect(address).toBeEditable();
  await address.fill('example.org'); await page.keyboard.press('Enter');
  await expect.poll(() => fx.received.find(item => item.type === 'nav_open')).toEqual({ type: 'nav_open', url: 'https://example.org/', epoch: 2 });
  fx.sockets.at(-1)!.send(JSON.stringify({ type: 'nav_done' }));
  await address.fill('file:///etc/passwd'); await page.getByRole('button', { name: '前往', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: '只支持 http 或 https 网址' })).toBeVisible();
  expect(fx.received.filter(item => item.type === 'nav_open')).toHaveLength(1);
  await page.locator('.browser-viewport canvas').click({ position: { x: 300, y: 200 } });
  await expect(page.locator('.bp-tag')).toHaveText('键盘已连接 · 按 Esc 释放');
  await expect(page.locator('.bp-foot')).toContainText('关闭此窗口不会自动交还');
  await shot(page, 'p02-desktop-human');
  // Esc first releases the keyboard only, then closes the panel.
  await page.keyboard.press('Escape');
  await expect(page.locator('.bp-tag')).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: '浏览器' })).toBeVisible();
  await page.getByRole('button', { name: '专注画面', exact: true }).click();
  await expect(page.getByRole('tablist', { name: '标签页' })).toHaveCount(0);
  await expect(page.locator('.bp-foot')).toHaveCount(0);
  await shot(page, 'p03-desktop-focus');
  await page.getByRole('button', { name: '退出专注画面', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '浏览器' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '浏览器', exact: true })).toBeFocused();
});

test('desktop: locked browser is amber and static; confirm defaults to 取消 and Escape returns focus', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await fixture(page, [{ ...agent, state: 'unknown', lock: 'outcome' }]);
  await open(page);
  await expect(page.getByRole('status').filter({ hasText: '状态待确认 · 只读' })).toBeVisible();
  await expect(page.getByText('上一次操作没有确认结果，浏览器已锁定。')).toBeVisible();
  await expect(page.locator('.bp-screen')).toHaveClass(/is-lock/);
  await expect.poll(() => page.locator('.bp-clip').evaluate(el => getComputedStyle(el).outlineColor)).toBe('rgb(154, 122, 69)');
  await expect(page.locator('.bp-ring')).toHaveCSS('opacity', '0');
  await expect(page.locator('.bp-tag')).toHaveText('只读查看 · 已锁定');
  await expect(page.getByText('已锁定 · 不能切换标签页或输入网址')).toBeVisible();
  const trigger = page.getByRole('button', { name: '关闭并重开浏览器', exact: true });
  await expect(trigger).toBeFocused();
  await trigger.click();
  const confirm = page.getByRole('alertdialog', { name: '关闭并重开这个浏览器？' });
  await expect(confirm).toContainText('会在 httpbin.org 打开一个全新的浏览器');
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await expect(confirm.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await shot(page, 'p04-desktop-locked-confirm');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('dialog', { name: '浏览器' })).toBeVisible();
});

test('desktop: held disconnected banner, empty state and browser switcher listbox', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fx = await fixture(page, []);
  await open(page);
  await expect(page.getByText('Mira 还没有打开浏览器')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '暂无浏览器' })).toBeVisible();
  await shot(page, 'p05-desktop-empty');
  await page.getByRole('button', { name: '关闭浏览器', exact: true }).click();
  fx.set([{ ...agent, state: 'held', epoch: 4 }, { id: 'b2', state: 'unknown', lock: 'outcome', epoch: 3, ownerLabel: 'Mira', domain: 'github.com' }]);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: fx.get() } }));
  await page.route('**/api/browser/*/ticket', route => route.fulfill({ status: 503, json: { error: 'down' } }));
  await page.getByRole('button', { name: '浏览器', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: '你仍保留控制权' })).toBeVisible();
  await expect(page.getByText('画面连接中断，你仍保留着控制权。')).toBeVisible();
  await expect(page.getByText('画面尚未连接')).toBeVisible();
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '交还 Mira', exact: true })).toBeVisible();
  await shot(page, 'p06-desktop-held-disconnected');
  const switcher = page.getByRole('button', { name: '切换浏览器，当前：Mira 的浏览器 1' });
  await switcher.click();
  const listbox = page.getByRole('listbox', { name: 'Mira 的浏览器' });
  await expect(listbox.getByRole('option')).toHaveCount(2);
  await expect(listbox.getByRole('option', { selected: true })).toContainText('Mira 的浏览器 1');
  await expect(listbox.getByRole('option').nth(1)).toContainText('github.com · 状态待确认');
  await shot(page, 'p07-desktop-switcher');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(listbox).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: '状态待确认 · 只读' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '浏览器' })).toBeVisible();
});

test('phone: fullscreen sheet, read-only tab rows, bottom action bar, tab sheet, 2× zoom and two-finger pan', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3211', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const fx = await fixture(page, [agent]);
  const dialog = await open(page);
  const box = (await dialog.boundingBox())!;
  expect(box.width).toBe(390); expect(box.height).toBe(844);
  await expect(page.getByRole('button', { name: '切换浏览器，当前：Mira 的浏览器 1' })).toContainText('浏览器 1');
  await expect(page.locator('.bp-pbar').getByRole('button', { name: '接手操作', exact: true })).toBeVisible();
  const bar = (await page.locator('.bp-pbar').boundingBox())!; expect(bar.y + bar.height).toBeCloseTo(844, 0);
  await expect(page.locator('.bp-tlist [role="tab"]')).toHaveCount(3);
  await expect(page.getByRole('button', { name: '标签页列表，共 3 个' })).toHaveText('3');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await shot(page, 'p08-phone-agent');
  await page.getByRole('button', { name: '接手操作', exact: true }).tap();
  await expect(page.locator('.bp-pbar').getByRole('status')).toHaveText('由你操作 · Mira 已暂停');
  fx.frame(2, 2); await expect.poll(() => fx.received.some(item => item.type === 'ack' && item.seq === 2)).toBe(true);
  await page.getByRole('button', { name: '标签页列表，共 3 个' }).tap();
  const sheet = page.getByRole('dialog', { name: '切换标签页' });
  await expect(sheet.getByRole('tab', { selected: true })).toBeFocused();
  const row = (await sheet.getByRole('tab').nth(1).boundingBox())!; expect(row.height).toBeGreaterThanOrEqual(44);
  await shot(page, 'p09-phone-tabs-sheet');
  await sheet.getByRole('tab').nth(2).tap();
  await expect.poll(() => fx.received.find(item => item.type === 'nav_tab')).toEqual({ type: 'nav_tab', tabId: 't3', epoch: 2 });
  await expect(sheet).toHaveCount(0);
  fx.sockets.at(-1)!.send(JSON.stringify({ type: 'nav_done' }));
  await page.getByRole('button', { name: '放大画面', exact: true }).tap();
  const screen = (await page.locator('.bp-screen').boundingBox())!; expect(screen.width).toBeGreaterThan(700);
  await page.locator('.browser-viewport canvas').tap({ position: { x: 120, y: 60 } });
  await expect(page.locator('.bp-tag')).toHaveText('键盘已连接 · 2× 放大');
  await expect.poll(() => fx.received.filter(item => item.type === 'input_mouse' && item.eventType === 'mousePressed').length).toBe(1);
  await expect(page.getByRole('button', { name: '释放键盘', exact: true })).toBeEnabled();
  await shot(page, 'p10-phone-human-zoomed');
  // Two fingers pan the zoomed stage and send nothing to the page.
  const pressed = fx.received.filter(item => item.type === 'input_mouse').length;
  const scrolled = await page.locator('.browser-viewport canvas').evaluate(canvas => {
    const stage = canvas.closest('.bp-stage')!; const before = stage.scrollLeft;
    const fire = (type: string, pointerId: number, x: number) => canvas.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId, pointerType: 'touch', clientX: x, clientY: 300, isPrimary: pointerId === 1 }));
    fire('pointerdown', 1, 300); fire('pointerdown', 2, 340); fire('pointermove', 1, 200); fire('pointermove', 2, 240); fire('pointerup', 1, 200); fire('pointerup', 2, 240);
    return stage.scrollLeft - before;
  });
  expect(scrolled).toBeGreaterThan(50);
  await page.waitForTimeout(200);
  expect(fx.received.filter(item => item.type === 'input_mouse').length).toBe(pressed);
  await page.getByRole('button', { name: '释放键盘', exact: true }).tap();
  await expect(page.locator('.bp-tag')).toHaveText('2× 放大');
  await context.close();
});

test('desktop: takeover of a locked browser is 409, shows the locked UI, and focuses reopen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const fx = await fixture(page, [agent]);
  await page.route('**/api/browser/*/takeover', async route => {
    fx.control['takeover'] = (fx.control['takeover'] ?? 0) + 1;
    const locked = { ...fx.get()[0]!, state: 'unknown', lock: 'outcome' };
    // Only the REST list knows about the lock (no mira_state push), so the panel
    // must refresh on the 409 itself rather than wait for the 2.5s poll.
    fx.set([locked]);
    await route.fulfill({ status: 409, contentType: 'application/json', json: { error: 'Browser is locked after an unconfirmed outcome; close and reopen it before taking over', code: 'browser_locked' } });
  });
  await open(page);
  await expect(page.getByRole('button', { name: '接手操作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '接手操作', exact: true }).click();
  await expect.poll(() => fx.control['takeover']).toBe(1);
  await expect(page.getByText('上一次操作没有确认结果，浏览器已锁定。')).toBeVisible({ timeout: 1500 });
  await expect(page.getByText('这个浏览器已锁定，不能接手。可以关闭并重开。')).toBeVisible();
  await expect(page.getByText('操作结果尚未确认')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.bp-screen')).toHaveClass(/is-lock/);
  const reopen = page.getByRole('button', { name: '关闭并重开浏览器', exact: true });
  await expect(reopen).toBeVisible();
  await expect(reopen).toBeFocused();
  await shot(page, 'fix-1-desktop-locked-takeover-409');
});

test('phone: zoom hint and button follow whether a frame is available', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3211', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const fx = await fixture(page, [agent]);
  await open(page);
  await expect(page.locator('.bp-tlist [role="tab"]')).toHaveCount(3);
  await expect(page.getByText('点右上角放大按钮可按 2 倍查看细节。')).toBeVisible();
  await shot(page, 'fix-2a-phone-connected-hint');
  const zoom = page.getByRole('button', { name: '放大画面', exact: true });
  await expect(zoom).toBeEnabled();
  await zoom.tap();
  await expect(page.getByRole('button', { name: '缩小画面', exact: true })).toBeEnabled();
  fx.set([{ ...agent, state: 'held', epoch: 1 }]);
  await fx.sockets.at(-1)!.close();
  await expect(page.getByText('点右上角放大按钮可按 2 倍查看细节。')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '放大画面', exact: true })).toBeDisabled();
  await expect(page.locator('.bp-tlist [role="tab"]')).toHaveCount(3);
  await shot(page, 'fix-2b-phone-disconnected-no-hint');
  await page.getByRole('button', { name: '重新连接', exact: true }).tap();
  await expect(page.getByText('点右上角放大按钮可按 2 倍查看细节。')).toBeVisible();
  await expect(page.getByRole('button', { name: '放大画面', exact: true })).toBeEnabled();
  await context.close();
});

test('reduced motion stops the sweep but keeps a static highlight', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3211', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  await fixture(page, [agent]);
  await open(page);
  await expect(page.locator('.bp-screen')).toHaveClass(/is-ai/);
  const ring = page.locator('.bp-ring b');
  expect(await ring.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  expect(await ring.evaluate(el => getComputedStyle(el).rotate)).toBe('40deg');
  await expect(page.locator('.bp-ring')).toHaveCSS('opacity', '1');
  await shot(page, 'p11-desktop-reduced-motion');
  await context.close();
});
