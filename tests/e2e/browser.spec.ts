import { expect, test } from '@playwright/test';
import type { WebSocketRoute } from '@playwright/test';

test('native mouse double-click reaches a remote CDP page with matching press/release counts', async ({ page, context }) => {
  const remote = await context.newPage();
  await remote.setViewportSize({ width: 1000, height: 600 });
  await remote.setContent('<button style="position:fixed;inset:0;width:100%;height:100%">Double click target</button><pre id="events">[]</pre><script>const events=[]; for (const type of ["mousedown","mouseup","click","dblclick"]) document.querySelector("button").addEventListener(type,event=>{events.push({type:event.type,detail:event.detail});document.querySelector("#events").textContent=JSON.stringify(events)});</script>');
  const cdp = await context.newCDPSession(remote);
  const data = (await remote.screenshot({ type: 'jpeg' })).toString('base64');
  const status = { id: 'double-click', state: 'human', epoch: 1, ownerLabel: 'Mira', domain: 'example.test' };
  const received: Record<string, unknown>[] = [];
  let dispatch = Promise.resolve();
  let dispatchError: unknown;
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [status] } }));
  await page.route('**/api/browser/double-click/ticket', route => route.fulfill({ json: { ticket: 'double-click-ticket', epoch: 1 } }));
  await page.routeWebSocket('**/api/browser/stream', ws => {
    ws.onMessage(value => {
      const input = JSON.parse(String(value)) as Record<string, unknown>; received.push(input);
      if (input.type !== 'input_mouse') return;
      dispatch = dispatch.then(async () => { await cdp.send('Input.dispatchMouseEvent', {
        type: input.eventType as 'mousePressed' | 'mouseReleased' | 'mouseMoved',
        x: Number(input.x), y: Number(input.y), button: input.button as 'none' | 'left' | 'middle' | 'right',
        clickCount: Number(input.clickCount), modifiers: Number(input.modifiers),
      }); }).catch(error => { dispatchError = error; });
    });
    ws.send(JSON.stringify({ type: 'mira_state', browser: status }));
    ws.send(JSON.stringify({ type: 'frame', seq: 1, generation: 1, epoch: 1, data, metadata: { deviceWidth: 1000, deviceHeight: 600 } }));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/#browser');
  await expect.poll(() => received.some(input => input.type === 'ack')).toBe(true);
  await page.locator('.browser-viewport canvas').dblclick({ position: { x: 100, y: 100 } });
  await expect.poll(() => received.filter(input => input.eventType === 'mouseReleased').length).toBe(2);
  await dispatch;
  expect(dispatchError).toBeUndefined();
  expect(received.filter(input => ['mousePressed', 'mouseReleased'].includes(String(input.eventType))).map(input => [input.eventType, input.clickCount])).toEqual([
    ['mousePressed', 1], ['mouseReleased', 1], ['mousePressed', 2], ['mouseReleased', 2],
  ]);
  expect(await remote.locator('#events').textContent()).toBe(JSON.stringify([
    { type: 'mousedown', detail: 1 }, { type: 'mouseup', detail: 1 }, { type: 'click', detail: 1 },
    { type: 'mousedown', detail: 2 }, { type: 'mouseup', detail: 2 }, { type: 'click', detail: 2 }, { type: 'dblclick', detail: 2 },
  ]));
  await remote.close();
});

