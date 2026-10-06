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

// Settings interactions are deterministic browser fixtures. No credentials are
// entered and no real provider discovery/model request is made by these routes.
import type { Page } from '@playwright/test';
import type { Settings } from '../../apps/web/src/types.ts';

function settingsFixture(): Settings {
  return {
    revision: '2'.repeat(64),
    configuration: {
      builtinCredentials: { openai: { apiKeyEnv: 'ORIGINAL_OPENAI_KEY' } },
      customConnections: [{ id: 'existing-local', name: 'Existing local', baseUrl: 'http://127.0.0.1:9999/v1', api: 'openai-completions', apiKeyEnv: 'EXISTING_LOCAL_KEY', models: [{ id: 'original-model', contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ['text'] }] }],
    },
    selection: { kind: 'builtin', provider: 'openai', model: 'fixture-builtin' },
  };
}
async function mockSettings(page: Page, initial = settingsFixture()) {
  let current = structuredClone(initial); const writes: Settings[] = [];
  await page.route('**/api/models/catalog', route => route.fulfill({ json: {
    source: 'test-fixture', generatedAt: null,
    providers: [{ id: 'openai', name: 'OpenAI', apiKeySupport: { supported: true, explanation: 'fixture' }, models: [{ id: 'fixture-builtin', name: 'Fixture builtin', provider: 'openai', protocol: { id: 'openai-responses', name: 'OpenAI Responses' }, catalogBaseUrl: 'https://api.openai.com/v1', contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ['text'] }] }],
  } }));
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') { const value = route.request().postDataJSON() as Settings; writes.push(value); current = { ...value, revision: '3'.repeat(64) }; }
    await route.fulfill({ json: current });
  });
  return { writes };
}
async function openSettings(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await expect(page.getByLabel('服务商', { exact: true })).toBeVisible();
}

test('built-in selection saves only environment references and preserves other connections', async ({ page }) => {
  const fixture = settingsFixture(); const { writes } = await mockSettings(page, fixture);
  await openSettings(page);
  await page.getByLabel('服务商', { exact: true }).selectOption('openai');
  await page.getByLabel('模型', { exact: true }).selectOption('fixture-builtin');
  await page.getByLabel('API Key 环境变量名', { exact: true }).fill('WEB_OPENAI_KEY');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByText(/配置已保存/u)).toBeVisible();
  expect(writes).toHaveLength(1);
  expect(writes[0]?.selection).toEqual({ kind: 'builtin', provider: 'openai', model: 'fixture-builtin' });
  expect(writes[0]?.configuration.builtinCredentials.openai).toEqual({ apiKeyEnv: 'WEB_OPENAI_KEY' });
  expect(writes[0]?.configuration.customConnections).toEqual(fixture.configuration.customConnections);
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
});

test('manual custom models require explicit limits and capabilities and preserve existing connections', async ({ page }) => {
  const { writes } = await mockSettings(page);
  await openSettings(page);
  await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByLabel('连接名称', { exact: false }).fill('My test connection');
  await page.getByLabel('协议', { exact: true }).selectOption('openai-responses');
  await page.getByLabel('服务地址', { exact: true }).fill('https://example.test/v1');
  await page.getByLabel('API Key 环境变量名', { exact: true }).fill('CUSTOM_TEST_KEY');
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
    expect(route.request().postDataJSON().connection.apiKeyEnv).toBe('EXISTING_LOCAL_KEY');
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
  const latest = settingsFixture(); latest.revision = '4'.repeat(64); latest.configuration.builtinCredentials.openai = { apiKeyEnv: 'UPDATED_ELSEWHERE_KEY' };
  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PUT') { writes++; await route.fulfill({ status: 409, json: { error: 'Settings changed; reload before saving' } }); }
    else { reads++; await route.fulfill({ json: reads === 1 ? settingsFixture() : latest }); }
  });
  await openSettings(page); await page.getByLabel('API Key 环境变量名', { exact: true }).fill('MY_UNSAVED_KEY');
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('配置已在别处更新');
  await expect(page.getByLabel('API Key 环境变量名', { exact: true })).toHaveValue('MY_UNSAVED_KEY');
  await expect(page.getByRole('button', { name: '保存设置', exact: true })).toBeDisabled();
  expect(writes).toBe(1); expect(reads).toBe(1);
  await page.getByRole('button', { name: '重新读取并放弃当前编辑', exact: true }).click();
  await expect(page.getByLabel('API Key 环境变量名', { exact: true })).toHaveValue('UPDATED_ELSEWHERE_KEY');
  expect(reads).toBe(2); expect(writes).toBe(1);
});

test('an unfinished inactive connection can be cancelled without losing other edits', async ({ page }) => {
  const { writes } = await mockSettings(page);
  await openSettings(page); await page.getByLabel('API Key 环境变量名', { exact: true }).fill('KEEP_THIS_EDIT');
  await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '添加连接', exact: true }).click();
  await page.getByRole('button', { name: '内置服务商', exact: true }).click();
  await page.getByRole('button', { name: '保存设置', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('取消新增连接'); expect(writes).toHaveLength(0);
  await page.getByRole('button', { name: '自定义连接', exact: true }).click();
  await page.getByRole('button', { name: '取消新增连接', exact: true }).click();
  await page.getByRole('button', { name: '内置服务商', exact: true }).click();
  await expect(page.getByLabel('API Key 环境变量名', { exact: true })).toHaveValue('KEEP_THIS_EDIT');
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
