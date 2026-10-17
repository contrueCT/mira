import { expect, test } from '@playwright/test';

test('desktop and narrow layouts render the single Mira timeline without console errors', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await expect(page.getByText('Mira，我们从这里开始吧', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '模型设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeVisible();
  await expect(page.locator('.settings-button')).toHaveCount(1); // Reply actions remain local to messages, not a new management entry.
  await expect(page.getByRole('tab')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('mira-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mira-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('服务商', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mira-settings-narrow.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: testInfo.outputPath('mira-settings-desktop.png'), fullPage: true });
  expect(errors).toEqual([]);
});

test('normal chat shows conversation and working state without tool activity', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'working', mode: 'synthetic', model: 'Fixture model', error: null } }));
  await page.route('**/api/timeline', route => route.fulfill({ json: {
    items: [{ id: 'visible-message', role: 'assistant', text: '我在继续处理这条消息', occurredAt: '2026-10-06T08:00:00.000Z' }], nextCursor: null,
    // Unexpected backend fields must not become a visible debug panel.
    tools: [{ id: 'hidden-call', name: 'INTERNAL_TOOL_SENTINEL', status: 'running' }],
  } }));
  await page.goto('/');
  await expect(page.getByText('我在继续处理这条消息', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Mira 正在处理' })).toBeVisible();
  await expect(page.getByLabel('工具活动')).toHaveCount(0);
  await expect(page.locator('.tool-chip')).toHaveCount(0);
  await expect(page.getByText('INTERNAL_TOOL_SENTINEL')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('我在继续处理这条消息', { exact: true })).toBeVisible();
  await expect(page.getByText('INTERNAL_TOOL_SENTINEL')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('double Enter submits once and refresh restores the fixture server receipt', async ({ page }) => {
  await page.goto('/'); const input = page.getByLabel('给 Mira 发消息', { exact: true });
  const text = '重复发送与刷新验证'; let sends = 0;
  page.on('request', request => { if (request.url().endsWith('/api/messages')) sends++; });
  await input.fill(text);
  await input.evaluate(element => { for (let index = 0; index < 2; index++) element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
  await expect(page.getByRole('article', { name: '你的消息' }).getByText(text, { exact: true })).toHaveCount(1);
  await expect(page.getByText(`已收到：${text}\n这是一条界面测试回复。`, { exact: true })).toBeVisible({ timeout: 10_000 });
  expect(sends).toBe(1); await page.reload();
  await expect(page.getByRole('article', { name: '你的消息' }).getByText(text, { exact: true })).toHaveCount(1);
  expect(sends).toBe(1);
});

test('settings close, Escape and Back/Forward leave the timeline usable', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page).toHaveURL(/#settings$/);
  await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0); await page.goForward(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeEditable();
});

test('settings retain drafts across backdrop clicks and inside-to-outside drags on desktop and narrow screens', async ({ page }, testInfo) => {
  await mockSettings(page);
  await page.route('**/api/memory', route => route.fulfill({ json: { configured: false } }));
  await openSettings(page);
  await page.getByRole('tab', { name: 'Memory', exact: true }).click();
  const draft = page.getByLabel('修改记忆', { exact: true });
  await draft.fill('An unsaved fixture draft');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.mouse.click(5, 5);
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
    const input = await draft.boundingBox(); const dialog = await page.locator('dialog.settings-dialog').boundingBox();
    if (!input || !dialog) throw Error('Settings draft must be visible');
    await page.mouse.move(input.x + 50, input.y + 20); await page.mouse.down();
    await page.mouse.move(dialog.x - 5, input.y + 20, { steps: 10 }); await page.mouse.up();
    await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
    await expect(draft).toHaveValue('An unsaved fixture draft');
    await expect(page).toHaveURL(/#settings$/);
    await page.screenshot({ path: testInfo.outputPath(`settings-backdrop-${viewport.width}.png`) });
  }
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeEditable();
});

test('opening settings twice or waiting for slow reads never dismisses the modal', async ({ page }) => {
  await mockSettings(page);
  await page.route('**/api/settings', async route => {
    await new Promise(resolve => setTimeout(resolve, 750));
    await route.fulfill({ json: settingsFixture() });
  });
  await page.goto('/');
  const gear = page.getByRole('button', { name: '模型设置', exact: true });
  await expect(gear).toBeVisible();
  const box = await gear.boundingBox(); if (!box) throw Error('Settings button must be visible');
  // Native second click lands at the opener's coordinates, now behind the modal.
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2, { delay: 100 });
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('服务商', { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#settings$/);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await gear.click();
  await expect(page.getByText('正在读取配置…', { exact: true })).toBeVisible();
  await expect(page.getByLabel('服务商', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goForward(); await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
});

test('uncertain send is never automatically resent after reload or reconnect', async ({ page }) => {
  let sends = 0;
  await page.route('**/api/messages', async route => { sends++; await route.abort('failed'); });
  await page.goto('/'); await page.getByLabel('给 Mira 发消息', { exact: true }).fill('未知结果消息');
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对并重试' })).toBeVisible(); expect(sends).toBe(1);
  await page.reload(); await expect(page.getByRole('button', { name: '核对并重试' })).toBeVisible();
  await page.waitForTimeout(1500); expect(sends).toBe(1);
  await page.getByRole('button', { name: '核对并重试' }).click(); await expect.poll(() => sends).toBe(2);
});

test('retry preflight acknowledges a global-ID user event without resending its external envelope', async ({ page }) => {
  const envelope = { id: '50000000-0000-4000-8000-000000000001', text: '已经保存但回执丢失的消息', occurredAt: '2026-10-06T08:00:00.000Z' };
  let reveal = false; let sends = 0;
  await page.addInitScript(value => sessionStorage.setItem('mira.pending-messages.v1', JSON.stringify([{ ...value, state: 'uncertain' }])), envelope);
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'idle', mode: 'synthetic', model: 'Fixture model', error: null } }));
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: reveal ? [{ id: '60000000-0000-4000-8000-000000000001', externalEventId: envelope.id, role: 'user', text: envelope.text, occurredAt: envelope.occurredAt }] : [], nextCursor: null } }));
  await page.route('**/api/messages', async route => { sends++; await route.abort('failed'); });
  await page.goto('/');
  await expect(page.getByRole('button', { name: '核对并重试' })).toBeVisible();
  reveal = true;
  const preflight = page.waitForResponse(response => response.url().endsWith('/api/timeline') && response.request().method() === 'GET');
  await page.getByRole('button', { name: '核对并重试' }).click();
  await preflight;
  // Completion re-enables the composer; focus is not part of this receipt contract.
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('你的消息', { exact: true })).toHaveCount(1);
  await expect(page.getByLabel('待确认的消息', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '核对并重试' })).toHaveCount(0);
  expect(sends).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem('mira.pending-messages.v1'))).toBeNull();
});

test('foreign origins and missing client headers cannot read or submit through the local API', async ({ request }) => {
  const read = await request.get('/api/settings'); expect(read.status()).toBe(403);
  const foreign = await request.post('/api/messages', { headers: { origin: 'https://example.org', 'x-mira-client': 'web' }, data: { id: 'foreign', text: 'blocked', occurredAt: new Date().toISOString() } });
  expect(foreign.status()).toBe(403);
});

// Settings interactions use dummy test keys and deterministic browser fixtures.
// No real credentials or provider discovery/model requests are used.
import type { Page } from '@playwright/test';
import type { ApiKeyWrite, Settings, SettingsWrite } from '../../apps/web/src/types.ts';

function settingsFixture(): Settings {
  return {
    revision: '2'.repeat(64),
    configuration: {
      builtinCredentials: { openai: { hasApiKey: true } },
      customConnections: [{ id: 'existing-local', name: 'Existing local', baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', hasApiKey: true, models: [{ id: 'original-model', contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ['text'] }] }],
    },
    selection: { kind: 'builtin', provider: 'openai', model: 'fixture-builtin' },
  };
}
function publicSettings(write: SettingsWrite): Settings {
  const status = (entry: ApiKeyWrite) => ({ hasApiKey: typeof entry.apiKey === 'string' || (entry.apiKey !== null && entry.hasApiKey) });
  return { selection: write.selection, revision: '3'.repeat(64), configuration: {
    ...(write.configuration.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: write.configuration.defaultThinkingLevel }),
    builtinCredentials: Object.fromEntries(Object.entries(write.configuration.builtinCredentials).map(([id, entry]) => [id, status(entry)])),
    customConnections: write.configuration.customConnections.map(entry => { const { apiKey: _key, ...connection } = entry; return { ...connection, ...status(entry) }; }),
  } };
}
async function mockSettings(page: Page, initial = settingsFixture()) {
  let current = structuredClone(initial); const writes: SettingsWrite[] = [];
  await page.route('**/api/models/catalog', route => route.fulfill({ json: {
    source: 'test-fixture', generatedAt: null,
    providers: [{ id: 'openai', name: 'OpenAI', apiKeySupport: { supported: true, explanation: 'fixture' }, models: [{ id: 'fixture-builtin', name: 'Fixture builtin', provider: 'openai', protocol: { id: 'openai-responses', name: 'OpenAI Responses' }, catalogBaseUrl: 'https://api.openai.com/v1', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'] }] }],
  } }));
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') { const value = route.request().postDataJSON() as SettingsWrite; writes.push(value); current = publicSettings(value); }
    await route.fulfill({ json: current });
  });
  return { writes };
}
async function openSettings(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByLabel('服务商', { exact: true })).toBeVisible();
}

test('built-in selection writes a password key once and receives only saved status', async ({ page }) => {
  const fixture = settingsFixture(); const { writes } = await mockSettings(page, fixture);
  await openSettings(page);
  await page.getByLabel('服务商', { exact: true }).selectOption('openai');
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('fixture-builtin');
  await page.getByLabel('API Key', { exact: true }).fill('dummy-web-openai-key');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.selection).toEqual({ kind: 'builtin', provider: 'openai', model: 'fixture-builtin' });
  expect(writes[0]?.configuration.builtinCredentials.openai).toEqual({ hasApiKey: true, apiKey: 'dummy-web-openai-key' });
  expect(writes[0]?.configuration.customConnections).toEqual(fixture.configuration.customConnections);
  await expect(page.locator('input[type="password"]')).toHaveCount(1);
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByText('已保存密钥。留空保留，已保存的值不会显示。')).toBeVisible();
});

test('manual custom models require explicit limits with conservative optional capabilities and preserve existing connections', async ({ page }) => {
  const { writes } = await mockSettings(page);
  await openSettings(page);
  await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: false }).fill('My test connection');
  await page.getByLabel('协议', { exact: true }).selectOption('openai-responses');
  await page.getByLabel('服务地址', { exact: true }).fill('https://example.test/v1');
  await page.getByLabel('API Key', { exact: true }).fill('dummy-custom-test-key');
  await page.getByLabel('模型 ID', { exact: true }).fill('fixture-manual');
  await page.getByLabel('上下文窗口', { exact: true }).fill('32000');
  await page.getByLabel('最大输出', { exact: true }).fill('2048');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes).toHaveLength(1);
  const saved = writes[0]!; const custom = saved.configuration.customConnections.find(item => item.name === 'My test connection')!;
  expect(saved.configuration.customConnections).toHaveLength(2);
  expect(saved.configuration.customConnections[0]?.id).toBe('existing-local');
  expect(custom.api).toBe('openai-responses');
  expect(custom.models).toEqual([{ id: 'fixture-manual', contextWindow: 32000, maxTokens: 2048, reasoning: false, input: ['text'] }]);
  expect(saved.selection).toEqual({ kind: 'custom', connection: custom.id, model: 'fixture-manual' });
});