for (const releaseOrder of [['right', 'left'], ['left', 'right']] as const) {
  test(`native mouse chord releases ${releaseOrder.join(' then ')} outside the canvas without leaving a remote button pressed`, async ({ page, context }) => {
    const remote = await context.newPage();
    await remote.setViewportSize({ width: 1000, height: 600 });
    await remote.setContent('<main style="position:fixed;inset:0">Mouse chord target</main><pre id="events">{"events":[],"pressed":[]}</pre><script>const events=[],pressed=new Set();document.addEventListener("contextmenu",event=>event.preventDefault());for(const type of ["mousedown","mouseup"])document.addEventListener(type,event=>{events.push({type:event.type,button:event.button,detail:event.detail});if(type==="mousedown")pressed.add(event.button);else pressed.delete(event.button);document.querySelector("#events").textContent=JSON.stringify({events,pressed:[...pressed]})});</script>');
    const cdp = await context.newCDPSession(remote);
    const data = (await remote.screenshot({ type: 'jpeg' })).toString('base64');
    let status = { id: 'mouse-chord', state: 'human', epoch: 1, ownerLabel: 'Mira', domain: 'example.test', pressedButtons: [] as string[] };
    const received: Record<string, unknown>[] = [];
    let dispatch = Promise.resolve(); let dispatchError: unknown;
    await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [status] } }));
    await page.route('**/api/browser/mouse-chord/ticket', route => route.fulfill({ json: { ticket: 'mouse-chord-ticket', epoch: 1 } }));
    await page.routeWebSocket('**/api/browser/stream', ws => {
      ws.onMessage(value => {
        const input = JSON.parse(String(value)) as Record<string, unknown>; received.push(input);
        if (input.type !== 'input_mouse') return;
        dispatch = dispatch.then(async () => {
          await cdp.send('Input.dispatchMouseEvent', { type: input.eventType as 'mousePressed' | 'mouseReleased' | 'mouseMoved', x: Number(input.x), y: Number(input.y), button: input.button as 'none' | 'left' | 'middle' | 'right', clickCount: Number(input.clickCount), modifiers: Number(input.modifiers) });
          if (input.eventType === 'mousePressed') status = { ...status, pressedButtons: [...new Set([...status.pressedButtons, String(input.button)])] };
          else if (input.eventType === 'mouseReleased') status = { ...status, pressedButtons: status.pressedButtons.filter(button => button !== input.button) };
          ws.send(JSON.stringify({ type: 'mira_state', browser: status }));
        }).catch(error => { dispatchError = error; });
      });
      ws.send(JSON.stringify({ type: 'mira_state', browser: status }));
      ws.send(JSON.stringify({ type: 'frame', seq: 1, generation: 1, epoch: 1, data, metadata: { deviceWidth: 1000, deviceHeight: 600 } }));
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/#browser');
    await expect.poll(() => received.some(input => input.type === 'ack')).toBe(true);
    const canvas = page.locator('.browser-viewport canvas');
    const bounds = await canvas.boundingBox(); if (!bounds) throw Error('Missing canvas');
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down({ button: 'left' }); await page.mouse.down({ button: 'right' });
    await expect.poll(() => status.pressedButtons).toEqual(['left', 'right']);
    await page.mouse.move(bounds.x - 20, bounds.y + bounds.height / 2);
    for (const button of releaseOrder) await page.mouse.up({ button });
    await expect.poll(() => received.filter(input => input.eventType === 'mouseReleased').length).toBe(2);
    await dispatch; expect(dispatchError).toBeUndefined();
    expect(received.filter(input => ['mousePressed', 'mouseReleased'].includes(String(input.eventType))).map(input => [input.eventType, input.button, input.clickCount])).toEqual([
      ['mousePressed', 'left', 1], ['mousePressed', 'right', 1], ...releaseOrder.map(button => ['mouseReleased', button, 1]),
    ]);
    const remoteResult = JSON.parse((await remote.locator('#events').textContent())!) as { events: { type: string; button: number; detail: number }[]; pressed: number[] };
    // Chromium may report mouseup.detail=0 for a chord that ended outside the
    // press location; the protocol above still pairs each key's original count.
    expect(remoteResult.events.map(({ type, button }) => ({ type, button }))).toEqual([
      { type: 'mousedown', button: 0 }, { type: 'mousedown', button: 2 },
      ...releaseOrder.map(button => ({ type: 'mouseup', button: button === 'left' ? 0 : 2 })),
    ]);
    expect(remoteResult.pressed).toEqual([]); expect(status.pressedButtons).toEqual([]);
    await expect(page.getByRole('button', { name: /^松开/ })).toHaveCount(0);
    await remote.close();
  });
}

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
  await expect(page.getByText('Mira 正在操作 · 你在旁观', { exact: true })).toBeVisible();
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
  await expect(page.getByText('等待当前操作结束…', { exact: true })).toBeVisible();
  status = { ...status, state: 'human', epoch: 3 }; socket!.send(JSON.stringify({ type: 'mira_state', browser: status }));
  await expect(page.getByText('由你操作 · Mira 已暂停', { exact: true })).toBeVisible();
  frame(2); await expect.poll(() => received.some(item => item.type === 'ack' && item.seq === 2)).toBe(true);
  await page.getByRole('button', { name: '专注画面', exact: true }).click();
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
  // The scheduled status poll (no refresh button) reports the held lease.
  await expect(page.getByText('你仍保留控制权', { exact: true })).toBeVisible();
  await expect(page.getByText('画面连接中断，你仍保留着控制权。')).toBeVisible();
  await expect(page.getByText(/画面连接已断开/)).toHaveCount(0); // not repeated as an error
  await page.getByRole('button', { name: '交还 Mira', exact: true }).click();
  await expect.poll(() => returns).toBe(1);
  await expect(page.getByText('已取消 2 条尚未发送的输入。请核对页面结果，不要重复提交。')).toBeVisible();
  await expect(page.getByText('Mira 正在操作 · 你在旁观', { exact: true })).toBeVisible();
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
    const originalSocket = socket;
    await page.getByRole('button', { name: '交还 Mira', exact: true }).evaluate(element => (element as HTMLElement).click());
    await expect.poll(() => status.state).toBe('held');
    await page.mouse.up();
    await expect(page.getByText('你仍保留控制权', { exact: true })).toBeVisible();
    expect(status.pressedButtons).toEqual(['left']); expect(returns).toBe(1);
    expect(received.filter(input => input.eventType === 'mouseReleased' || input.type === 'input_release')).toEqual([]);
    // The user's own return closed the epoch-bound stream; the panel follows
    // the new epoch by itself (no manual reconnect) and stays read-only until
    // the user explicitly continues.
    await expect.poll(() => socket !== originalSocket).toBe(true);
    await expect(page.getByRole('button', { name: '重新连接', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '继续接手', exact: true }).click();
    await expect(page.getByText('由你操作 · Mira 已暂停', { exact: true })).toBeVisible(); await frame(3);
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
  await expect(page.getByText('Mira 还没有打开浏览器')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '暂无浏览器' })).toBeVisible();
  await page.route('**/api/browser', route => route.fulfill({ status: 503, json: { error: 'not exposed' } }));
  // Status is polled; the redesign has no separate refresh button.
  await expect(page.getByText('暂时无法读取浏览器状态，请重试。')).toBeVisible();
  let resolveTicket: (() => void) | undefined;
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [{ id: 'late', state: 'agent', epoch: 1, ownerLabel: 'Mira', domain: null }] } }));
  await page.route('**/api/browser/late/ticket', async route => { await new Promise<void>(resolve => { resolveTicket = resolve; }); await route.fulfill({ json: { ticket: 'late-ticket', epoch: 1 } }).catch(() => {}); });
  let sockets = 0; await page.routeWebSocket('**/api/browser/stream', () => { sockets++; });
  await page.getByRole('button', { name: '重试', exact: true }).click();
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
    defer = true; // the next scheduled status poll is held back
    await expect.poll(() => !!release).toBe(true);
    status = { ...status, state: 'human', epoch: 2 };
    socket!.send(JSON.stringify({ type: 'mira_state', browser: status }));
    await expect(page.getByText('由你操作 · Mira 已暂停', { exact: true })).toBeVisible();
    const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 100; return canvas.toDataURL('image/jpeg').split(',')[1]!; });
    socket!.send(JSON.stringify({ type: 'frame', seq: 1, generation: 1, epoch: 2, data, metadata: { deviceWidth: 100, deviceHeight: 100 } }));
    await expect.poll(() => received.some(item => item.type === 'ack')).toBe(true);
    const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/browser');
    await release!(); await response;
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByText('由你操作 · Mira 已暂停', { exact: true })).toBeVisible();
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
    await expect(dialog.getByRole('button', { name: '接手操作', exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: '切换浏览器，当前：Mira 的浏览器 1' })).toBeVisible();
    await expect(dialog.getByText('Mira 正在操作 · 你在旁观', { exact: true })).toBeVisible();
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

