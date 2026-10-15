import { probeNativeBrowserLaunch, startupProbePassed } from './browser-native-probe.mts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AgentBrowserDriver } from '../../apps/server/src/browser-driver.ts';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { createLocalHttp, LocalWebService, WebAccessAuth } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, model, streamOf } from '../recovery/fixtures.mts';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3229;
const origin = `http://127.0.0.1:${port}`;
const password = 'synthetic-mira-browser-password';
async function browserTab(page: Page) {
  if (!await page.locator('dialog.settings-dialog').isVisible()) await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '浏览器', exact: true }).click();
}
async function login(page: Page) {
  await page.getByLabel('访问密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入 Mira', exact: true }).click();
  await expect(page.locator('form.composer')).toBeVisible();
}
async function reconnect(page: Page) {
  const button = page.getByRole('button', { name: '重新连接', exact: true });
  await expect(button).toBeVisible(); await button.click();
  await expect(page.locator('.browser-viewport canvas')).not.toHaveClass(/browser-canvas-empty/);
}

test('official native startup diagnostic uses an empty isolated profile', async ({}, testInfo) => {
  const result = await probeNativeBrowserLaunch();
  await testInfo.attach('native-startup-diagnostic', { body: Buffer.from(JSON.stringify(result, null, 2)), contentType: 'application/json' });
  expect(startupProbePassed(result), JSON.stringify(result)).toBe(true);
  expect(result['probeError']).toBeUndefined();
  expect((result['launch'] as { success?: boolean } | undefined)?.success, JSON.stringify(result)).toBe(true);
  expect(result['ownedBrowserCaptured'], JSON.stringify(result)).toBe(true);
  expect(result['cleanup'], JSON.stringify(result)).toBe('confirmed');
});