test('late discovery is discarded after draft edits and settings close', async ({ page }) => {
  await mockSettings(page);
  let release: () => void = () => {}; const deferred = new Promise<void>(resolve => { release = resolve; });
  let started = false; let settled = false;
  await page.route('**/api/models/discover', async route => {
    started = true;
    expect(route.request().postDataJSON().connection.hasApiKey).toBe(true);
    expect(route.request().postDataJSON().connection).not.toHaveProperty('apiKey');
    await deferred;
    try { await route.fulfill({ json: { endpoint: 'http://127.0.0.1:9999/v1/models', models: [{ id: 'late-model-id', name: 'Late model' }] } }); } catch { /* Browser cancellation may close the routed request. */ }
    finally { settled = true; }
  });
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await expect.poll(() => started).toBe(true);
  await page.getByLabel('服务地址', { exact: true }).fill('http://127.0.0.1:8888/v1');
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  release(); await expect.poll(() => settled).toBe(true);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveValue('http://127.0.0.1:9999/v1');
  await expect(page.getByLabel('发现的候选模型', { exact: true })).toHaveCount(0);
  await expect(page.getByText('late-model-id', { exact: false })).toHaveCount(0);
});

test('revision conflicts retain edits and require explicit reload before another save', async ({ page }) => {
  await mockSettings(page);
  let writes = 0; let reads = 0;
  const latest = settingsFixture(); latest.revision = '4'.repeat(64); latest.configuration.builtinCredentials.openai = { hasApiKey: true };
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') { writes++; await route.fulfill({ status: 409, json: { error: 'Settings changed; reload before saving' } }); }
    else { reads++; await route.fulfill({ json: reads === 1 ? settingsFixture() : latest }); }
  });
  await openSettings(page); await page.getByLabel('API Key', { exact: true }).fill('MY_UNSAVED_KEY');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('配置已在别处更新');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('MY_UNSAVED_KEY');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  expect(writes).toBe(1); expect(reads).toBe(1);
  await page.getByRole('button', { name: '重新读取并放弃当前编辑', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  expect(reads).toBe(2); expect(writes).toBe(1);
});

test('an unfinished inactive connection can be cancelled without losing other edits', async ({ page }) => {
  const { writes } = await mockSettings(page);
  await openSettings(page); await page.getByLabel('API Key', { exact: true }).fill('KEEP_THIS_EDIT');
  await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByRole('button', { name: '内置服务商', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('取消新增连接'); expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '取消新增连接', exact: true }).click();
  await page.getByRole('button', { name: '内置服务商', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('KEEP_THIS_EDIT');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes[0]?.configuration.customConnections).toHaveLength(1);
});

test('unreadable pending storage is retained after a successful timeline load', async ({ page }) => {
  await page.addInitScript(() => sessionStorage.setItem('mira.pending-messages.v1', 'unreadable original queue'));
  await page.goto('/');
  await expect(page.getByText('Mira，我们从这里开始吧', { exact: true })).toBeVisible();
  await expect(page.getByText(/浏览器中的待确认消息无法读取/u)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('mira.pending-messages.v1'))).toBe('unreadable original queue');
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
});

async function expectNoStoredKey(page: Page, key: string) {
  const persisted = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage }, history: history.state, url: location.href }));
  expect(persisted).not.toContain(key);
  expect(await page.locator('body').innerText()).not.toContain(key);
}

test('blank and reset retain saved keys; explicit removal writes null and disables the selected model', async ({ page }) => {
  const { writes } = await mockSettings(page);
  await openSettings(page);
  const key = page.getByLabel('API Key', { exact: true });
  await expect(key).toHaveValue('');
  await page.getByRole('button', { name: '替换密钥', exact: true }).click();
  await expect(key).toBeFocused();
  await key.fill('dummy-reset-this-key');
  await page.getByRole('button', { name: '撤销密钥更改', exact: true }).click();
  await expect(key).toHaveValue('');
  await key.fill('dummy-cleared-input'); await key.fill('');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes[0]?.configuration.builtinCredentials.openai).toEqual({ hasApiKey: true });
  await page.getByRole('button', { name: '移除密钥', exact: true }).click();
  await expect(page.getByText('保存后移除密钥；使用此密钥的当前模型将停用。')).toBeVisible();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('尚未保存密钥。请直接填写 API Key。')).toBeVisible();
  expect(writes[1]?.configuration.builtinCredentials.openai).toEqual({ hasApiKey: true, apiKey: null });
  expect(writes[1]?.selection).toBeNull();
  await expect(key).toHaveValue('');
});

test('GET and successful save return only status; password input and browser storage do not retain submitted keys', async ({ page }) => {
  await mockSettings(page);
  const logs: string[] = []; page.on('console', message => logs.push(message.text()));
  const dummy = 'dummy-private-browser-test-key';
  await openSettings(page); await page.getByLabel('API Key', { exact: true }).fill(dummy);
  await expectNoStoredKey(page, dummy);
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  const read = await page.evaluate(async () => (await fetch('/api/settings', { headers: { 'X-Mira-Client': 'web' } })).json());
  expect(read.configuration.builtinCredentials.openai).toEqual({ hasApiKey: true });
  expect(JSON.stringify(read)).not.toContain(dummy);
  expect(JSON.stringify(read)).not.toContain('"apiKey":');
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expectNoStoredKey(page, dummy);
  expect(logs.join('\n')).not.toContain(dummy);
});

for (const exit of ['cancel', 'escape', 'back', 'reload'] as const) {
  test(`${exit} discards an entered key before reopening settings`, async ({ page }) => {
    const { writes } = await mockSettings(page);
    const dummy = `dummy-${exit}-discard-key`;
    await openSettings(page); await page.getByLabel('API Key', { exact: true }).fill(dummy);
    await expectNoStoredKey(page, dummy);
    if (exit === 'cancel') await page.getByRole('button', { name: '取消', exact: true }).click();
    if (exit === 'escape') await page.keyboard.press('Escape');
    if (exit === 'back') await page.goBack();
    if (exit === 'reload') await page.reload();
    else {
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('button', { name: '模型设置', exact: true })).toBeFocused();
      await page.getByRole('button', { name: '模型设置', exact: true }).click();
    }
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expectNoStoredKey(page, dummy);
    expect(writes).toHaveLength(0);
  });
}

test('discovery uses an unsaved key transiently and resetting the connection clears it', async ({ page }) => {
  const { writes } = await mockSettings(page);
  const discoveries: unknown[] = []; const dummy = 'dummy-discovery-only-key';
  await page.route('**/api/models/discover', async route => {
    discoveries.push(route.request().postDataJSON());
    await route.fulfill({ json: { endpoint: 'http://127.0.0.1:9999/v1/models', models: [{ id: 'discovered-dummy-model' }] } });
  });
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill(dummy);
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await expect(page.getByLabel('发现的候选模型', { exact: true })).toHaveValue('');
  await page.getByLabel('发现的候选模型', { exact: true }).selectOption('discovered-dummy-model');
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('discovered-dummy-model');
  expect(discoveries).toHaveLength(1);
  expect(discoveries[0]).toMatchObject({ connection: { id: 'existing-local', apiKey: dummy } });
  expect(writes).toHaveLength(0);
  await expectNoStoredKey(page, dummy);
  await page.getByRole('button', { name: '还原此连接', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('发现的候选模型', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await expect(page.getByLabel('发现的候选模型', { exact: true })).toHaveValue('');
  await page.getByLabel('发现的候选模型', { exact: true }).selectOption('discovered-dummy-model');
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('discovered-dummy-model');
  expect(discoveries).toHaveLength(2);
  expect(discoveries[1]).toMatchObject({ connection: { id: 'existing-local', hasApiKey: true } });
  expect((discoveries[1] as { connection: unknown }).connection).not.toHaveProperty('apiKey');
});

test('removing a custom credential retains the connection and reports that no model is enabled', async ({ page }) => {
  const { writes } = await mockSettings(page);
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '移除密钥', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/当前未启用模型/u)).toBeVisible();
  expect(writes[0]?.configuration.customConnections[0]).toMatchObject({ id: 'existing-local', apiKey: null });
  expect(writes[0]?.selection).toBeNull();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByText('尚未保存密钥。请直接填写 API Key。')).toBeVisible();
});

test('errors cannot reflect entered keys into page text or logs', async ({ page }) => {
  await mockSettings(page);
  const dummy = 'dummy-never-echo-error-key'; const logs: string[] = [];
  page.on('console', message => logs.push(message.text()));
  await page.route('**/api/models/discover', route => route.fulfill({ status: 502, json: { error: `Upstream reflected ${dummy}` } }));
  await page.route('**/api/settings', route => route.request().method() === 'PUT'
    ? route.fulfill({ status: 500, json: { error: `Upstream reflected ${dummy}` } })
    : route.fulfill({ json: settingsFixture() }));
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill(dummy);
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('无法获取模型');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.locator('.settings-error')).toContainText('尚未确认保存结果');
  await expectNoStoredKey(page, dummy);
  expect(logs.join('\n')).not.toContain(dummy);
});

for (const target of ['endpoint', 'protocol', 'discovery-url'] as const) {
  test(`${target} edits invalidate saved and entered credentials until explicitly re-entered`, async ({ page }) => {
    const { writes } = await mockSettings(page);
    let discoveries = 0;
    await page.route('**/api/models/discover', async route => { discoveries++; await route.fulfill({ json: { endpoint: 'https://example.test/models', models: [] } }); });
    await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
    await page.getByLabel('API Key', { exact: true }).fill('dummy-old-target-key');
    if (target === 'endpoint') await page.getByLabel('服务地址', { exact: true }).fill('https://example.test/v1');
    if (target === 'protocol') await page.getByLabel('协议', { exact: true }).selectOption('openai-responses');
    if (target === 'discovery-url') {
      await page.getByText('指定模型发现地址', { exact: true }).click();
      await page.getByLabel('发现地址', { exact: false }).fill('http://127.0.0.1:9999/v1/alternate-models');
    }
    await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
    await expect(page.getByText(/原密钥不能用于新地址/u)).toBeVisible();
    await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('请先填写此连接的 API Key');
    expect(discoveries).toBe(0);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    expect(writes).toHaveLength(0);
    await page.getByLabel('API Key', { exact: true }).fill('dummy-new-target-key');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText(/配置已保存/u)).toBeVisible();
    expect(writes[0]?.configuration.customConnections[0]).toMatchObject({ apiKey: 'dummy-new-target-key', hasApiKey: false });
  });
}

test('repeated save submits once and an interrupted save is not replayed on reopening', async ({ page }) => {
  await mockSettings(page);
  let writes = 0; let release: () => void = () => {};
  const pending = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/settings', async route => {
    if (route.request().method() !== 'PUT') { await route.fulfill({ json: settingsFixture() }); return; }
    writes++;
    await pending;
    try { await route.fulfill({ json: publicSettings(route.request().postDataJSON() as SettingsWrite) }); } catch { /* Aborted request after close. */ }
  });
  await openSettings(page); await page.getByLabel('API Key', { exact: true }).fill('dummy-interrupted-save-key');
  await page.locator('.settings-form').evaluate(form => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await expect.poll(() => writes).toBe(1);
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  release();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expectNoStoredKey(page, 'dummy-interrupted-save-key');
  expect(writes).toBe(1);
});