test('locked outcome browser is read-only, and the user can close and reopen it', async ({ page }) => {
  const locked = { id: 'lost', state: 'unknown', lock: 'outcome', epoch: 3, ownerLabel: 'Mira', domain: 'example.test', message: 'Browser outcome unknown. Do not replay commands. Close this browser and explicitly open a new one.' };
  let browsers: Array<Record<string, unknown>> = [locked];
  const received: Record<string, unknown>[] = [];
  let socket: WebSocketRoute | undefined; let tickets = 0; let reopenBody: unknown;
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers } }));
  await page.route('**/api/browser/lost/ticket', route => { tickets++; return route.fulfill({ json: { ticket: 'locked-ticket', epoch: locked.epoch } }); });
  await page.route('**/api/browser/fresh-browser/ticket', route => route.fulfill({ json: { ticket: 'fresh-ticket', epoch: 0 } }));
  await page.route('**/api/browser/lost/reopen', async route => {
    reopenBody = route.request().postDataJSON();
    const fresh = { id: 'fresh-browser', state: 'agent', epoch: 0, ownerLabel: 'Mira', domain: 'example.test', replaces: 'lost' };
    browsers = [{ ...locked, state: 'closed', replacedBy: 'fresh-browser', epoch: 4 }, fresh];
    await route.fulfill({ json: fresh });
  });
  await page.routeWebSocket('**/api/browser/stream', ws => { socket = ws; ws.onMessage(message => received.push(JSON.parse(String(message)) as Record<string, unknown>)); ws.send(JSON.stringify({ type: 'mira_state', browser: locked })); });
  await page.goto('/'); await page.getByRole('button', { name: '浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '浏览器' });
  await expect(dialog.getByText('状态待确认 · 只读', { exact: true })).toBeVisible();
  await expect(dialog.getByText('上一次操作没有确认结果，浏览器已锁定。')).toBeVisible();
  await expect(dialog.getByText(/Browser outcome unknown/)).toHaveCount(0);
  for (const name of ['接手操作', '交还 Mira']) await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
  await expect.poll(() => tickets).toBeGreaterThan(0);
  await expect.poll(() => socket !== undefined).toBe(true);
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 20;
    const ctx = canvas.getContext('2d')!; ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 40, 20);
    return canvas.toDataURL('image/jpeg').split(',')[1]!;
  });
  socket!.send(JSON.stringify({ type: 'frame', seq: 1, generation: 1, epoch: locked.epoch, data, metadata: { deviceWidth: 40, deviceHeight: 20 } }));
  await expect.poll(() => received.some(item => item.type === 'ack')).toBe(true);
  const canvas = dialog.locator('.browser-viewport canvas');
  await expect(canvas).not.toHaveClass(/browser-canvas-empty/);
  await expect.poll(() => canvas.evaluate(element => (element as HTMLCanvasElement).width)).toBeGreaterThan(0);
  await canvas.click(); await page.keyboard.type('secret-locked');
  await page.waitForTimeout(150);
  expect(received.filter(item => String(item.type).startsWith('input_'))).toHaveLength(0);
  socket!.close();
  await expect(dialog.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '接手操作', exact: true })).toHaveCount(0);
  const reopen = dialog.getByRole('button', { name: '关闭并重开浏览器', exact: true });
  await reopen.click();
  const confirm = dialog.getByRole('button', { name: '确认关闭并重开', exact: true });
  // The destructive confirmation defaults to 取消 (design §3).
  await expect(dialog.getByRole('alertdialog').getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await expect(dialog.getByText(/会在 example\.test 打开一个全新的浏览器/)).toBeVisible();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  await expect(reopen).toBeFocused();
  await reopen.click(); await confirm.click();
  await expect.poll(() => reopenBody).toEqual({ epoch: locked.epoch });
  await expect(dialog.getByRole('button', { name: '接手操作', exact: true })).toBeVisible();
  await expect(dialog.getByRole('status').filter({ hasText: 'Mira 正在操作 · 你在旁观' })).toBeVisible();
  await dialog.getByRole('button', { name: /^切换浏览器/ }).click();
  // The replaced (closed) browser is hidden; only the fresh one is listed.
  await expect(dialog.getByRole('option')).toHaveCount(1);
  await expect(dialog.getByRole('option')).toHaveAttribute('aria-selected', 'true');
});

