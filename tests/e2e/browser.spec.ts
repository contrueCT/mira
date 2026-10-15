import { expect, test } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';

test('browser settings: read-only, takeover, rendered-frame fence, input bridge, disconnect and explicit return', async ({ page }, testInfo) => {
  let status = { id: 'fixture-browser', state: 'agent', epoch: 1, ownerLabel: 'Mira', domain: 'example.test', cancelledInputs: 0 };
  const received: Record<string, unknown>[] = [];
  let socket: WebSocketRoute | undefined;
  let tickets = 0; let takeovers = 0; let returns = 0;
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [status] } }));
  await page.route('**/api/browser/fixture-browser/ticket', route => { tickets++; return route.fulfill({ json: { ticket: 'ephemeral-fixture-ticket', epoch: status.epoch } }); });
  await page.route('**/api/browser/fixture-browser/takeover', async route => { takeovers++; status = { ...status, state: 'requesting', epoch: 2 }; await route.fulfill({ json: status }); });
  await page.route('**/api/browser/fixture-browser/return', async route => { returns++; expect(route.request().postDataJSON()).toEqual({ epoch: status.epoch }); status = { ...status, state: 'agent', epoch: status.epoch + 1, cancelledInputs: 2 }; await route.fulfill({ json: status }); socket?.close(); });
  await page.routeWebSocket('**/api/browser/stream', ws => { socket = ws; ws.onMessage(message => received.push(JSON.parse(String(message)) as Record<string, unknown>)); ws.send(JSON.stringify({ type: 'mira_state', browser: status })); });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await expect(page.getByText('Mira 操作中 · 只读查看', { exact: true })).toBeVisible();
  await expect.poll(() => tickets).toBe(1);
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 600;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#f8fafc'; ctx.fillRect(0, 0, 1000, 600);
    ctx.fillStyle = '#253c59'; ctx.font = '32px sans-serif'; ctx.fillText('Example website', 60, 90);
    ctx.fillStyle = '#64748b'; ctx.font = '20px sans-serif'; ctx.fillText('Browser handoff fixture', 60, 135);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(60, 180, 600, 64); ctx.strokeStyle = '#cbd5e1'; ctx.strokeRect(60, 180, 600, 64);
    return canvas.toDataURL('image/jpeg').split(',')[1]!;
  });
  const frame = (seq: number, generation = 1, epoch = status.epoch) => socket!.send(JSON.stringify({ type: 'frame', seq, generation, epoch, data, metadata: { deviceWidth: 1000, deviceHeight: 600 } }));
  frame(1);
  await expect.poll(() => received.filter(item => item.type === 'ack').length).toBe(1);
  await page.locator('.browser-viewport canvas').click();
  expect(received.filter(item => item.type === 'input_mouse')).toHaveLength(0);
  await page.getByRole('button', { name: '接手操作', exact: true }).dblclick();
  await expect.poll(() => takeovers).toBe(1);
  await expect(page.getByText('等待当前操作结束', { exact: true })).toBeVisible();
  status = { ...status, state: 'human', epoch: 3 }; socket!.send(JSON.stringify({ type: 'mira_state', browser: status }));
  await expect(page.getByText('由你操作', { exact: true })).toBeVisible();
  frame(2); await expect.poll(() => received.some(item => item.type === 'ack' && item.seq === 2)).toBe(true);
  await page.getByRole('button', { name: '放大画面', exact: true }).click();
  await page.locator('.browser-viewport canvas').click({ position: { x: 100, y: 100 } });
  await expect.poll(() => received.some(item => item.type === 'input_mouse' && item.epoch === 3 && item.generation === 1 && item.frameSeq === 2)).toBe(true);
  const bridge = page.getByLabel('浏览器键盘输入，按 Escape 离开', { exact: true });
  await page.keyboard.type('private fixture text');
  await expect.poll(() => received.filter(item => item.type === 'input_text').map(item => item.text ?? '').join('')).toBe('private fixture text');
  await expect(bridge).toHaveValue('');
  await page.keyboard.press('Control+a');
  await expect.poll(() => received.some(item => item.type === 'input_key' && item.key === 'a' && item.modifiers === 2)).toBe(true);
  // Synthetic composition/paste checks only. This does not certify a native OS IME.
  await bridge.evaluate(element => {
    element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中文' }));
    const transfer = new DataTransfer(); transfer.setData('text/plain', 'paste fixture');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  await expect.poll(() => received.some(item => item.text === '中文')).toBe(true);
  await expect.poll(() => received.some(item => item.text === 'paste fixture')).toBe(true);
  await expect(bridge).toHaveValue('');
  // Captured drags beyond all four edges still send bounded release events.
  const bounds = await page.locator('.browser-viewport canvas').boundingBox(); if (!bounds) throw Error('Missing canvas');
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  for (const target of [{ x: bounds.x - 20, y: center.y }, { x: bounds.x + bounds.width + 20, y: center.y }, { x: center.x, y: bounds.y - 20 }, { x: center.x, y: bounds.y + bounds.height + 20 }]) {
    const releases = received.filter(item => item.eventType === 'mouseReleased').length;
    await page.mouse.move(center.x, center.y); await page.mouse.down(); await page.mouse.move(target.x, target.y); await page.mouse.up();
    await expect.poll(() => received.filter(item => item.eventType === 'mouseReleased').length).toBe(releases + 1);
    const release = received.filter(item => item.eventType === 'mouseReleased').at(-1)!;
    expect(Number(release.x)).toBeGreaterThanOrEqual(0); expect(Number(release.x)).toBeLessThanOrEqual(1000);
    expect(Number(release.y)).toBeGreaterThanOrEqual(0); expect(Number(release.y)).toBeLessThanOrEqual(600);
    await expect(bridge).toBeEnabled();
  }
  await page.screenshot({ path: testInfo.outputPath('mira-browser-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mira-browser-narrow.png'), fullPage: true });
  socket!.send(JSON.stringify({ type: 'tabs', tabs: [{ active: true, domain: 'example.test' }], generation: 2 }));
  await expect(bridge).toBeDisabled(); frame(3, 1);
  await page.waitForTimeout(50); expect(received.some(item => item.type === 'ack' && item.seq === 3)).toBe(false);
  frame(4, 2); await expect(bridge).toBeEnabled();
  socket!.close(); status = { ...status, state: 'held', epoch: 4 };
  await expect(page.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  expect(returns).toBe(0);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('连接中断 · 已保留你的控制权', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '交还 Mira', exact: true }).click();
  await expect.poll(() => returns).toBe(1);
  await expect(page.getByText('已取消 2 条尚未发送的输入。请核对页面结果，不要重复提交。')).toBeVisible();
  await expect(page.getByText('Mira 操作中 · 只读查看', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(returns).toBe(1);
});

test('browser settings empty/error states and canceled late ticket cannot open a socket', async ({ page }) => {
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [] } }));
  await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await expect(page.getByText('还没有活动的浏览器。Mira 使用浏览器时会显示在这里。')).toBeVisible();
  await page.route('**/api/browser', route => route.fulfill({ status: 503, json: { error: 'not exposed' } }));
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect(page.getByText('暂时无法读取浏览器状态，请重试。')).toBeVisible();
  let resolveTicket: (() => void) | undefined;
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [{ id: 'late', state: 'agent', epoch: 1, ownerLabel: 'Mira', domain: null }] } }));
  await page.route('**/api/browser/late/ticket', async route => { await new Promise<void>(resolve => { resolveTicket = resolve; }); await route.fulfill({ json: { ticket: 'late-ticket', epoch: 1 } }).catch(() => {}); });
  let sockets = 0; await page.routeWebSocket('**/api/browser/stream', () => { sockets++; });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await expect.poll(() => !!resolveTicket).toBe(true);
  await page.getByRole('tab', { name: '模型', exact: true }).click(); resolveTicket!();
  await page.waitForTimeout(100); expect(sockets).toBe(0);
});