test('model diagnostics stay visible as text on narrow screens, through settings dismissal and refresh', async ({ page }, testInfo) => {
  let failed = false;
  const detail = 'Model request failed · HTTP 400 · request ID: req-fixture · message: invalid tool name <script>window.injected=true</script> · code: invalid_request_error · credential [redacted]';
  await page.route('**/api/status', route => route.fulfill({ json: { state: failed ? 'error' : 'idle', mode: 'live', model: 'fixture-model', error: failed ? detail : null } }));
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ id: `error-fixture-${index}`, role: index % 2 ? 'assistant' : 'user', text: `历史消息 ${index}`, occurredAt: new Date(1_791_273_600_000 + index * 1000).toISOString() })), nextCursor: null } }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByText('历史消息 19', { exact: true })).toBeInViewport();
  failed = true;
  const notice = page.locator('.connection-notice');
  await expect(notice).toContainText('运行错误', { timeout: 10_000 }); await expect(notice).toContainText(detail);
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => Reflect.get(window, 'injected'))).toBeUndefined();
  await page.screenshot({ path: testInfo.outputPath('mira-model-error-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '模型设置', exact: true }).click(); await page.keyboard.press('Escape');
  await expect(notice).toContainText(detail); await expect(notice).toBeInViewport({ ratio: 1 });
  await page.reload(); await expect(notice).toContainText(detail); await expect(notice).toBeInViewport({ ratio: 1 });
  await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = 0; });
  await expect(notice).toBeInViewport({ ratio: 1 });
  failed = false; await expect(notice).toHaveCount(0, { timeout: 10_000 });
});


test('long diagnostics scroll separately without hiding the composer on a narrow screen', async ({ page }) => {
  const detail = `Model request failed · HTTP 400 · ${'validation detail '.repeat(100)} · request ID: visible-tail`;
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'error', mode: 'live', model: 'fixture-model', error: detail } }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  const notice = page.getByRole('status', { name: '运行状态与错误详情' });
  await expect(notice).toBeInViewport({ ratio: 1 });
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeInViewport();
  expect(await notice.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await notice.focus(); await page.keyboard.press('End');
  await expect.poll(() => notice.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('a landscape error banner leaves the expanded composer and send button in the viewport', async ({ page }, testInfo) => {
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'error', mode: 'live', model: 'fixture-model', error: `Model request failed · HTTP 400 · ${'validation detail '.repeat(100)}` } }));
  await page.setViewportSize({ width: 844, height: 390 }); await page.goto('/');
  const input = page.getByLabel('给 Mira 发消息', { exact: true });
  await input.fill('保留第一行草稿\n第二行草稿\n第三行草稿\n第四行草稿\n第五行草稿\n第六行草稿');
  await expect(page.getByRole('status', { name: '运行状态与错误详情' })).toBeInViewport({ ratio: 1 });
  await expect(input).toBeInViewport({ ratio: 1 });
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: testInfo.outputPath('mira-model-error-landscape.png'), fullPage: true });
});

test('external notification is a source-labelled Timeline notice with time, survives refresh and never masquerades as Mira', async ({ page }, testInfo) => {
  const text = '外部程序 backup-worker\n备份已完成。<script>window.externalNoticeExecuted=true</script>';
  const occurredAt = '2026-10-13T03:24:00.000Z';
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'idle', mode: 'synthetic', model: 'Fixture model', error: null } }));
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [{ id: '10000000-0000-4000-8000-000000000099', role: 'notice', text, occurredAt }], nextCursor: null } }));
  await page.goto('/');
  const notice = page.getByRole('article', { name: '服务通知', exact: true });
  await expect(notice).toHaveCount(1); await expect(notice).toContainText('外部程序 backup-worker');
  await expect(notice.locator('time')).toHaveAttribute('datetime', occurredAt);
  await expect(page.getByRole('article', { name: 'Mira 的消息', exact: true })).toHaveCount(0);
  await expect(page.getByText('Mira 正在处理', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => Object.hasOwn(window, 'externalNoticeExecuted'))).toBe(false);
  await page.screenshot({ path: testInfo.outputPath('external-notification-desktop.png'), fullPage: true });
  await page.reload(); await expect(notice).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(notice).toContainText('备份已完成');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('external-notification-narrow.png'), fullPage: true });
});

// Attachment UI fixtures below mock HTTP only; these do not establish the real service/model chain.
test('mocked attachments show compact odd-left image grid and protected preview with history, focus and URL cleanup', async ({ page }, testInfo) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8S8AAAAASUVORK5CYII=', 'base64');
  const files = [1, 2, 3].map(index => ({ id: `10000000-0000-4000-8000-00000000000${index}`, name: `image-${index}.png`, mimeType: 'image/png', size: png.length, sha256: 'a'.repeat(64) }));
  const protectedReads: string[] = [];
  await page.addInitScript(() => {
    const created = URL.createObjectURL.bind(URL); const revoked = URL.revokeObjectURL.bind(URL);
    const live = new Set<string>(); Object.assign(window, { attachmentUrls: live });
    URL.createObjectURL = blob => { const url = created(blob); live.add(url); return url; };
    URL.revokeObjectURL = url => { live.delete(url); revoked(url); };
  });
  await page.route('**/api/attachments/*', route => { protectedReads.push(route.request().headers()['x-mira-client'] ?? 'missing'); return route.fulfill({ body: png, contentType: 'image/png' }); });
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [{ id: 'fixture-images', role: 'assistant', text: '三张图片', occurredAt: '2026-10-13T00:00:00Z', attachments: files }], nextCursor: null } }));
  await page.goto('/');
  const tiles = page.locator('.message-row .attachment-image'); await expect(tiles).toHaveCount(3);
  await expect.poll(() => tiles.first().locator('img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const boxes = await tiles.evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width }; }));
    expect(boxes[0]!.y).toBe(boxes[1]!.y); expect(boxes[2]!.x).toBe(boxes[0]!.x); expect(boxes[2]!.y).toBeGreaterThan(boxes[0]!.y);
    expect(boxes[0]!.width).toBeLessThanOrEqual(148);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`mira-attachments-fixture-${width}.png`), fullPage: true });
  }
  const tile = page.getByRole('button', { name: '预览图片 image-1.png', exact: true }); await tile.click();
  await expect(page.getByRole('dialog')).toBeVisible(); await expect(page.getByRole('link', { name: '下载文件' })).toBeVisible();
  await expect(page.getByRole('dialog').locator('img')).toHaveAttribute('src', /^blob:/u);
  await expect.poll(() => page.evaluate(() => (window as unknown as { attachmentUrls: Set<string> }).attachmentUrls.size)).toBe(8);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as unknown as { attachmentUrls: Set<string> }).attachmentUrls.size)).toBe(6);
  await expect(tile).toBeFocused();
  await page.goForward(); await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0);
  await tile.click(); await page.getByRole('button', { name: '关闭附件预览' }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(protectedReads.every(header => header === 'web')).toBe(true);
});

test('mocked attachment-only uncertain send retains the ordered envelope across refresh and explicit retry', async ({ page }) => {
  const selectedNames = ['one.pdf', 'two.pdf'];
  const files = selectedNames.map((name, index) => ({ id: `10000000-0000-4000-8000-00000000000${index + 1}`, name, mimeType: 'application/pdf', size: 3, sha256: 'b'.repeat(64) }));
  const respondedNames: string[] = []; const posts: unknown[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>(resolve => { releaseFirst = resolve; });
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/api/attachments?*', async route => {
    expect(route.request().headers()['x-mira-client']).toBe('web');
    const name = new URL(route.request().url()).searchParams.get('name');
    const file = files.find(item => item.name === name); expect(file).toBeDefined();
    if (name === selectedNames[0]) await firstReleased;
    respondedNames.push(file!.name); await route.fulfill({ json: file });
  });
  await page.route('**/api/messages', route => { posts.push(route.request().postDataJSON()); return route.abort('failed'); });
  await page.goto('/');
  await page.getByLabel('选择附件', { exact: true }).setInputFiles([{ name: selectedNames[0]!, mimeType: 'application/pdf', buffer: Buffer.from('one') }, { name: selectedNames[1]!, mimeType: 'application/pdf', buffer: Buffer.from('two') }]);
  try {
    // Finish the second upload first: network arrival/completion order must not
    // become the attachment order selected by the user.
    await expect(page.getByRole('button', { name: '查看附件 two.pdf', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  } finally { releaseFirst(); }
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
  expect(respondedNames).toEqual(['two.pdf', 'one.pdf']);
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对并重试' })).toBeVisible();
  expect(posts).toHaveLength(1); expect(posts[0]).toMatchObject({ text: '', attachmentIds: files.map(file => file.id) });
  await page.reload(); await expect(page.getByRole('button', { name: '核对并重试' })).toBeVisible(); expect(posts).toHaveLength(1);
  await page.getByRole('button', { name: '核对并重试' }).click(); await expect.poll(() => posts.length).toBe(2); expect(posts[1]).toEqual(posts[0]);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
  const storage = await page.evaluate(() => sessionStorage.getItem('mira.pending-messages.v1'));
  expect(storage).toContain('attachmentIds'); expect(storage).not.toContain('base64');
});

test('mocked upload failures support explicit retry/removal and paste/drop; active documents are download-only', async ({ page }) => {
  let uploads = 0; const content = Buffer.from('<svg onload="alert(1)"/>');
  const file = { id: '10000000-0000-4000-8000-000000000001', name: 'unsafe.svg', mimeType: 'image/svg+xml', size: content.length, sha256: 'c'.repeat(64) };
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route('**/api/attachments?*', route => { uploads++; return uploads === 1 ? route.fulfill({ status: 500, json: { error: '上传未完成' } }) : route.fulfill({ json: file }); });
  await page.route(`**/api/attachments/${file.id}`, route => route.fulfill({ body: content, contentType: file.mimeType }));
  await page.goto('/');
  await page.locator('.composer').evaluate(element => { const clipboardData = new DataTransfer(); clipboardData.items.add(new File(['<svg onload="alert(1)"/>'], 'unsafe.svg', { type: 'image/svg+xml' })); element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true })); });
  await expect(page.getByText('上传未完成', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重新上传' }).click(); await expect(page.getByRole('button', { name: '查看附件 unsafe.svg' })).toBeVisible();
  await page.getByRole('button', { name: '查看附件 unsafe.svg' }).click();
  await expect(page.getByRole('link', { name: '下载文件' })).toBeVisible(); await expect(page.getByRole('dialog').locator('img, video, iframe, object, embed')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭附件预览' }).click();
  await page.getByRole('button', { name: '移除附件 unsafe.svg' }).click(); await expect(page.getByLabel('待发送附件')).toHaveCount(0);
  await page.locator('.composer').evaluate(element => { const dataTransfer = new DataTransfer(); dataTransfer.items.add(new File(['<svg onload="alert(1)"/>'], 'unsafe.svg')); element.dispatchEvent(new DragEvent('drop', { dataTransfer, bubbles: true, cancelable: true })); });
  await expect(page.getByLabel('待发送附件')).toBeVisible(); expect(uploads).toBe(3);
});

test('mocked historical thumbnails load only near viewport and release bytes when scrolled away', async ({ page }) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j8S8AAAAASUVORK5CYII=', 'base64');
  const file = { id: '10000000-0000-4000-8000-000000000001', name: 'historical.png', mimeType: 'image/png', size: png.length, sha256: 'd'.repeat(64) };
  let reads = 0;
  await page.route('**/api/attachments/*', route => { reads++; return route.fulfill({ body: png, contentType: 'image/png' }); });
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [
    { id: 'old-image', role: 'assistant', text: '较早的图片', occurredAt: '2026-10-12T00:00:00Z', attachments: [file] },
    ...Array.from({ length: 30 }, (_, index) => ({ id: `text-${index}`, role: 'assistant', text: `较新的消息 ${index}\n用于检验离屏图片按需加载\n消息记录依然保留`, occurredAt: `2026-10-13T00:00:${String(index).padStart(2, '0')}Z` })),
  ], nextCursor: null } }));
  await page.goto('/'); await expect(page.getByText('较新的消息 29', { exact: false })).toBeVisible();
  const tile = page.getByRole('button', { name: '预览图片 historical.png', exact: true });
  await expect(tile.locator('img')).toHaveCount(0); expect(reads).toBe(0);
  await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = 0; });
  await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/u); expect(reads).toBe(1);
  await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(tile.locator('img')).toHaveCount(0);
  await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = 0; });
  await expect(tile.locator('img')).toHaveAttribute('src', /^blob:/u); expect(reads).toBe(2);
});

