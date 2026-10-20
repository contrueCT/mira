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

for (const interruption of ['pointercancel', 'lostpointercapture', 'return'] as const) {
  test(`browser ${interruption} while pressed preserves the remote button until explicit release`, async ({ page }) => {
    let status = { id: 'pressed-browser', state: 'human', epoch: 1, ownerLabel: 'Mira', domain: 'example.test', pressedButtons: [] as string[] };
    const received: Record<string, unknown>[] = [];
    let socket: WebSocketRoute | undefined;
    let returns = 0;
    await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [status] } }));
    await page.route('**/api/browser/pressed-browser/ticket', route => route.fulfill({ json: { ticket: 'pressed-ticket', epoch: status.epoch } }));
    await page.route('**/api/browser/pressed-browser/return', async route => {
      expect(route.request().postDataJSON()).toEqual({ epoch: status.epoch }); returns++;
      status = { ...status, state: status.pressedButtons.length ? 'held' : 'agent', epoch: status.epoch + 1 };
      await route.fulfill({ json: status }); socket!.close();
    });
    await page.route('**/api/browser/pressed-browser/takeover', async route => {
      status = { ...status, state: 'human', epoch: status.epoch + 1 }; await route.fulfill({ json: status });
    });
    await page.routeWebSocket('**/api/browser/stream', ws => {
      socket = ws;
      ws.onMessage(message => {
        const input = JSON.parse(String(message)) as Record<string, unknown>; received.push(input);
        if (input.eventType === 'mousePressed') status = { ...status, pressedButtons: ['left'] };
        else if (input.eventType === 'mouseReleased' || input.type === 'input_release') status = { ...status, pressedButtons: [] };
        else return;
        // Reflect production's status update after each accepted mouse command.
        ws.send(JSON.stringify({ type: 'mira_state', browser: status }));
      });
      ws.send(JSON.stringify({ type: 'mira_state', browser: status }));
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '浏览器', exact: true }).click();
    await expect.poll(() => !!socket).toBe(true);
    const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 600; return canvas.toDataURL('image/jpeg').split(',')[1]!; });
    const frame = async (seq: number) => {
      socket!.send(JSON.stringify({ type: 'frame', seq, generation: 1, epoch: status.epoch, data, metadata: { deviceWidth: 1000, deviceHeight: 600 } }));
      await expect.poll(() => received.some(input => input.type === 'ack' && input.seq === seq)).toBe(true);
    };
    await frame(1);
    const canvas = page.locator('.browser-viewport canvas');
    await canvas.evaluate(element => {
      element.addEventListener('pointerdown', event => { element.dataset['pointerId'] = String((event as PointerEvent).pointerId); }, { once: true });
      for (const type of ['pointercancel', 'lostpointercapture']) element.addEventListener(type, () => { element.dataset[type] = 'seen'; });
    });
    const bounds = await canvas.boundingBox(); if (!bounds) throw Error('Missing canvas');
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(center.x, center.y); await page.mouse.down();
    await expect.poll(() => status.pressedButtons).toEqual(['left']);
    await expect(page.getByRole('button', { name: '松开左键', exact: true })).toBeVisible();
    if (interruption !== 'return') {
      await page.mouse.move(center.x + 1, center.y);
      expect(await canvas.evaluate(element => element.hasPointerCapture(Number(element.dataset['pointerId'])))).toBe(true);
      await canvas.evaluate((element, type) => {
        const pointerId = Number(element.dataset['pointerId']);
        if (type === 'lostpointercapture') element.releasePointerCapture(pointerId);
        else element.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId, button: 0, buttons: 1 }));
      }, interruption);
      // A real pointer event flushes pending native capture loss in Chromium.
      await page.mouse.move(center.x + 2, center.y);
      await expect(canvas).toHaveAttribute(`data-${interruption}`, 'seen');
    }
    await frame(2); // Flush preceding socket input before checking that no release was invented.
    expect(received.filter(input => input.eventType === 'mouseReleased' || input.type === 'input_release')).toEqual([]);
    await page.getByRole('button', { name: '交还 Mira', exact: true }).evaluate(element => (element as HTMLElement).click());
    await expect.poll(() => status.state).toBe('held');
    await page.mouse.up();
    await expect(page.getByText('连接中断 · 已保留你的控制权', { exact: true })).toBeVisible();
    expect(status.pressedButtons).toEqual(['left']); expect(returns).toBe(1);
    expect(received.filter(input => input.eventType === 'mouseReleased' || input.type === 'input_release')).toEqual([]);
    await page.getByRole('button', { name: '继续接手', exact: true }).click();
    const previousSocket = socket;
    await page.getByRole('button', { name: '重新连接', exact: true }).click();
    await expect.poll(() => socket !== previousSocket).toBe(true); await frame(3);
    await page.getByRole('button', { name: '松开左键', exact: true }).click();
    await expect.poll(() => status.pressedButtons).toEqual([]);
    expect(received.filter(input => input.type === 'input_release')).toHaveLength(1);
    await page.getByRole('button', { name: '交还 Mira', exact: true }).click();
    await expect.poll(() => status.state).toBe('agent'); expect(returns).toBe(2);
  });
}

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