test('real managed browser preserves page/cookie across handoff; rendered input, held disconnect, revocation and restart are fenced', async ({ page, context }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-browser-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  let lastRemoteNavigationGeneration = 0; let lastRemoteFrameGeneration = 0;
  page.on('websocket', socket => { if (!socket.url().endsWith('/api/browser/stream')) return;
    socket.on('framereceived', event => {
      const value = JSON.parse(String(event.payload)) as { type?: string; generation?: number };
      if (value.type === 'url') lastRemoteNavigationGeneration = value.generation ?? 0;
      if (value.type === 'frame') lastRemoteFrameGeneration = value.generation ?? 0;
    });
  });
  const cookie = 'browser-real-session';
  let submitted: { value: string; cookie: string } | undefined;
  let documentRequests = 0; let submissions = 0;
  // Owned test website. The remote Chromium receives this page through actual HTTP.
  const website = createServer((request, response) => {
    if (request.url === '/submit' && request.method === 'POST') {
      let body = ''; request.on('data', chunk => { body += String(chunk); });
      request.on('end', () => {
        submissions++; submitted = { value: new URLSearchParams(body).get('secret') ?? '', cookie: request.headers.cookie ?? '' };
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end('<!doctype html><html><head><title>Same browser signed in</title></head><body><h1>Signed in successfully</h1><p>Session preserved</p></body></html>');
      }); return;
    }
    if (request.url !== '/') { response.writeHead(404); response.end(); return; }
    documentRequests++;
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': `test_session=${cookie}; HttpOnly; SameSite=Lax; Path=/` });
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>Browser handoff test</title><style>body{font:20px sans-serif;background:#f5f7fb;color:#253c59;margin:0;padding:40px}h1{font-size:28px;margin:0 0 24px}label{display:block}input{display:block;width:500px;height:48px;font-size:22px;margin:10px 0 20px}button{font-size:20px;padding:14px 24px}</style></head><body><h1>Browser handoff test</h1><form action="/submit" method="post"><label for="secret">Test password</label><input id="secret" name="secret" type="password" autocomplete="off"><button type="submit">Sign in</button></form><p>Use the same page and cookie when handing control back.</p></body></html>`);
  });
  try {
    await new Promise<void>((resolve, reject) => { website.once('error', reject); website.listen(0, '127.0.0.1', () => resolve()); });
    const address = website.address(); if (!address || typeof address === 'string') throw Error('Test website failed to bind');
    const websiteOrigin = `http://127.0.0.1:${address.port}`;
    db = await createTestDatabase();
    let modelCalls = 0; let childCalls = 0; let phase: 'open' | 'refresh' | 'child' = 'open';
    let parentBrowser = '';
    const tool = (id: string, name: string, args: Record<string, string | number | string[]>) => streamOf({ ...assistant(), stopReason: 'toolUse' as const, content: [{ type: 'toolCall' as const, id, name, arguments: args }] });
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'browser-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      // Full service prompt/tools exceed the small 8K recovery-fixture model.
      synthetic: true, syntheticModel: { ...model, contextWindow: 100_000 }, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
    const start = async () => {
      service = await LocalWebService.open({ ...options, syntheticStream: async (_model, transcript) => {
        expect(getCurrentTools(transcript.messages).some(tool => tool.name === 'browser_open')).toBe(true);
        if (getCurrentSystemPrompt(transcript.messages).includes('task-scoped worker')) {
          if (++childCalls === 1) return tool('child-cannot-borrow', 'browser_command', { id: parentBrowser, args: ['snapshot', '-i'] });
          if (childCalls === 2) { expect(JSON.stringify(transcript.messages)).toContain('not_executed'); return tool('child-browser-list', 'browser_list', {}); }
          return streamOf(assistant('Child ownership check complete.'));
        }
        modelCalls++;
        if (phase === 'open' && modelCalls === 1) return tool('real-browser-open', 'browser_open', { url: websiteOrigin });
        if (phase === 'open' && modelCalls === 2) { parentBrowser = service!.browser.list()[0]!.id; return tool('real-browser-first-snapshot', 'browser_command', { id: parentBrowser, args: ['snapshot', '-i'] }); }
        if (phase === 'refresh' && modelCalls === 1) return tool('real-browser-return-snapshot', 'browser_command', { id: parentBrowser, args: ['snapshot', '-i'] });
        if (phase === 'refresh' && modelCalls === 2) return tool('real-browser-return-title', 'browser_command', { id: parentBrowser, args: ['get', 'title'], observation: service!.browser.list().find(item => item.id === parentBrowser)!.observation });
        if (phase === 'child' && modelCalls === 1) return tool('real-browser-child', 'subagent_spawn', { title: '检查浏览器归属', task: 'Verify that your browser tools cannot borrow the parent browser and list only your own handles.', fork: 'none' });
        return streamOf(assistant('Browser ready for the synthetic handoff.'));
      } });
      const auth = await WebAccessAuth.open({ miraHome: root, sourceDirectory });
      app = createLocalHttp({ backend: service, auth, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
      await app.listen({ port, host: '127.0.0.1' });
    };
    await start();
    const managed = service!.browser.bind('browser-real');
    await service!.submit({ id: 'browser-real-open', text: 'Open the synthetic browser handoff test page.', occurredAt: new Date().toISOString() });
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    await expect.poll(() => service!.browser.list().length).toBe(1);
    const opened = service!.browser.list()[0]!;
    expect(opened.state).toBe('agent');
    const observed = opened;
    expect(JSON.stringify((await db.admin.query("SELECT outcome FROM tool_executions WHERE call_id='real-browser-first-snapshot'")).rows)).toContain('Test password');
    await page.goto(origin);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '访问', exact: true }).click();
    await page.getByRole('switch', { name: '使用访问密码' }).check();
    await page.getByLabel('设置访问密码', { exact: true }).fill(password);
    await page.getByLabel('再次输入新密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '保存访问设置', exact: true }).click();
    // The composer already existed before saving; wait for the actual auth commit
    // before minting a cookie-bound stream ticket. Rotation revokes older tickets.
    await expect(page.getByText('访问密码已保存，当前浏览器已登录，其他浏览器需重新登录。', { exact: true })).toBeVisible();
    await browserTab(page);
    await expect(page.locator('.browser-viewport canvas')).not.toHaveClass(/browser-canvas-empty/);
    const denied = await context.request.post(`${origin}/api/browser/${opened.id}/ticket`, { headers: { 'x-mira-client': 'web', origin: 'https://untrusted.invalid' }, data: {} });
    expect(denied.status()).toBe(403);
    const replay = await page.evaluate(async id => {
      const response = await fetch(`/api/browser/${id}/ticket`, { method: 'POST', headers: { 'x-mira-client': 'web', 'content-type': 'application/json' }, body: '{}' });
      const { ticket } = await response.json() as { ticket: string };
      const connect = () => new Promise<boolean>(resolve => {
        const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/browser/stream`, ['mira-browser', ticket]);
        socket.onopen = () => { socket.close(); resolve(true); }; socket.onerror = () => resolve(false);
      });
      return [await connect(), await connect()];
    }, opened.id);
    expect(replay).toEqual([true, false]);
    await page.getByRole('button', { name: '接手操作', exact: true }).click();
    await expect.poll(() => service!.browser.list()[0]?.state).toBe('human');
    await reconnect(page);
    const bridge = page.getByLabel('浏览器键盘输入，按 Escape 离开', { exact: true });
    await expect(bridge).toBeEnabled();
    // A second authenticated page may read the list but cannot create a second human input socket.
    const other = await context.newPage(); await other.goto(origin); await browserTab(other);
    await expect(other.getByRole('button', { name: '重新连接', exact: true })).toBeVisible();
    expect(service!.browser.list()[0]?.state).toBe('human'); await other.close(); await page.bringToFront();
    await expect(managed.command(opened.id, ['click', '#secret'], observed.observation)).rejects.toThrow(/agent control/);
    await page.getByRole('button', { name: '放大画面', exact: true }).click();
    const canvas = page.locator('.browser-viewport canvas');
    const remote = await canvas.evaluate(element => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height }));
    const box = await canvas.boundingBox(); if (!box) throw Error('Missing real remote frame');
    // The owned remote page's fixed CSS puts its password field at x=40,y=125.
    await canvas.click({ position: { x: 100 / remote.width * box.width, y: 155 / remote.height * box.height } });
    await expect(bridge).toBeFocused();
    for (const target of [{ x: box.x - 20, y: box.y + box.height / 2 }, { x: box.x + box.width + 20, y: box.y + box.height / 2 }, { x: box.x + box.width / 2, y: box.y - 20 }, { x: box.x + box.width / 2, y: box.y + box.height + 20 }]) {
      await page.mouse.move(box.x + 100 / remote.width * box.width, box.y + 155 / remote.height * box.height);
      await page.mouse.down(); await page.mouse.move(target.x, target.y); await page.mouse.up();
      await expect.poll(() => service!.browser.list()[0]?.pressedButtons).toEqual([]);
      expect(service!.browser.list()[0]?.state).toBe('human'); await expect(bridge).toBeEnabled();
    }
    // A human gesture cut short by return must not resume the agent with a
    // pressed button. Resume and explicitly release through the real UI.
    await page.mouse.move(box.x + 100 / remote.width * box.width, box.y + 155 / remote.height * box.height);
    await page.mouse.down();
    await expect.poll(() => service!.browser.list()[0]?.pressedButtons).toEqual(['left']);
    await page.getByRole('button', { name: '交还 Mira', exact: true }).evaluate(element => (element as HTMLElement).click());
    await expect.poll(() => service!.browser.list()[0]?.state).toBe('held');
    await page.mouse.up();
    await expect.poll(() => service!.browser.list()[0]?.state).toBe('held');
    await expect(page.getByText('鼠标仍处于按下状态，暂不能交还。请继续接手，看到当前画面后显式松开鼠标。')).toBeVisible();
    await page.getByRole('button', { name: '继续接手', exact: true }).click(); await reconnect(page);
    await page.getByRole('button', { name: '松开左键', exact: true }).click();
    await expect.poll(() => service!.browser.list()[0]?.pressedButtons).toEqual([]);
    await bridge.focus();
    await page.keyboard.type('discard');
    await page.keyboard.press('Control+a'); await page.keyboard.press('Backspace');
    await page.keyboard.type('Latin-');
    // Real Chromium composition events through CDP, then the production bridge,
    // authenticated WebSocket proxy, awaited official daemon input, and actual remote input.
    // This is not a claim of OS-native keyboard/IME interoperability.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '中文', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '中文' });
    await bridge.evaluate(element => {
      const data = new DataTransfer(); data.setData('text/plain', '-paste');
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
    });
    await expect(bridge).toHaveValue('');
    await page.screenshot({ path: testInfo.outputPath('browser-real-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('browser-real-narrow.png'), fullPage: true });
    const generationBeforeSubmit = lastRemoteFrameGeneration;
    await bridge.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Enter');
    await expect.poll(() => submitted?.value).toBe('Latin-中文-paste');
    expect(submitted?.cookie).toContain(`test_session=${cookie}`);
    expect(documentRequests).toBe(1);
    await expect.poll(() => lastRemoteNavigationGeneration).toBeGreaterThan(generationBeforeSubmit);
    await expect.poll(() => lastRemoteFrameGeneration).toBeGreaterThanOrEqual(lastRemoteNavigationGeneration);
    await expect(bridge).toBeEnabled(); // Static destination has a new usable frame, not a blank connected viewport.
    await page.getByRole('button', { name: '交还 Mira', exact: true }).click();
    await expect.poll(() => service!.browser.list()[0]?.state).toBe('agent');
    await expect(managed.command(opened.id, ['get', 'title'], observed.observation)).rejects.toThrow(/Fresh browser snapshot/);
    phase = 'refresh'; modelCalls = 0;
    await service!.submit({ id: 'browser-real-return', text: 'Inspect the returned browser using a fresh observation.', occurredAt: new Date().toISOString() });
    await expect.poll(async () => (await db!.admin.query("SELECT outcome FROM tool_executions WHERE call_id='real-browser-return-title'")).rows[0]?.outcome != null).toBe(true);
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(JSON.stringify((await db.admin.query("SELECT outcome FROM tool_executions WHERE call_id='real-browser-return-title'")).rows)).toContain('Same browser signed in');
    phase = 'child'; modelCalls = 0;
    await service!.submit({ id: 'browser-real-child', text: 'Check child browser ownership in the synthetic task.', occurredAt: new Date().toISOString() });
    await expect.poll(async () => (await db!.admin.query('SELECT status FROM subagent_turns')).rows[0]?.status).toBe('completed');
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    const borrowed = (await db.admin.query("SELECT outcome FROM tool_executions WHERE call_id='child-cannot-borrow'")).rows;
    expect(JSON.stringify(borrowed)).toContain('not_executed');
    expect(service!.browser.list()).toHaveLength(1);
    const durable = JSON.stringify((await db.admin.query('SELECT envelope FROM context_records')).rows)
      + JSON.stringify((await db.admin.query('SELECT intent,outcome FROM tool_executions')).rows);
    expect(durable).not.toContain('Latin-中文-paste');
    expect(durable).not.toContain('browser-real-session');
    expect(durable).not.toContain('ephemeral-fixture-ticket');
    // Remote input has not entered Mira's message timeline or browser storage.
    expect(JSON.stringify(await service!.timeline())).not.toContain('Latin-中文-paste');
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('Latin-中文-paste');
    // Closing settings after a second takeover holds control; opening settings is read-only until resumed.
    await page.getByRole('button', { name: '接手操作', exact: true }).click(); await reconnect(page);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect.poll(() => service!.browser.list()[0]?.state).toBe('held');
    await browserTab(page); await page.getByRole('button', { name: '继续接手', exact: true }).click(); await reconnect(page);
    await expect.poll(() => service!.browser.list()[0]?.state).toBe('human');
    // Revoke the actual HTTP session while its human stream is still connected.
    expect(await page.evaluate(async () => (await fetch('/api/auth/logout', { method: 'POST', headers: { 'x-mira-client': 'web', 'content-type': 'application/json' }, body: '{}' })).status)).toBe(200);
    await expect.poll(() => service!.browser.list()[0]?.state).toBe('held');
    await page.reload(); await login(page);
    const oldId = opened.id;
    const effectsBeforeRestart = { documents: documentRequests, submissions, tools: (await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n };
    await app!.close(); app = undefined; await service!.close(); service = undefined; await start();
    expect(service!.browser.list()).toEqual([]);
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect({ documents: documentRequests, submissions, tools: (await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n }).toEqual(effectsBeforeRestart);
    await page.reload(); await login(page);
    const stale = await page.evaluate(async id => (await fetch(`/api/browser/${id}/ticket`, { method: 'POST', headers: { 'x-mira-client': 'web', 'content-type': 'application/json' }, body: '{}' })).status, oldId);
    expect(stale).toBe(409);
    await browserTab(page);
    await expect(page.getByText('还没有活动的浏览器。Mira 使用浏览器时会显示在这里。')).toBeVisible();
  } catch (error) {
    await page.screenshot({ path: testInfo.outputPath('first-failure.png'), fullPage: true }).catch(() => undefined);
    throw error;
  } finally {
    await app?.close(); await service?.close(); await db?.close();
    await new Promise<void>(resolve => website.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});


// The official daemon owns a separate Chrome process group. Exercise actual OS
// death, not a fake transport callback, and never discover/kill unrelated roots.
test('official daemon death invalidates its handle and cleans its detached Chromium', async () => {
  const rows = async () => {
    const output = await new Promise<string>((resolve, reject) => execFile('/bin/ps', ['-axo', 'pid=,ppid=,stat='], (error, stdout) => error ? reject(error) : resolve(stdout)));
    return output.trim().split('\n').map(line => { const [pid, ppid, state] = line.trim().split(/\s+/); return { pid: Number(pid), ppid: Number(ppid), state }; });
  };
  const before = new Set((await rows()).map(row => row.pid));
  const driver = new AgentBrowserDriver(); const session = randomUUID();
  let exited = false; driver.onExit(id => { if (id === session) exited = true; });
  const website = createServer((_req, res) => { res.end('<title>Crash fixture</title>'); });
  await new Promise<void>(resolve => website.listen(0, '127.0.0.1', resolve));
  try {
    await driver.open(session, `http://127.0.0.1:${(website.address() as {port:number}).port}`);
    const current = await rows();
    const daemon = current.find(row => row.ppid === process.pid && !before.has(row.pid) && current.some(child => child.ppid === row.pid));
    expect(daemon).toBeDefined();
    const owned = new Set([daemon!.pid]);
    for (let changed = true; changed;) { changed = false; for (const row of current) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; } }
    expect(owned.size).toBeGreaterThan(1);
    process.kill(daemon!.pid, 'SIGKILL');
    await expect.poll(() => exited).toBe(true);
    await expect(driver.command(session, ['snapshot', '-i'])).rejects.toThrow();
    await expect.poll(async () => (await rows()).filter(row => owned.has(row.pid) && !row.state?.startsWith('Z')).length).toBe(0);
    await expect(driver.command(session, ['snapshot', '-i'])).rejects.toThrow();
  } finally { await driver.dispose(); await new Promise<void>(resolve => website.close(() => resolve())); }
});