test('child activity stays in settings, observes each identity and recovers refreshes without adding chat controls', async ({ page }, testInfo) => {
  const runId = '10000000-0000-4000-8000-000000000010';
  const childA = '10000000-0000-4000-8000-000000000011', childB = '10000000-0000-4000-8000-000000000012';
  const at = '2026-10-14T07:00:00.000Z';
  let stateA = 'running', failA = false, wrongOwner = false, queriesA = 0;
  const childReads: string[] = []; page.on('request', request => { if (new URL(request.url()).pathname.includes('/subagents')) childReads.push(request.url()); });
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [
    // An unexpected child field cannot add a main-chat entry point.
    { id: '10000000-0000-4000-8000-000000000013', role: 'assistant', text: '我正在核对资料。', occurredAt: at, child: { id: childA, runId } },
  ], nextCursor: null } }));
  await page.route('**/api/runs', route => route.fulfill({ json: { items: [{ id: runId, occurredAt: at, status: 'completed', requestCount: 0 }], nextCursor: null } }));
  await page.route(`**/api/runs/${runId}`, route => route.fulfill({ json: { id: runId, occurredAt: at, status: 'completed', requestCount: 0,
    requests: [], nextRequestsCursor: null, assistant: null, memory: { state: 'unavailable', commit: null }, executions: [], nextCursor: null, compactionErrors: 'not-recorded', error: null } }));
  await page.route(`**/api/runs/${runId}/subagents`, route => route.fulfill({ json: { items: [childA, childB].map(id => ({ id, runId, title: id === childA ? '核对资料' : '检查构建', createdAt: at, status: id === childA ? stateA : 'completed', current: null, updatedAt: at })), nextCursor: null } }));
  await page.route('**/api/runs/*/subagents/*', async route => {
    const url = new URL(route.request().url()); const id = url.pathname.split('/').at(-1)!;
    if (id === childA) queriesA++;
    if (id === childA && failA) { await route.fulfill({ status: 503, json: { error: 'Temporary child read failure' } }); return; }
    const state = id === childA ? stateA : 'completed';
    const summary = { id: wrongOwner && id === childA ? childB : id, runId, title: id === childA ? '核对资料' : '检查构建', createdAt: at, status: state, current: null, updatedAt: at };
    await route.fulfill({ json: url.searchParams.has('view') ? summary : { ...summary, olderTurns: 0,
      privateField: 'PRIVATE_HIDDEN_SENTINEL', turns: [{ id, sequence: 1, status: state, createdAt: at, startedAt: at, finishedAt: state === 'running' ? null : at,
        activities: [{ sequence: 1, occurredAt: at, source: 'runtime', kind: 'tool', phase: 'finished', name: 'bash', status: 'unknown', text: null }],
        droppedActivities: 0, result: state === 'completed' ? { text: id === childA ? '资料核对完成' : '构建检查完成', truncated: false } : null }] } });
  });
  await page.goto('/');
  await expect(page.getByText('我正在核对资料。', { exact: true })).toBeVisible();
  await expect(page.locator('.mira-app .child-card')).toHaveCount(0);
  for (const name of ['模型设置', '添加附件', '发送消息', '回复这条消息']) await expect(page.locator('.mira-app').getByRole('button', { name, exact: true })).toHaveCount(1);
  await expect(page.locator('.mira-app').getByRole('button', { name: /子任务|运行记录/u })).toHaveCount(0);
  expect(childReads).toEqual([]);
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '运行记录', exact: true }).click();
  await page.locator('.run-list-button').click();
  const first = page.getByRole('button', { name: '查看子任务 核对资料', exact: true });
  await expect(first).toContainText('执行中');
  await expect(page.getByRole('button', { name: '查看子任务 检查构建', exact: true })).toContainText('已完成');
  await first.click(); const dialog = page.getByRole('dialog', { name: '核对资料', exact: true });
  await expect(dialog.getByText('工具 bash · 结果未知', { exact: true })).toBeVisible();
  await expect(dialog).not.toContainText('PRIVATE_HIDDEN_SENTINEL');
  failA = true; await dialog.getByRole('button', { name: '刷新子任务', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await expect(dialog.getByText('工具 bash · 结果未知', { exact: true })).toBeVisible();
  failA = false; wrongOwner = true; await dialog.getByRole('button', { name: '刷新子任务', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('无法核对');
  wrongOwner = false; stateA = 'completed'; await dialog.getByRole('button', { name: '刷新子任务', exact: true }).click();
  await expect(dialog.getByText('资料核对完成', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('child-detail-fixture-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('child-detail-fixture-mobile.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(first).toBeFocused(); await expect(first).toContainText('已完成');
  stateA = 'running'; await expect(first).toContainText('执行中', { timeout: 10_000 });
  await page.getByRole('button', { name: '查看子任务 检查构建', exact: true }).click();
  const second = page.getByRole('dialog', { name: '检查构建', exact: true });
  await expect(second.getByText('构建检查完成', { exact: true })).toBeVisible();
  await expect(second).not.toContainText('资料核对完成');
  await second.getByRole('button', { name: '关闭', exact: true }).click();
  expect(queriesA).toBeGreaterThan(1);
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.mira-app .child-card')).toHaveCount(0);
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeEditable();
  await page.goForward();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  for (const name of ['模型设置', '添加附件', '发送消息', '回复这条消息']) await expect(page.locator('.mira-app').getByRole('button', { name, exact: true })).toHaveCount(1);
  await expect(page.locator('.mira-app').getByRole('button', { name: /子任务|运行记录/u })).toHaveCount(0);
});

test('run child pagination discovers a newly followed-up older child after all previous pages were exhausted', async ({ page }) => {
  const runId = '20000000-0000-4000-8000-000000000001', at = '2026-10-14T07:00:00.000Z';
  const id = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const item = (n: number) => ({ id: id(n), runId, title: n === 0 ? '继续早先任务' : `任务 ${n}`, createdAt: n === 0 ? '2026-10-01T00:00:00.000Z' : at, status: 'completed', current: null, updatedAt: at });
  const existing = Array.from({ length: 55 }, (_, index) => item(index + 1)); let followedUp = false;
  await page.route('**/api/runs', route => route.fulfill({ json: { items: [{ id: runId, occurredAt: at, status: 'completed', requestCount: 0 }], nextCursor: null } }));
  await page.route(`**/api/runs/${runId}`, route => route.fulfill({ json: { id: runId, occurredAt: at, status: 'completed', requestCount: 0,
    requests: [], nextRequestsCursor: null, assistant: null, memory: { state: 'unavailable', commit: null }, executions: [], nextCursor: null, compactionErrors: 'not-recorded', error: null } }));
  await page.route(/\/api\/runs\/[^/]+\/subagents(?:[/?].*)?$/, route => {
    const url = new URL(route.request().url()); const child = url.pathname.split('/subagents/')[1];
    if (child) return route.fulfill({ json: item(Number(child.slice(-12))) });
    // The API orders by first association in this run, independent of child's age.
    const ordered = followedUp ? [item(0), ...existing] : existing;
    const before = url.searchParams.get('before'); const start = before ? ordered.findIndex(entry => entry.id === before) + 1 : 0;
    const selected = ordered.slice(start, start + 50);
    return route.fulfill({ json: { items: selected, nextCursor: start + 50 < ordered.length ? selected.at(-1)!.id : null } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '运行记录', exact: true }).click(); await page.locator('.run-list-button').click();
  await expect(page.locator('.run-children .child-card')).toHaveCount(50);
  await page.getByRole('button', { name: '更多子任务', exact: true }).click();
  await expect(page.locator('.run-children .child-card')).toHaveCount(55);
  await expect(page.getByRole('button', { name: '更多子任务', exact: true })).toHaveCount(0);
  followedUp = true;
  await expect(page.locator('.run-children .child-card')).toHaveCount(56, { timeout: 10_000 });
  await expect(page.locator('.run-children .child-card').first()).toContainText('继续早先任务');
  await expect(page.getByRole('button', { name: '更多子任务', exact: true })).toHaveCount(0);
});

test('reasoning stays inside settings, adapts model capabilities and survives cancel, save, history and narrow display', async ({ page }, testInfo) => {
  const initial = settingsFixture(); initial.configuration.defaultThinkingLevel = 'xhigh';
  const { writes } = await mockSettings(page, initial);
  await page.route('**/api/models/catalog', route => route.fulfill({ json: {
    source: 'reasoning-fixture', generatedAt: null, providers: [{ id: 'openai', name: 'OpenAI', apiKeySupport: { supported: true, explanation: 'fixture' }, models: [
      { id: 'fixture-builtin', name: 'Reasoner', provider: 'openai', protocol: { id: 'openai-responses', name: 'OpenAI Responses' }, catalogBaseUrl: 'https://api.openai.com/v1', contextWindow: 100000, maxTokens: 4096, reasoning: true, thinkingLevels: ['off', 'low', 'medium', 'high'], input: ['text'] },
      { id: 'plain', name: 'Plain model', provider: 'openai', protocol: { id: 'openai-responses', name: 'OpenAI Responses' }, catalogBaseUrl: 'https://api.openai.com/v1', contextWindow: 100000, maxTokens: 4096, reasoning: false, thinkingLevels: ['off'], input: ['text'] },
    ] }],
  } }));
  await openSettings(page);
  const level = page.getByLabel('默认推理强度', { exact: true });
  await expect(level).toHaveValue('high'); await expect(level.locator('option')).toHaveCount(4);
  await expect(page.getByText(/默认偏好“很高”仍保留/)).toBeVisible();
  await level.selectOption('low'); await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '模型设置', exact: true }).click(); await expect(level).toHaveValue('high'); expect(writes).toHaveLength(0);
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('plain'); await expect(level).toHaveValue('off'); await expect(level).toBeDisabled();
  await page.getByRole('combobox', { name: '模型', exact: true }).selectOption('fixture-builtin'); await expect(level).toHaveValue('high');
  await level.selectOption('medium'); await page.getByRole('button', { name: '保存设置', exact: true }).dblclick();
  await expect(page.getByText(/配置已保存/)).toBeVisible(); expect(writes).toHaveLength(1); expect(writes[0]!.configuration.defaultThinkingLevel).toBe('medium');
  await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByLabel('默认推理强度')).toHaveCount(0);
  await page.goForward(); await expect(level).toHaveValue('medium');
  await page.setViewportSize({ width: 390, height: 844 }); await level.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mira-reasoning-narrow.png'), fullPage: true });
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('reasoning settings retain an unsaved edit on revision conflict and discard it on reload', async ({ page }) => {
  const initial = settingsFixture(); initial.configuration.customConnections[0]!.models[0]!.reasoning = true;
  initial.selection = { kind: 'custom', connection: 'existing-local', model: 'original-model' }; initial.configuration.defaultThinkingLevel = 'low';
  await mockSettings(page, initial);
  await page.route('**/api/settings', route => route.request().method() === 'PUT' ? route.fulfill({ status: 409, json: { error: 'Settings changed; reload before saving' } }) : route.fulfill({ json: initial }));
  // This fixture selects a custom connection, so the built-in provider selector is absent.
  await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const level = page.getByLabel('默认推理强度', { exact: true });
  await expect(level).toHaveValue('low'); await level.selectOption('high'); await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible(); await expect(level).toHaveValue('high');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重新读取并放弃当前编辑', exact: true }).click(); await expect(level).toHaveValue('low');
});

test('reasoning edit stays retryable when active child work makes settings temporarily busy', async ({ page }) => {
  const initial = settingsFixture(); initial.configuration.customConnections[0]!.models[0]!.reasoning = true;
  initial.selection = { kind: 'custom', connection: 'existing-local', model: 'original-model' }; initial.configuration.defaultThinkingLevel = 'low';
  await mockSettings(page, initial); let writes = 0;
  await page.route('**/api/settings', route => {
    if (route.request().method() !== 'PUT') return route.fulfill({ json: initial });
    writes++;
    return writes === 1 ? route.fulfill({ status: 409, json: { error: 'Mira is working; retry when it is idle' } }) : route.fulfill({ json: publicSettings(route.request().postDataJSON() as SettingsWrite) });
  });
  // This fixture selects a custom connection, so the built-in provider selector is absent.
  await page.goto('/'); await page.getByRole('button', { name: '模型设置', exact: true }).click();
  const level = page.getByLabel('默认推理强度', { exact: true });
  await level.selectOption('high'); await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText('Mira 或子任务仍在运行，暂时不能修改配置。编辑仍保留，等全部结束后可以再次保存。')).toBeVisible();
  await expect(level).toHaveValue('high'); await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeEnabled();
  expect(writes).toBe(1);
  await page.getByRole('button', { name: '保存设置', exact: true }).click(); await expect(page.getByText(/配置已保存/)).toBeVisible(); expect(writes).toBe(2);
});

test('request retry status survives refresh and disappears on completion without leaking provider details', async ({ page }, testInfo) => {
  let phase: 'waiting' | 'requesting' | null = 'waiting';
  await page.route('**/api/status', route => route.fulfill({ json: { state: phase ? 'working' : 'idle', mode: 'synthetic', model: 'Fixture model', error: null,
    ...(phase ? { modelRetry: { phase, attempt: 2, maxAttempts: 3, delayMs: phase === 'waiting' ? 1000 : 0, reason: 'server', raw: 'PRIVATE_PROVIDER_SENTINEL' } } : {}) } }));
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByRole('status').filter({ hasText: '等待重试（第 2/3 次）' })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('model-retry-narrow.png'), fullPage: true });
  await page.reload(); await expect(page.getByRole('status').filter({ hasText: '等待重试（第 2/3 次）' })).toBeVisible();
  phase = 'requesting'; await expect(page.getByRole('status').filter({ hasText: '正在重试模型请求（第 2/3 次）' })).toBeVisible();
  await expect(page.getByText('PRIVATE_PROVIDER_SENTINEL')).toHaveCount(0);
  phase = null; await expect(page.locator('.working-indicator')).toHaveCount(0);
  await page.reload(); await expect(page.locator('.working-indicator')).toHaveCount(0);
});

test('ordinary plugin messages use subtle source labels without impersonating Web input', async ({ page }, testInfo) => {
  const at = '2026-10-15T01:00:00Z';
  const items = [
    { id: 'plugin-in', role: 'user', text: '普通插件收到的消息', occurredAt: at, source: { kind: 'extension', extensionId: 'weather-station', label: '气象站', direction: 'inbound', senderId: 'sensor-1', senderVerified: true } },
    { id: 'plugin-out', role: 'assistant', text: '已经发出的通知', occurredAt: at, source: { kind: 'extension', extensionId: 'weather-station', label: '气象站', direction: 'outbound' } },
    { id: 'normal-final', role: 'assistant', text: '已经发出的通知', occurredAt: at },
  ];
  await page.route('**/api/timeline', route => route.fulfill({ json: { items, nextCursor: null } }));
  await page.goto('/');
  await expect(page.getByLabel('气象站 扩展消息')).toHaveCount(2);
  await expect(page.getByText('已经发出的通知', { exact: true })).toHaveCount(2);
  await expect(page.locator('.message-source')).toHaveCount(2);
  await expect(page.locator('.message-source').first()).toHaveCSS('font-size', '10px');
  const inbound = page.locator('[data-message-id="plugin-in"]');
  const source = inbound.locator('.message-source');
  await expect(source).toHaveText('气象站 · weather-station · 收到');
  await expect(source).toHaveAttribute('title', '气象站 · 收到 · 扩展 weather-station · 来源身份 sensor-1（由扩展验证）');
  await expect(inbound.locator('.message-meta')).toHaveCSS('opacity', '0');
  await inbound.hover();
  await expect(inbound.locator('.message-meta')).toHaveCSS('opacity', '1');
  await expect(page.locator('[data-message-id="plugin-out"] .message-source')).toHaveAttribute('title', '气象站 · 已发送 · 扩展 weather-station');
  await page.screenshot({ path: testInfo.outputPath('extension-source-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('extension-source-narrow.png'), fullPage: true });
  await page.reload(); await expect(page.locator('.message-source')).toHaveCount(2);
});

// The host owns visibility. This generic fixture supplies only its current public
// actions; the browser groups them without provider IDs or state-specific rules.
test('generic extension actions default to primary, collapse secondary controls and keep cancellation reachable', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const initialActions = [
    { id: 'connect', label: 'Connect generic' },
    { id: 'authorize', label: 'Authorize generic', group: 'primary' },
    { id: 'reset', label: 'Reset generic', group: 'secondary' },
  ];
  const view = {
    revision: '1'.repeat(64), fields: [{ key: 'token', label: 'Generic private token', type: 'secret', configured: true }],
    actions: initialActions, status: { state: 'disconnected' },
    operation: null as null | { id: string; action: string; state: string },
  };
  let starts = 0, cancellations = 0, failNext = false;
  await page.route('**/api/extensions', route => route.fulfill({ json: {
    available: true, releases: [], error: null, extensions: [{
      id: 'generic-fixture', revision: '1'.repeat(64), enabled: true, status: 'active', activation: 'generic-activation',
      tools: [], contextProviders: [], generated: null, error: null,
    }],
  } }));
  await page.route('**/api/extensions/generic-fixture/settings', route => route.fulfill({ json: { settings: view } }));
  await page.route('**/api/extensions/generic-fixture/settings/actions', async route => {
    starts++;
    const body = route.request().postDataJSON() as { action: string; expectedRevision: string };
    expect(body.expectedRevision).toBe(view.revision);
    if (failNext) { failNext = false; await route.abort('failed'); return; }
    view.revision = '2'.repeat(64); view.actions = []; view.status = { state: 'pending' };
    view.operation = { id: 'generic-operation', action: body.action, state: 'pending' };
    await route.fulfill({ json: { operation: view.operation } });
  });
  await page.route('**/api/extensions/generic-fixture/settings/cancel', async route => {
    cancellations++;
    expect(route.request().postDataJSON()).toEqual({ operationId: 'generic-operation' });
    view.revision = '3'.repeat(64); view.actions = initialActions; view.status = { state: 'disconnected' };
    view.operation = { id: 'generic-operation', action: 'connect', state: 'cancelled' };
    await route.fulfill({ json: { operation: view.operation } });
  });
  const openSettings = async () => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '扩展', exact: true }).click();
    await page.getByRole('button', { name: '连接设置', exact: true }).click();
  };
  await page.goto('/'); await openSettings();
  const settings = page.getByLabel('generic-fixture 连接设置');
  const more = settings.locator('summary', { hasText: '更多操作' });
  const details = settings.locator('details');
  const connect = settings.getByRole('button', { name: 'Connect generic', exact: true });
  const authorize = settings.getByRole('button', { name: 'Authorize generic', exact: true });
  const reset = settings.getByRole('button', { name: 'Reset generic', exact: true });
  const edit = settings.getByRole('button', { name: '编辑连接设置', exact: true });
  const token = settings.getByLabel('Generic private token', { exact: true });
  await expect(connect).toBeVisible(); await expect(authorize).toBeVisible();
  await expect(reset).not.toBeVisible(); await expect(edit).not.toBeVisible();
  await expect(details).not.toHaveAttribute('open');
  await page.screenshot({ path: testInfo.outputPath('generic-extension-actions-collapsed-desktop.png'), fullPage: true });
  // Native disclosure supports keyboard interaction without any settings write.
  await more.focus(); await page.keyboard.press('Enter');
  await expect(reset).toBeVisible(); await expect(edit).toBeVisible();
  await edit.click(); await token.fill('discarded-generic-draft');
  await more.click();
  await expect(token).toHaveValue('discarded-generic-draft');
  await expect(connect).toBeDisabled();
  await settings.getByRole('button', { name: '取消设置编辑', exact: true }).click();
  await expect(token).toHaveCount(0); await expect(details).not.toHaveAttribute('open');
  await more.click(); await edit.click(); await expect(token).toHaveValue('');
  await token.fill('closed-generic-draft'); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openSettings(); await expect(details).not.toHaveAttribute('open');
  await more.click(); await edit.click(); await expect(token).toHaveValue('');
  await token.fill('history-generic-draft'); await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goForward(); await page.getByRole('tab', { name: '扩展', exact: true }).click();
  await page.getByRole('button', { name: '连接设置', exact: true }).click();
  await expect(details).not.toHaveAttribute('open');
  await more.click(); await edit.click(); await expect(token).toHaveValue('');
  await settings.getByRole('button', { name: '取消设置编辑', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await reset.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('generic-extension-actions-expanded-narrow.png'), fullPage: true });
  await more.click();
  // Synchronous admission suppresses duplicate clicks, even before React rerenders.
  await connect.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(settings).toContainText('操作仍在进行');
  expect(starts).toBe(1);
  await expect(connect).toHaveCount(0); await expect(authorize).toHaveCount(0);
  await expect(details).not.toHaveAttribute('open');
  await expect(settings.getByRole('button', { name: '取消当前操作', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await openSettings();
  await expect(details).not.toHaveAttribute('open');
  await settings.getByRole('button', { name: '取消当前操作', exact: true }).click();
  await expect(settings).toContainText('操作已取消'); expect(cancellations).toBe(1);
  await expect(connect).toBeVisible();
  // An unknown action response keeps its existing reconciliation control outside
  // the collapsed group and never starts another action on its own.
  failNext = true; await more.click(); await reset.click();
  await expect(settings.getByRole('alert')).toContainText('操作结果尚未确认');
  await more.click(); await expect(connect).toBeDisabled();
  await settings.getByRole('button', { name: '重新读取并核对设置', exact: true }).click();
  await expect(connect).toBeEnabled(); expect(starts).toBe(2);
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain('generic-draft');
  expect(errors).toEqual([]);
});

test('custom discovery prefills supplied metadata, keeps unknown limits blank and makes reasoning format explicit', async ({ page }, testInfo) => {
  const initial = settingsFixture();
  initial.configuration.customConnections[0]!.models[0]!.reasoning = true; // Saved before explicit format support existed.
  const { writes } = await mockSettings(page, initial);
  let requests = 0;
  await page.route('**/api/models/discover', route => {
    requests++;
    return route.fulfill({ json: { endpoint: 'http://127.0.0.1:9999/v1/models', models: [
      { id: 'rich-model', name: 'Rich fixture', contextWindow: 64000, maxTokens: 8192, input: ['text', 'image'], reasoning: true },
      { id: 'gpt-6-luna' },
    ] } });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await expect(page.getByLabel('默认推理强度', { exact: true })).toBeEnabled();
  await expect(page.getByText('推理参数：自动（沿用接口适配）。', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await page.getByLabel('发现的候选模型', { exact: true }).selectOption('rich-model');
  await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('rich-model');
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('64000');
  await expect(page.getByLabel('最大输出', { exact: true })).toHaveValue('8192');
  await expect(page.getByLabel('输入类型', { exact: true })).toHaveValue('text-image');
  await expect(page.getByLabel('推理参数格式', { exact: true })).toHaveValue('');
  await page.getByLabel('推理参数格式', { exact: true }).selectOption('openrouter');
  await expect(page.getByLabel('默认推理强度', { exact: true })).toBeEnabled();
  await page.getByLabel('发现的候选模型', { exact: true }).selectOption('gpt-6-luna');
  await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('最大输出', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('默认推理强度', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  expect(writes).toHaveLength(0);
  await page.getByLabel('发现的候选模型', { exact: true }).selectOption('rich-model');
  await page.getByLabel('推理参数格式', { exact: true }).selectOption('openrouter');
  await page.locator('.model-editor').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('custom-model-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.model-editor').scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('custom-model-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes).toHaveLength(1); expect(requests).toBe(1);
  const saved = writes[0]!.configuration.customConnections[0]!.models;
  expect(saved).toHaveLength(2);
  expect(saved[0]!.reasoning).toBe(true); expect(saved[0]!.reasoningFormat).toBeUndefined();
  expect(saved[1]).toEqual({ id: 'rich-model', name: 'Rich fixture', contextWindow: 64000, maxTokens: 8192, reasoning: true, reasoningFormat: 'openrouter', input: ['text', 'image'] });
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByLabel('默认推理强度', { exact: true })).toBeEnabled();
});

test('empty and unsupported discovery leave manual entry available; unsupported reasoning errors remain visible without automatic retry', async ({ page }) => {
  await mockSettings(page);
  let requests = 0;
  await page.route('**/api/models/discover', route => {
    requests++;
    return requests === 1 ? route.fulfill({ json: { endpoint: 'http://127.0.0.1:9999/v1/models', models: [] } }) : route.fulfill({ status: 404, json: { error: 'Discovery unsupported' } });
  });
  await page.route('**/api/status', route => route.fulfill({ json: { state: 'error', mode: 'live', model: 'gpt-6-luna', error: "HTTP 400: litellm.UnsupportedParamsError: openai does not support parameters: ['reasoning_effort']" } }));
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await expect(page.getByText('此服务未返回候选模型，请手动填写 ID。')).toBeVisible();
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('仍可手动填写模型');
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  await expect(page.getByLabel('模型 ID', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByText(/reasoning_effort/u)).toBeVisible();
  expect(requests).toBe(2);
});

test('a single discovered candidate can be selected again after manual entry, cancellation and configured-model selection', async ({ page }) => {
  await mockSettings(page);
  await page.route('**/api/models/discover', route => route.fulfill({ json: { endpoint: 'http://127.0.0.1:9999/v1/models', models: [{ id: 'single-model', contextWindow: 64000, maxTokens: 4096 }] } }));
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  const picker = page.getByLabel('发现的候选模型', { exact: true });
  for (const action of ['manual', 'cancel', 'configured'] as const) {
    await picker.selectOption('single-model');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('single-model');
    if (action === 'manual') await page.getByRole('button', { name: '手动添加', exact: true }).click();
    if (action === 'cancel') await page.getByRole('button', { name: '取消编辑', exact: true }).click();
    if (action === 'configured') await page.getByLabel('已配置模型', { exact: true }).selectOption('original-model');
    await expect(picker).toHaveValue('');
    await picker.selectOption('single-model');
    await expect(page.getByLabel('模型 ID', { exact: true })).toHaveValue('single-model');
    await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('64000');
  }
});

test('endpoint edits preserve explicit formats for open drafts and all saved models', async ({ page }) => {
  const initial = settingsFixture(); const connection = initial.configuration.customConnections[0]!;
  const model = connection.models[0]!; model.reasoning = true; model.reasoningFormat = 'openrouter';
  connection.models.push({ ...model, id: 'second-model' });
  const { writes } = await mockSettings(page, initial);
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '编辑模型能力', exact: true }).click();
  const address = page.getByLabel('服务地址', { exact: true });
  await address.fill('http://127.0.0.1:9998/v1');
  await address.fill(connection.baseUrl);
  await expect(page.getByLabel('推理参数格式', { exact: true })).toHaveValue('openrouter');
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-original-route-key');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes[0]!.configuration.customConnections[0]!.models.every(entry => entry.reasoningFormat === 'openrouter')).toBe(true);
  await address.fill('http://127.0.0.1:9998/v1');
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-new-route-key');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes).toHaveLength(2);
  expect(writes[1]!.configuration.customConnections[0]!.models.every(entry => entry.reasoningFormat === 'openrouter')).toBe(true);
  await page.getByLabel('已配置模型', { exact: true }).selectOption('second-model');
  await page.getByRole('button', { name: '编辑模型能力', exact: true }).click();
  await expect(page.getByLabel('推理参数格式', { exact: true })).toHaveValue('openrouter');
});

test('new reasoning models can save the automatic format without a confirmation gate', async ({ page }) => {
  const { writes } = await mockSettings(page);
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '手动添加', exact: true }).click();
  await page.getByLabel('模型 ID', { exact: true }).fill('new-reasoning-model');
  await page.getByLabel('上下文窗口', { exact: true }).fill('32000');
  await page.getByLabel('最大输出', { exact: true }).fill('4096');
  await page.getByLabel('推理能力', { exact: true }).selectOption('true');
  await expect(page.getByLabel('推理参数格式', { exact: true })).toHaveValue('');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes[0]!.configuration.customConnections[0]!.models.find(entry => entry.id === 'new-reasoning-model')!.reasoningFormat).toBeUndefined();
});

test('switching away from Chat Completions removes incompatible formats from saved models and the open draft', async ({ page }) => {
  const initial = settingsFixture(); const connection = initial.configuration.customConnections[0]!;
  const model = connection.models[0]!; model.reasoning = true; model.reasoningFormat = 'openrouter';
  connection.models.push({ ...model, id: 'second-model' });
  const { writes } = await mockSettings(page, initial);
  await openSettings(page); await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '编辑模型能力', exact: true }).click();
  await page.locator('#connection-protocol').selectOption('openai-responses');
  await expect(page.getByLabel('推理参数格式', { exact: true })).toHaveCount(0);
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-native-route-key');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes[0]!.configuration.customConnections[0]!.api).toBe('openai-responses');
  expect(writes[0]!.configuration.customConnections[0]!.models.every(entry => entry.reasoningFormat === undefined)).toBe(true);
});

test('reply preview cancels and exact pending target survives reload and retry', async ({ page }, testInfo) => {
  const target = '11111111-1111-4111-8111-111111111111';
  const posts: Record<string, unknown>[] = [];
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [
    { id: target, role: 'assistant', text: '这是一条可以引用的合成消息，保留附近对话的紧凑间距。', occurredAt: '2026-10-16T03:00:00Z' },
    { id: '22222222-2222-4222-8222-222222222222', role: 'assistant', text: '这里是五分钟以内的第二条消息。', occurredAt: '2026-10-16T03:05:00Z' },
    { id: '33333333-3333-4333-8333-333333333333', role: 'user', text: '引用可以跳回原消息。', occurredAt: '2026-10-16T03:10:01Z', reply: { messageId: target, role: 'assistant', text: '这是一条可以引用的合成消息，保留附近对话的紧凑间距。' } },
  ], nextCursor: null } }));
  await page.route('**/api/messages', async route => { posts.push(route.request().postDataJSON() as Record<string, unknown>); await route.abort(); });
  await page.setViewportSize({ width: 1200, height: 850 }); await page.goto('/');
  const row = page.locator(`[data-message-id="${target}"]`);
  await expect(page.locator('.date-divider')).toHaveCount(2);
  await expect(page.locator('.message-group.compact')).toHaveCount(1);
  await expect(row.locator('.message-meta')).toHaveCSS('opacity', '0');
  await row.hover(); await expect(row.locator('.message-meta')).toHaveCSS('opacity', '1');
  await row.getByRole('button', { name: '回复这条消息' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('回复预览')).toBeVisible();
  await page.getByRole('button', { name: '取消回复' }).click();
  await expect(page.getByLabel('回复预览')).toHaveCount(0);
  await page.getByRole('button', { name: '查看引用的消息' }).click();
  await expect(row).toBeFocused();
  await row.getByRole('button', { name: '回复这条消息' }).click();
  await page.getByLabel('给 Mira 发消息', { exact: true }).fill('有针对性的合成回复');
  await page.screenshot({ path: testInfo.outputPath('reply-desktop.png'), fullPage: true });
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.getByRole('button', { name: '核对并重试' })).toBeVisible();
  expect(posts[0]?.['replyToMessageId']).toBe(target); expect(posts[0]?.['reply']).toBeUndefined();
  await page.reload();
  await page.getByRole('button', { name: '核对并重试' }).click();
  await expect.poll(() => posts.length).toBe(2); expect(posts[1]).toEqual(posts[0]);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText('有针对性的合成回复', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('reply-narrow.png'), fullPage: true });
});