test('reopen reports a stale lock in Chinese with the HTTP detail', async ({ page }) => {
  const locked = { id: 'lost', state: 'unknown', lock: 'outcome', epoch: 3, ownerLabel: 'Mira', domain: 'example.test', message: 'Browser outcome unknown. Do not replay commands. Close this browser and explicitly open a new one.' };
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [locked] } }));
  await page.route('**/api/browser/lost/ticket', route => route.fulfill({ json: { ticket: 'locked-ticket', epoch: locked.epoch } }));
  await page.route('**/api/browser/lost/reopen', route => route.fulfill({ status: 409, json: { error: 'Browser is not locked in an indeterminate state or the view is stale; refresh and retry' } }));
  await page.routeWebSocket('**/api/browser/stream', ws => { ws.send(JSON.stringify({ type: 'mira_state', browser: locked })); });
  await page.goto('/'); await page.getByRole('button', { name: '浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '浏览器' });
  await dialog.getByRole('button', { name: '关闭并重开浏览器', exact: true }).click();
  await dialog.getByRole('button', { name: '确认关闭并重开', exact: true }).click();
  const alert = dialog.getByRole('alert');
  await expect(alert).toContainText('内容已被其他操作更新');
  await expect(alert).toContainText('HTTP 409');
  await expect(dialog.getByRole('button', { name: '确认关闭并重开', exact: true })).toHaveCount(0);
});