for (const stale of [{ state: 'agent', epoch: 1 }, { state: 'requesting', epoch: 2 }]) {
  test(`delayed ${stale.state} poll cannot replace a newer rendered human lease`, async ({ page }) => {
    let status = { id: 'poll-browser', state: stale.state, epoch: stale.epoch, ownerLabel: 'Mira', domain: 'example.test' };
    let defer = false;
    let release: (() => Promise<void>) | undefined;
    let socket: WebSocketRoute | undefined;
    const received: Record<string, unknown>[] = [];
    await page.route('**/api/browser', async route => {
      const snapshot = { ...status };
      if (defer) { defer = false; await new Promise<void>(resolve => { release = async () => { await route.fulfill({ json: { browsers: [snapshot] } }); resolve(); }; }); }
      else await route.fulfill({ json: { browsers: [snapshot] } });
    });
    await page.route('**/api/browser/poll-browser/ticket', route => route.fulfill({ json: { ticket: 'poll-ticket', epoch: status.epoch } }));
    await page.routeWebSocket('**/api/browser/stream', ws => { socket = ws; ws.onMessage(message => received.push(JSON.parse(String(message)) as Record<string, unknown>)); });
    await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '浏览器', exact: true }).click();
    await expect.poll(() => !!socket).toBe(true);
    defer = true; await page.getByRole('button', { name: '刷新', exact: true }).click();
    await expect.poll(() => !!release).toBe(true);
    status = { ...status, state: 'human', epoch: 2 };
    socket!.send(JSON.stringify({ type: 'mira_state', browser: status }));
    await expect(page.getByText('由你操作', { exact: true })).toBeVisible();
    const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100; return canvas.toDataURL('image/jpeg').split(',')[1]!; });
    socket!.send(JSON.stringify({ type: 'frame', seq: 1, generation: 1, epoch: 2, data, metadata: { deviceWidth: 100, deviceHeight: 100 } }));
    await expect.poll(() => received.some(item => item.type === 'ack')).toBe(true);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser');
    await release!(); await response;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('由你操作', { exact: true })).toBeVisible();
    await page.locator('.browser-viewport canvas').click();
    await expect.poll(() => received.some(item => item.type === 'input_mouse' && item.epoch === 2 && item.frameSeq === 1)).toBe(true);
    await expect(page.getByLabel('浏览器键盘输入，按 Escape 离开', { exact: true })).toBeEnabled();
  });
}

