import { expect, test } from '@playwright/test';

test('desktop and narrow layouts render the single Mira timeline without console errors', async ({ page }, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await expect(page.getByText('Mira，我们从这里开始吧', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '模型设置', exact: true })).toBeVisible();
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mira-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByLabel('给 Mira 发消息', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('mira-narrow.png'), fullPage: true });
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '模型设置' })).toBeVisible();
  await expect(page.getByLabel('服务商', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('mira-settings-narrow.png'), fullPage: true });
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
  await page.getByLabel('模型', { exact: true }).selectOption('fixture-builtin');
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

test('manual custom models require explicit limits and capabilities and preserve existing connections', async ({ page }) => {
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
  await expect(page.getByRole('alert')).toContainText('请明确选择推理能力和输入类型');
  expect(writes).toHaveLength(0);
  await page.getByLabel('推理能力', { exact: true }).selectOption('false');
  await page.getByLabel('输入类型', { exact: true }).selectOption('text');
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
  await expect(page.getByLabel('发现的候选模型', { exact: true })).toHaveValue('discovered-dummy-model');
  expect(discoveries).toHaveLength(1);
  expect(discoveries[0]).toMatchObject({ connection: { id: 'existing-local', apiKey: dummy } });
  expect(writes).toHaveLength(0);
  await expectNoStoredKey(page, dummy);
  await page.getByRole('button', { name: '还原此连接', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('发现的候选模型', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
  await expect(page.getByLabel('发现的候选模型', { exact: true })).toHaveValue('discovered-dummy-model');
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
  await page.route('**/api/timeline', route => route.fulfill({ json: { items: Array.from({ length: 20 }, (_, index) => ({ id: `error-fixture-${index}`, role: index % 2 ? 'assistant' : 'user', text: `历史消息 ${index}`, occurredAt: new Date(1_791_273_600_000 + index * 1000).toISOString() })), nextCursor: null, tools: [] } }));
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