test('quote navigation pages safely, has cancellation and preserves unavailable quote text', async ({ page }) => {
  const target = '11111111-1111-4111-8111-111111111111';
  let reads = 0;
  await page.route('**/api/timeline', async route => {
    if (route.request().method() === 'POST') { reads++; await route.fulfill({ json: { items: [], nextCursor: `older-${reads}` } }); return; }
    await route.fulfill({ json: { items: [{ id: '22222222-2222-4222-8222-222222222222', role: 'user', text: '合成回复', occurredAt: '2026-10-16T03:00:00Z', reply: { messageId: target, role: 'assistant', text: '仍可读的引用内容' } }], nextCursor: 'older-0' } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '查看引用的消息' }).click();
  await expect(page.getByText('暂未找到原消息。可以继续查看更早的消息，再点引用。')).toBeVisible();
  expect(reads).toBe(8); await expect(page.getByText('仍可读的引用内容', { exact: true })).toBeVisible();
  await page.route('**/api/timeline', async route => {
    if (route.request().method() === 'POST') { await new Promise(resolve => setTimeout(resolve, 1_000)); await route.fulfill({ json: { items: [], nextCursor: 'later' } }).catch(() => {}); return; }
    await route.fallback();
  });
  await page.getByRole('button', { name: '查看引用的消息' }).click();
  const cancel = page.getByRole('button', { name: '取消查找' });
  await cancel.focus(); await expect(cancel).toBeFocused();
  // Focus invalidates late send restoration but must not unmount this control before click.
  await expect(cancel).toBeVisible(); await cancel.click();
  await expect(page.getByText('查找已停止，引用内容仍保留。')).toBeVisible();
  await expect(cancel).toHaveCount(0);
  // A subsequent lookup owns a fresh controller and can still be cancelled.
  await page.getByRole('button', { name: '查看引用的消息' }).click();
  await expect(cancel).toBeVisible(); await cancel.focus(); await cancel.click();
  await expect(page.getByText('查找已停止，引用内容仍保留。')).toBeVisible();
  await expect(cancel).toHaveCount(0);
});

test('touch viewport exposes a usable reply action without hover', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: 'http://127.0.0.1:3211', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await page.goto('/');
  const reply = page.getByRole('button', { name: '回复这条消息' }).first();
  await expect(reply).toHaveCSS('opacity', '1'); await reply.tap();
  await expect(page.getByLabel('回复预览')).toBeVisible();
  await page.getByRole('button', { name: '取消回复' }).tap();
  await expect(page.getByLabel('回复预览')).toHaveCount(0);
  await context.close();
});

test('quote navigation finds an older page and focuses the original message', async ({ page }) => {
  const target = '11111111-1111-4111-8111-111111111111';
  let reads = 0;
  await page.route('**/api/timeline', route => {
    if (route.request().method() === 'POST') { reads++; return route.fulfill({ json: { items: [{ id: target, role: 'assistant', text: '分页中的原消息', occurredAt: '2026-10-15T03:00:00Z' }], nextCursor: null } }); }
    return route.fulfill({ json: { items: [{ id: '22222222-2222-4222-8222-222222222222', role: 'user', text: '合成回复', occurredAt: '2026-10-16T03:00:00Z', reply: { messageId: target, role: 'assistant', text: '分页中的原消息' } }], nextCursor: 'older' } });
  });
  await page.goto('/'); await page.getByRole('button', { name: '查看引用的消息' }).click();
  await expect(page.locator(`[data-message-id="${target}"]`)).toBeFocused();
  expect(reads).toBe(1);
  await expect(page.getByRole('button', { name: '取消查找' })).toHaveCount(0);
});

test('quote navigation stops on a repeated cursor and retains the quote after a failed page', async ({ page }) => {
  const target = '11111111-1111-4111-8111-111111111111';
  let reads = 0; let failPage = false;
  await page.route('**/api/timeline', async route => {
    if (route.request().method() === 'POST') {
      reads++;
      if (failPage) { await route.fulfill({ status: 503, json: { error: 'synthetic unavailable' } }); return; }
      const request = route.request().postDataJSON() as { before: string };
      await route.fulfill({ json: { items: [], nextCursor: request.before } }); return;
    }
    await route.fulfill({ json: { items: [{ id: '22222222-2222-4222-8222-222222222222', role: 'user', text: '合成回复', occurredAt: '2026-10-16T03:00:00Z', reply: { messageId: target, role: 'assistant', text: '失败后仍然保留的引用' } }], nextCursor: 'unchanged-cursor' } });
  });
  await page.goto('/');
  const quote = page.getByRole('button', { name: '查看引用的消息' });
  await quote.click();
  await expect(page.getByText('暂未找到原消息。可以继续查看更早的消息，再点引用。')).toBeVisible();
  expect(reads).toBe(1);
  await expect(quote).toBeEnabled();
  await expect(page.getByRole('button', { name: '取消查找' })).toHaveCount(0);
  failPage = true;
  await quote.click();
  await expect(page.getByText('暂时无法读取原消息，请稍后重试。')).toBeVisible();
  expect(reads).toBe(2);
  await expect(page.getByText('失败后仍然保留的引用', { exact: true })).toBeVisible();
  await expect(quote).toBeEnabled();
  await expect(page.getByRole('button', { name: '取消查找' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '查看更早的消息' })).toBeEnabled();
});

test('reply timeline keeps message sides and centered dividers on desktop and narrow screens', async ({ page }) => {
  const target = '11111111-1111-4111-8111-111111111111';
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [
    { id: target, role: 'assistant', text: '左侧合成消息', occurredAt: '2026-10-16T03:00:00Z' },
    { id: '22222222-2222-4222-8222-222222222222', role: 'user', text: '右侧合成回复', occurredAt: '2026-10-16T03:01:00Z', reply: { messageId: target, role: 'assistant', text: '左侧合成消息' } },
    { id: '33333333-3333-4333-8333-333333333333', role: 'notice', text: '居中的合成通知', occurredAt: '2026-10-16T03:02:00Z' },
  ], nextCursor: null } }));
  await page.addInitScript(() => sessionStorage.setItem('mira.pending-messages.v1', JSON.stringify([{ id: '44444444-4444-4444-8444-444444444444', text: '右侧待确认消息', occurredAt: '2026-10-16T03:03:00Z', replyToMessageId: '11111111-1111-4111-8111-111111111111', state: 'uncertain' }])));
  await page.goto('/');
  for (const viewport of [{ width: 1200, height: 850 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const assistant = page.locator('.message-row.assistant');
    const user = page.locator('.message-row.user:not(.pending-message)');
    const pending = page.locator('.pending-message');
    const notice = page.locator('.message-row.notice');
    await expect(assistant).toHaveCSS('display', 'flex');
    await expect(assistant).toHaveCSS('flex-direction', 'column');
    await expect(assistant).toHaveCSS('align-items', 'flex-start');
    await expect(user).toHaveCSS('align-items', 'flex-end');
    await expect(pending).toHaveCSS('align-items', 'flex-end');
    await expect(notice).toHaveCSS('align-items', 'center');
    await expect(page.locator('.date-divider')).toHaveCSS('text-align', 'center');
    await expect(page.locator('.date-divider')).toHaveCSS('color', 'rgb(166, 167, 174)');
    const a = (await assistant.boundingBox())!; const ab = (await assistant.locator('.message-bubble').boundingBox())!;
    const u = (await user.boundingBox())!; const ub = (await user.locator('.message-bubble').boundingBox())!; const uq = (await user.locator('.reply-quote').boundingBox())!;
    const p = (await pending.boundingBox())!; const pb = (await pending.locator('.message-bubble').boundingBox())!; const pq = (await pending.locator('.reply-quote').boundingBox())!;
    const n = (await notice.boundingBox())!; const nb = (await notice.locator('.message-bubble').boundingBox())!;
    expect(Math.abs(ab.x - a.x)).toBeLessThan(2);
    expect(Math.abs(ub.x + ub.width - u.x - u.width)).toBeLessThan(2);
    expect(Math.abs(uq.x + uq.width - ub.x - ub.width)).toBeLessThan(2);
    expect(uq.y + uq.height).toBeLessThanOrEqual(ub.y + 1);
    expect(Math.abs(pb.x + pb.width - p.x - p.width)).toBeLessThan(2);
    expect(pq.y + pq.height).toBeLessThanOrEqual(pb.y + 1);
    expect(Math.abs(nb.x + nb.width / 2 - n.x - n.width / 2)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const intent of ['latest', 'send', 'reply', 'compose', 'settings-history', 'attachment-history', 'article-focus', 'timeline-focus', 'timeline-wheel'] as const) {
  test(`delayed quote lookup cannot steal scroll or focus after ${intent}`, async ({ page }) => {
    const target = '11111111-1111-4111-8111-111111111111';
    let releasePage!: () => void; let pageFinished!: () => void;
    const delayedPage = new Promise<void>(resolve => { releasePage = resolve; });
    const finished = new Promise<void>(resolve => { pageFinished = resolve; });
    const bounded = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000); })]);
      } finally { clearTimeout(timer); }
    };
    let reads = 0;
    let routeFailure: unknown;
    try {
      const items = Array.from({ length: 30 }, (_, index) => ({ id: `visible-${index}`, role: 'assistant', text: `合成消息 ${index}，用于形成可滚动的消息记录。`, occurredAt: new Date(Date.UTC(2026, 9, 16, 3, index)).toISOString(), ...(index === 0 ? { reply: { messageId: target, role: 'assistant', text: '延迟读取的原消息' } } : {}) }));
      if (intent === 'attachment-history') {
        Object.assign(items[0]!, { attachments: [{ id: '55555555-5555-4555-8555-555555555555', name: 'history-fixture.txt', mimeType: 'text/plain', size: 7, sha256: 'a'.repeat(64) }] });
        await page.route('**/api/attachments/*', route => route.fulfill({ body: 'fixture', contentType: 'text/plain' }));
      }
      await page.route('**/api/timeline', async route => {
        if (route.request().method() === 'POST') {
          reads++;
          try { await bounded(delayedPage, 'delayed quote page release'); }
          catch (error) { routeFailure = error; await route.abort().catch(() => {}); pageFinished(); return; }
          try { await route.fulfill({ json: { items: [{ id: target, role: 'assistant', text: '不应抢回焦点的旧消息', occurredAt: '2026-10-15T03:00:00Z' }], nextCursor: null } }); }
          catch { /* The newer navigation intent aborted this request. */ }
          finally { pageFinished(); }
          return;
        }
        await route.fulfill({ json: { items, nextCursor: 'older-page' } });
      });
      await page.route('**/api/messages', route => route.fulfill({ json: { id: (route.request().postDataJSON() as { id: string }).id, receipt: 'inserted' } }));
      await page.goto('/');
      const input = page.getByLabel('给 Mira 发消息', { exact: true });
      const historyModal = intent === 'settings-history' || intent === 'attachment-history';
      const modalControl = intent === 'settings-history' ? page.getByRole('button', { name: '模型设置', exact: true }) : page.getByRole('button', { name: '查看附件 history-fixture.txt', exact: true });
      if (historyModal) {
        await modalControl.click(); await expect(page.getByRole('dialog')).toBeVisible();
        await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(modalControl).toBeFocused();
      }
      if (intent === 'send') await input.fill('查找期间发送的新消息');
      await page.getByRole('button', { name: '查看引用的消息' }).click();
      await expect.poll(() => reads).toBe(1);
      await expect(page.getByRole('button', { name: '取消查找' })).toBeVisible();
      if (intent === 'latest') await page.getByRole('button', { name: '回到最新消息' }).click();
      else if (intent === 'send') { await page.getByRole('button', { name: '发送消息', exact: true }).click(); await expect(input).toBeFocused(); }
      else if (intent === 'reply') { await page.locator('[data-message-id="visible-0"]').getByRole('button', { name: '回复这条消息' }).click(); await expect(input).toBeFocused(); }
      else if (intent === 'article-focus') { await page.locator('[data-message-id="visible-1"]').click(); await expect(page.locator('[data-message-id="visible-1"]')).toBeFocused(); }
      else if (intent === 'timeline-focus') { await page.locator('.timeline-scroll').focus(); await expect(page.locator('.timeline-scroll')).toBeFocused(); }
      else if (intent === 'timeline-wheel') { await page.locator('.timeline-scroll').hover(); await page.mouse.wheel(0, 120); await expect.poll(() => page.locator('.timeline-scroll').evaluate(element => element.scrollTop)).toBeGreaterThan(100); }
      else if (historyModal) {
        // Forward activates the modal through popstate/hashchange, not its button handler.
        await page.goForward(); await expect(page.getByRole('dialog')).toBeVisible();
        await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(modalControl).toBeFocused();
      }
      else { await input.click(); await input.pressSequentially('查找期间继续编辑的草稿'); await expect(input).toBeFocused(); }
      await expect(page.getByRole('button', { name: '取消查找' })).toHaveCount(0);
      const scrollAfterIntent = await page.locator('.timeline-scroll').evaluate(element => element.scrollTop);
      releasePage(); await bounded(finished, 'delayed quote page completion');
      expect(routeFailure).toBeUndefined();
      // Flush React's frame-delayed navigation path after the late page settles.
      await bounded(page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))), 'navigation frame flush');
      await expect(page.locator('.quote-highlight')).toHaveCount(0);
      await expect(page.locator(`[data-message-id="${target}"]`)).toHaveCount(0);
      await expect(page.getByText('查找已停止，引用内容仍保留。')).toHaveCount(0);
      if (intent === 'reply' || intent === 'send' || intent === 'compose') await expect(input).toBeFocused();
      if (intent === 'article-focus' || intent === 'timeline-focus' || intent === 'timeline-wheel') {
        if (intent === 'article-focus') await expect(page.locator('[data-message-id="visible-1"]')).toBeFocused();
        if (intent === 'timeline-focus') await expect(page.locator('.timeline-scroll')).toBeFocused();
        expect(Math.abs(await page.locator('.timeline-scroll').evaluate(element => element.scrollTop) - scrollAfterIntent)).toBeLessThan(2);
      }
      if (historyModal) {
        await expect(modalControl).toBeFocused();
        expect(Math.abs(await page.locator('.timeline-scroll').evaluate(element => element.scrollTop) - scrollAfterIntent)).toBeLessThan(2);
      }
      if (intent === 'compose') {
        await expect(input).toHaveValue('查找期间继续编辑的草稿');
        expect(Math.abs(await page.locator('.timeline-scroll').evaluate(element => element.scrollTop) - scrollAfterIntent)).toBeLessThan(2);
      }
      if (intent === 'latest' || intent === 'send') {
        const distance = await page.locator('.timeline-scroll').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight);
        expect(distance).toBeLessThan(5);
      }
    } finally {
      // An assertion failure must release any route still waiting on the test.
      releasePage();
      await bounded(page.unrouteAll({ behavior: 'wait' }), 'delayed quote route cleanup');
    }
  });
}