for (const outcome of ['success', 'cleanup failure'] as const) {
  test(`reopen survives the production closed notification before ${outcome}`, async ({ page }) => {
    let status: Record<string, unknown> = { id: 'closing', state: 'unknown', lock: 'outcome', epoch: 3, ownerLabel: 'Mira', domain: 'example.test' };
    let browsers = [status];
    let socket: WebSocketRoute | undefined;
    let attempts = 0; let finishReopen: (() => void) | undefined;
    await page.route('**/api/browser', route => route.fulfill({ json: { browsers } }));
    await page.route('**/api/browser/*/ticket', route => route.fulfill({ json: { ticket: 'closing-ticket', epoch: status.epoch } }));
    await page.route('**/api/browser/closing/reopen', async route => {
      attempts++;
      await new Promise<void>(resolve => { finishReopen = resolve; });
      if (outcome === 'cleanup failure' && attempts === 1) return route.fulfill({ status: 503, json: { error: 'Browser cleanup failed' } });
      const fresh = { id: 'replacement', state: 'agent', epoch: 0, ownerLabel: 'Mira', domain: 'example.test', replaces: 'closing' };
      browsers = [{ ...status, state: 'closed', replacedBy: fresh.id }, fresh];
      await route.fulfill({ json: fresh });
    });
    await page.routeWebSocket('**/api/browser/stream', ws => { socket = ws; ws.send(JSON.stringify({ type: 'mira_state', browser: status })); });
    await page.goto('/#browser');
    await expect.poll(() => !!socket).toBe(true);
    await page.getByRole('button', { name: '关闭并重开浏览器', exact: true }).click();
    await page.getByRole('button', { name: '确认关闭并重开', exact: true }).click();
    await expect.poll(() => attempts).toBe(1);
    // Production closes/invalidate the old stream before driver.close finishes.
    status = { ...status, state: 'closed', epoch: 4 }; browsers = [status];
    socket!.send(JSON.stringify({ type: 'mira_state', browser: status })); socket!.close();
    await expect(page.locator('.bp-status')).toHaveText('浏览器已关闭');
    await expect(page.locator('.bp-placeholder')).toHaveText('这个浏览器已关闭');
    if (outcome === 'cleanup failure') {
      status = { ...status, state: 'unknown', lock: 'cleanup' }; browsers = [status];
      finishReopen!();
      await expect(page.getByRole('alert')).toContainText('HTTP 503');
      await expect(page.getByRole('button', { name: '确认关闭并重开', exact: true })).toHaveCount(0);
      await expect(page.getByText('正在关闭并重开…', { exact: true })).toHaveCount(0);
      const retry = page.getByRole('button', { name: '关闭并重开浏览器', exact: true });
      await expect(retry).toBeEnabled(); await retry.click();
      await expect(page.getByRole('button', { name: '取消', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: '确认关闭并重开', exact: true }).click();
      await expect.poll(() => attempts).toBe(2);
    }
    finishReopen!();
    await expect(page.getByRole('button', { name: '接手操作', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: '切换浏览器，当前：Mira 的浏览器 1', exact: true })).toBeVisible();
    expect(attempts).toBe(outcome === 'success' ? 1 : 2);
  });
}

for (const leave of ['switch', 'close'] as const) for (const outcome of ['success', 'failure'] as const) {
  test(`late reopen ${outcome} after browser ${leave} cannot replace the selected browser or publish an old error`, async ({ page }) => {
    const locked = { id: 'old-browser', state: 'unknown', lock: 'cleanup', epoch: 3, ownerLabel: 'Mira', domain: 'old.example' };
    const other = { id: 'other-browser', state: 'human', epoch: 1, ownerLabel: 'Other', domain: 'current.example' };
    let finishReopen: (() => void) | undefined; let responseFinished = false;
    const tickets: string[] = [];
    await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [locked, other] } }));
    await page.route('**/api/browser/*/ticket', route => { tickets.push(route.request().url()); return route.fulfill({ json: { ticket: 'other-ticket', epoch: 1 } }); });
    await page.route('**/api/browser/old-browser/reopen', async route => {
      await new Promise<void>(resolve => { finishReopen = resolve; });
      await route.fulfill(outcome === 'failure' ? { status: 503, json: { error: 'Late old cleanup failure' } } : { json: { id: 'late-replacement', replaces: locked.id, state: 'agent', epoch: 0, ownerLabel: 'Mira', domain: 'old.example' } });
      responseFinished = true;
    });
    await page.routeWebSocket('**/api/browser/stream', ws => ws.send(JSON.stringify({ type: 'mira_state', browser: other })));
    await page.goto('/#browser');
    await page.getByRole('button', { name: '关闭并重开浏览器', exact: true }).click();
    await page.getByRole('button', { name: '确认关闭并重开', exact: true }).click();
    await expect.poll(() => !!finishReopen).toBe(true);
    if (leave === 'close') {
      await page.getByRole('button', { name: '关闭浏览器', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    } else {
      await page.getByRole('button', { name: /^切换浏览器/ }).click();
      await page.getByRole('option').filter({ hasText: 'Other 的浏览器 1' }).click();
      await expect(page.locator('.bp-status')).toHaveText('由你操作 · Mira 已暂停');
    }
    finishReopen!();
    await expect.poll(() => responseFinished).toBe(true);
    // Flush the response promise through the browser before inspecting the view.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    if (leave === 'close') await expect(page.getByRole('dialog')).toHaveCount(0);
    else {
      await expect(page.getByRole('button', { name: '切换浏览器，当前：Other 的浏览器 1', exact: true })).toBeVisible();
      await expect(page.locator('.bp-status')).toHaveText('由你操作 · Mira 已暂停');
    }
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(tickets.some(url => url.includes('late-replacement'))).toBe(false);
  });
}