test('header browser entry sits immediately left of Settings and opens Mira’s own browser directly on desktop and phone', async ({ page }, testInfo) => {
  const task = { id: 'task-browser', state: 'agent', epoch: 1, ownerLabel: 'Task', domain: 'task.test' };
  let mira = { id: 'mira-browser', state: 'agent', epoch: 1, ownerLabel: 'Mira', domain: 'example.test' };
  let takeovers = 0; const tickets: string[] = [];
  // Task's browser is listed first; the header entry must still select Mira's own.
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [task, mira] } }));
  await page.route('**/api/browser/*/ticket', route => { tickets.push(route.request().url()); return route.fulfill({ json: { ticket: 'fixture-ticket', epoch: 1 } }); });
  await page.route('**/api/browser/mira-browser/takeover', async route => { takeovers++; mira = { ...mira, state: 'requesting', epoch: 2 }; await route.fulfill({ json: mira }); });
  await page.routeWebSocket('**/api/browser/stream', ws => { ws.send(JSON.stringify({ type: 'mira_state', browser: mira })); });
  for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport); await page.goto('/');
    const entry = page.getByRole('button', { name: '浏览器', exact: true });
    const settings = page.getByRole('button', { name: '模型设置', exact: true });
    await expect(entry).toBeVisible();
    const a = (await entry.boundingBox())!; const b = (await settings.boundingBox())!;
    expect(Math.abs(a.y - b.y), 'same row').toBeLessThanOrEqual(1);
    expect(a.x + a.width, 'left of Settings').toBeLessThanOrEqual(b.x);
    expect(b.x - (a.x + a.width), 'adjacent').toBeLessThanOrEqual(8);
    expect(a.width).toBeGreaterThanOrEqual(36); expect(a.height).toBeGreaterThanOrEqual(36);
    const identity = (await page.locator('.identity').boundingBox())!;
    const ring = await page.locator('.mira-ring').boundingBox();
    for (const box of [ring, (await page.locator('.identity h1').boundingBox())!].filter(Boolean)) {
      const overlap = a.x < box!.x + box!.width && box!.x < a.x + a.width && a.y < box!.y + box!.height && box!.y < a.y + a.height;
      expect(overlap, `${viewport.width}: no overlap with the identity`).toBe(false);
    }
    expect(identity.width).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // Icon (non-text) contrast ≥ 3:1 against the header.
    const iconContrast = await entry.evaluate(element => {
      const parse = (c: string) => (c.match(/[\d.]+/g) ?? []).map(Number);
      const lum = ([r, g, b]: number[]) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!); };
      const x = lum(parse(getComputedStyle(element).color)), y = lum(parse(getComputedStyle(element.closest('header')!).backgroundColor));
      return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
    });
    expect(iconContrast).toBeGreaterThanOrEqual(3);
    // Keyboard: Tab order reaches the browser entry right before Settings; Enter opens it.
    await settings.focus(); await page.keyboard.press('Shift+Tab'); await expect(entry).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath(`header-browser-entry-${viewport.width}.png`) });
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: '浏览器' });
    await expect(dialog).toBeVisible(); expect(new URL(page.url()).hash).toBe('#browser');
    await expect(page.getByRole('button', { name: '关闭浏览器', exact: true })).toBeFocused();
    await expect(dialog.getByRole('combobox')).toHaveValue('mira-browser');
    await expect(dialog.getByText('Mira 操作中 · 只读查看', { exact: true })).toBeVisible();
    await expect.poll(() => tickets.some(url => url.includes('/mira-browser/'))).toBe(true);
    expect(await page.evaluate(() => { const d = document.querySelector('dialog')!.getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth + 0.5; })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`browser-dialog-${viewport.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0); await expect(entry).toBeFocused(); expect(new URL(page.url()).hash).toBe('');
  }
  // Take over from the direct entry; history back closes the dialog without returning control.
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await page.getByRole('button', { name: '浏览器', exact: true }).click();
  await page.getByRole('button', { name: '接手操作', exact: true }).click();
  await expect.poll(() => takeovers).toBe(1);
  await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0);
  // A reload at #browser reopens the same dialog; Settings still offers its browser tab.
  await page.goto('/#browser'); await expect(page.getByRole('dialog', { name: '浏览器' })).toBeVisible();
  await page.getByRole('button', { name: '关闭浏览器', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.getByRole('tab', { name: '浏览器', exact: true }).click();
  await expect(page.getByRole('heading', { name: '浏览器', level: 3 })).toBeVisible();
});