test('short desktop bubbles use their natural width while long messages stay bounded', async ({ page }) => {
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: [
    { id: 'short-assistant', role: 'assistant', text: '这里是五分钟以内的第二条消息。', occurredAt: '2026-10-16T03:00:00Z' },
    { id: 'short-user', role: 'user', text: '引用可以跳回原消息。', occurredAt: '2026-10-16T03:01:00Z' },
    { id: 'long-assistant', role: 'assistant', text: '用于验证长消息在气泡内正常换行。'.repeat(30), occurredAt: '2026-10-16T03:02:00Z' },
    { id: 'long-user', role: 'user', text: '用于验证用户长消息边界。'.repeat(30), occurredAt: '2026-10-16T03:03:00Z' },
  ], nextCursor: null } }));
  await page.setViewportSize({ width: 1200, height: 850 }); await page.goto('/');
  for (const id of ['short-assistant', 'short-user']) {
    const dimensions = await page.locator(`[data-message-id="${id}"] .message-bubble`).evaluate(element => {
      const style = getComputedStyle(element);
      return { height: element.getBoundingClientRect().height, oneLineHeight: parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) };
    });
    expect(Math.abs(dimensions.height - dimensions.oneLineHeight)).toBeLessThan(2);
  }
  for (const viewport of [{ width: 1200, height: 850 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    for (const id of ['long-assistant', 'long-user']) {
      const row = page.locator(`[data-message-id="${id}"]`);
      const bounds = (await row.boundingBox())!; const bubble = (await row.locator('.message-bubble').boundingBox())!;
      expect(bubble.x).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(bubble.x + bubble.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(await row.locator('.message-payload').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

for (const intent of ['normal', 'loaded-quote', 'paged-quote', 'settings', 'settings-history', 'settings-focus', 'status-focus', 'footer-focus', 'attachment', 'attachment-history', 'article-focus', 'timeline-focus', 'timeline-wheel'] as const) {
  test(`late send completion respects newer ${intent} intent`, async ({ page }) => {
    let releaseSend!: () => void; let releaseLookup!: () => void; let releaseRefresh!: () => void;
    const heldSend = new Promise<void>(resolve => { releaseSend = resolve; });
    const heldLookup = new Promise<void>(resolve => { releaseLookup = resolve; });
    const heldRefresh = new Promise<void>(resolve => { releaseRefresh = resolve; });
    const bounded = async <T,>(promise: Promise<T>, label: string): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), 10_000); })]); }
      finally { clearTimeout(timer); }
    };
    const target = '11111111-1111-4111-8111-111111111111';
    let sends = 0; let lookups = 0; let latestReads = 0;
    let routeFailure: unknown;
    try {
      if (intent === 'status-focus') await page.route('**/api/status', route => route.fulfill({ json: { state: 'idle', mode: 'synthetic', model: 'Fixture model', error: '可聚焦的合成状态说明' } }));
      const original = { id: target, role: 'assistant', text: '保留阅读焦点的原消息', occurredAt: '2026-10-15T03:00:00Z' };
      const attachment = { id: '55555555-5555-4555-8555-555555555555', name: 'send-intent.txt', mimeType: 'text/plain', size: 7, sha256: 'a'.repeat(64) };
      const items = [
        ...(intent === 'paged-quote' ? [] : [original]),
        ...Array.from({ length: 15 }, (_, index) => ({ id: `middle-${index}`, role: 'assistant', text: `合成阅读记录 ${index}`, occurredAt: new Date(Date.UTC(2026, 9, 16, 3, index)).toISOString() })),
        { id: 'quoted-message', role: 'assistant', text: '可跳转的引用消息', occurredAt: '2026-10-16T04:00:00Z', reply: { messageId: target, role: 'assistant', text: original.text }, attachments: [attachment] },
      ];
      await page.route('**/api/attachments/*', route => route.fulfill({ body: 'fixture', contentType: 'text/plain' }));
      await page.route('**/api/timeline', async route => {
        if (route.request().method() !== 'POST') {
          latestReads++;
          try {
            if (intent === 'paged-quote' && latestReads > 1) await bounded(heldRefresh, 'overlapping latest refresh');
            await route.fulfill({ json: { items, nextCursor: intent === 'paged-quote' ? 'older' : null } });
          } catch (error) { routeFailure = error; await route.abort().catch(() => {}); }
          return;
        }
        lookups++;
        try { await bounded(heldLookup, 'held quote page'); await route.fulfill({ json: { items: [original], nextCursor: null } }); }
        catch (error) { routeFailure = error; await route.abort().catch(() => {}); }
      });
      await page.route('**/api/messages', async route => {
        sends++;
        try { await bounded(heldSend, 'held message receipt'); await route.fulfill({ json: { id: (route.request().postDataJSON() as { id: string }).id, receipt: 'inserted' } }); }
        catch (error) { routeFailure = error; await route.abort().catch(() => {}); }
      });
      await page.goto('/');
      const input = page.getByLabel('给 Mira 发消息', { exact: true });
      const isOverlay = intent === 'settings' || intent === 'settings-history' || intent.startsWith('attachment');
      const overlayControl = intent.startsWith('settings') ? page.getByRole('button', { name: '模型设置', exact: true }) : page.getByRole('button', { name: '查看附件 send-intent.txt', exact: true });
      if (intent.endsWith('-history')) {
        await overlayControl.click(); await expect(page.getByRole('dialog')).toBeVisible();
        await page.goBack(); await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      await input.fill('具有延迟回执的新消息'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect.poll(() => sends).toBe(1); await expect(input).toBeDisabled();
      if (intent === 'loaded-quote' || intent === 'paged-quote') {
        await page.getByRole('button', { name: '查看引用的消息' }).click();
        if (intent === 'loaded-quote') await expect(page.locator(`[data-message-id="${target}"]`)).toBeFocused();
        else { await expect.poll(() => lookups).toBe(1); await expect(page.getByRole('button', { name: '取消查找' })).toBeVisible(); }
      } else if (intent === 'article-focus') { await page.locator('[data-message-id="middle-5"]').click(); await expect(page.locator('[data-message-id="middle-5"]')).toBeFocused(); }
      else if (intent === 'timeline-focus') { await page.locator('.timeline-scroll').focus(); await expect(page.locator('.timeline-scroll')).toBeFocused(); }
      else if (intent === 'timeline-wheel') { await page.locator('.timeline-scroll').hover(); const beforeWheel = await page.locator('.timeline-scroll').evaluate(element => element.scrollTop); await page.mouse.wheel(0, -120); await expect.poll(() => page.locator('.timeline-scroll').evaluate(element => element.scrollTop)).toBeLessThan(beforeWheel - 100); }
      else if (intent === 'settings-focus') { await overlayControl.focus(); await expect(overlayControl).toBeFocused(); await expect(page.getByRole('dialog')).toHaveCount(0); }
      else if (intent === 'status-focus') { await page.getByLabel('运行状态与错误详情').focus(); await expect(page.getByLabel('运行状态与错误详情')).toBeFocused(); }
      else if (intent === 'footer-focus') {
        // Change only scroll state, then isolate acquisition of footer keyboard focus.
        await page.locator('.timeline-scroll').evaluate(element => { element.scrollTop = 0; });
        const latest = page.getByRole('button', { name: '回到最新消息' });
        await expect(latest).toBeVisible(); await latest.focus(); await expect(latest).toBeFocused();
      }
      else if (isOverlay) {
        if (intent.endsWith('-history')) await page.goForward(); else await overlayControl.click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(overlayControl).toBeFocused();
      }
      const scrollBeforeReceipt = await page.locator('.timeline-scroll').evaluate(element => element.scrollTop);
      releaseSend(); await expect(input).toBeEnabled();
      await expect(page.getByText('已接收 · 等待处理', { exact: true })).toBeVisible();
      if (intent === 'paged-quote') {
        // A late send must neither steal focus nor abort the newer in-progress lookup.
        await expect(input).not.toBeFocused();
        await expect(page.getByRole('button', { name: '取消查找' })).toBeVisible();
        // Both requests are in flight before release, exercising competing React updates.
        await expect.poll(() => latestReads).toBeGreaterThanOrEqual(2);
        releaseRefresh(); releaseLookup(); await expect(page.locator(`[data-message-id="${target}"]`)).toBeFocused();
        await expect(page.locator(`[data-message-id="${target}"]`)).toHaveClass(/quote-highlight/u);
        await expect(page.getByText('暂未找到原消息。可以继续查看更早的消息，再点引用。', { exact: true })).toHaveCount(0);
        await expect(page.getByRole('button', { name: '取消查找' })).toHaveCount(0);
        expect(lookups).toBe(1);
      } else if (intent === 'loaded-quote') {
        await expect(page.locator(`[data-message-id="${target}"]`)).toBeFocused();
        expect(Math.abs(await page.locator('.timeline-scroll').evaluate(element => element.scrollTop) - scrollBeforeReceipt)).toBeLessThan(2);
      } else if (intent === 'settings-focus' || intent === 'status-focus' || intent === 'footer-focus') {
        const focused = intent === 'settings-focus' ? overlayControl : intent === 'status-focus' ? page.getByLabel('运行状态与错误详情') : page.getByRole('button', { name: '回到最新消息' });
        await expect(focused).toBeFocused();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(input).not.toBeFocused();
        expect(Math.abs(await page.locator('.timeline-scroll').evaluate(element => element.scrollTop) - scrollBeforeReceipt)).toBeLessThan(2);
      } else if (isOverlay) {
        await expect(overlayControl).toBeFocused();
        expect(Math.abs(await page.locator('.timeline-scroll').evaluate(element => element.scrollTop) - scrollBeforeReceipt)).toBeLessThan(2);
      } else if (intent === 'article-focus' || intent === 'timeline-focus' || intent === 'timeline-wheel') {
        if (intent === 'article-focus') await expect(page.locator('[data-message-id="middle-5"]')).toBeFocused();
        if (intent === 'timeline-focus') await expect(page.locator('.timeline-scroll')).toBeFocused();
        await expect(input).not.toBeFocused();
        expect(Math.abs(await page.locator('.timeline-scroll').evaluate(element => element.scrollTop) - scrollBeforeReceipt)).toBeLessThan(2);
      } else await expect(input).toBeFocused();
      expect(routeFailure).toBeUndefined();
    } finally {
      releaseSend(); releaseLookup(); releaseRefresh();
      await bounded(page.unrouteAll({ behavior: 'wait' }), 'late send route cleanup');
    }
  });
}