test('cleanup lock explains that close was not confirmed and does not request a ticket', async ({ page }) => {
  const locked = { id: 'lost', state: 'unknown', lock: 'cleanup', epoch: 5, ownerLabel: 'Mira', domain: 'example.test', message: 'Browser cleanup could not be verified. Agent and human control remain disabled; closing may be retried.' };
  let tickets = 0;
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [locked] } }));
  await page.route('**/api/browser/lost/ticket', route => { tickets++; return route.fulfill({ status: 409, json: { error: 'Browser is not available for viewing' } }); });
  await page.goto('/'); await page.getByRole('button', { name: '浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '浏览器' });
  await expect(dialog.getByText('浏览器关闭未能确认。')).toBeVisible();
  await expect(dialog.getByRole('button', { name: '关闭并重开浏览器', exact: true })).toBeVisible();
  await expect(dialog.locator('.bp-screen')).toHaveClass(/is-hidden/);
  await expect(dialog.getByText(/Browser cleanup/)).toHaveCount(0);
  for (const name of ['重新连接', '接手操作', '交还 Mira']) await expect(dialog.getByRole('button', { name, exact: true })).toHaveCount(0);
  await page.waitForTimeout(3000); expect(tickets).toBe(0); // across a status poll
});

test('address bar and tabs stay read-only until takeover, then navigate on the owner socket', async ({ page }) => {
  let status = { id: 'nav-browser', state: 'agent', epoch: 1, ownerLabel: 'Mira', domain: 'example.test' };
  const received: Record<string, unknown>[] = [];
  let socket: WebSocketRoute | undefined;
  let takeovers = 0;
  await page.route('**/api/browser', route => route.fulfill({ json: { browsers: [status] } }));
  await page.route('**/api/browser/nav-browser/ticket', route => route.fulfill({ json: { ticket: 'nav-ticket', epoch: status.epoch } }));
  await page.route('**/api/browser/nav-browser/takeover', async route => {
    takeovers++; status = { ...status, state: 'requesting', epoch: 2 }; await route.fulfill({ json: status });
  });
  await page.routeWebSocket('**/api/browser/stream', ws => {
    socket = ws;
    ws.onMessage(message => {
      const input = JSON.parse(String(message)) as Record<string, unknown>; received.push(input);
      if (input.type === 'nav_open') ws.send(JSON.stringify({ type: 'nav_done' }));
    });
    ws.send(JSON.stringify({ type: 'mira_state', browser: status }));
  });
  await page.goto('/'); await page.getByRole('button', { name: '浏览器', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '浏览器' });
  await expect.poll(() => socket !== undefined).toBe(true);
  socket!.send(JSON.stringify({ type: 'tabs', generation: 1, tabs: [
    { tabId: 't1', active: true, title: '示例', domain: 'example.test', url: 'https://example.test/start' },
    { tabId: 't2', active: false, title: '另一页', domain: 'example.org', url: 'https://example.org/other' },
  ] }));
  socket!.send(JSON.stringify({ type: 'url', generation: 1, domain: 'example.test', url: 'https://example.test/start' }));
  const address = dialog.getByLabel('浏览器地址');
  const tablist = dialog.getByRole('tablist', { name: '标签页' });
  const tabs = tablist.getByRole('tab');
  await expect(address).toHaveText('https://example.test/start');
  await expect(address).toHaveAttribute('aria-readonly', 'true');
  await expect(dialog.getByRole('button', { name: '前往', exact: true })).toHaveCount(0);
  await expect(tabs).toHaveCount(2);
  await expect(tablist).toHaveAttribute('aria-disabled', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await tabs.nth(1).click({ force: true }); expect(received.filter(item => item.type === 'nav_tab')).toHaveLength(0);
  await dialog.getByRole('button', { name: '接手操作', exact: true }).click();
  await expect.poll(() => takeovers).toBe(1);
  status = { ...status, state: 'human', epoch: 3 };
  socket!.send(JSON.stringify({ type: 'mira_state', browser: status }));
  await expect(dialog.getByText('由你操作 · Mira 已暂停', { exact: true })).toBeVisible();
  await expect(address).toHaveAttribute('aria-readonly', 'true');
  const data = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 20; return canvas.toDataURL('image/jpeg').split(',')[1]!; });
  socket!.send(JSON.stringify({ type: 'frame', seq: 1, generation: 1, epoch: 3, data, metadata: { deviceWidth: 40, deviceHeight: 20 } }));
  await expect.poll(() => received.some(item => item.type === 'ack' && item.seq === 1)).toBe(true);
  await expect(address).toBeEditable();
  await expect(dialog.getByRole('button', { name: '前往', exact: true })).toBeEnabled();
  await expect(tablist).not.toHaveAttribute('aria-disabled', 'true');
  await address.fill('example.org');
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await expect.poll(() => received.some(item => item.type === 'nav_open')).toBe(true);
  expect(received.find(item => item.type === 'nav_open')).toEqual({ type: 'nav_open', epoch: 3, url: 'https://example.org/' });
  await expect(dialog.getByRole('button', { name: '前往', exact: true })).toBeEnabled();
  await address.fill('javascript:alert(1)');
  await dialog.getByRole('button', { name: '前往', exact: true }).click();
  await expect(dialog.getByText('只支持 http 或 https 网址')).toBeVisible();
  expect(received.filter(item => item.type === 'nav_open')).toHaveLength(1);
  await tabs.nth(1).click();
  await expect.poll(() => received.some(item => item.type === 'nav_tab')).toBe(true);
  expect(received.find(item => item.type === 'nav_tab')).toEqual({ type: 'nav_tab', epoch: 3, tabId: 't2' });
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  socket!.send(JSON.stringify({ type: 'nav_error', message: 'Only http(s) addresses without credentials can be opened' }));
  const alert = dialog.locator('.bp-banner.is-error');
  await expect(alert).toContainText('浏览器导航未完成');
  await expect(alert).toContainText('Only http(s) addresses without credentials can be opened');
});
