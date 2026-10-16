import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { getCurrentSystemMessage, getSystemMessageText, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3213;
const origin = `http://127.0.0.1:${port}`;
const call = (id: string, name: string, args: ToolCall['arguments']) => ({ ...assistant(), stopReason: 'toolUse' as const,
  content: [{ type: 'toolCall' as const, id, name, arguments: args }] });
const initialMemory = '# 关于你的记忆\n\n- 你喜欢红茶。\n- 项目使用 PostgreSQL。\n';
const nextMemory = initialMemory.replace('红茶', '绿茶');

// Browser requests are never fulfilled/mocked. Production HTTP, PostgreSQL,
// Wake/runtime, ordinary tools, files and Git run unchanged; only model outputs
// are scripted. Direct DB/file reads below verify effects rather than create them.
test('settings Memory follows browser → HTTP → PostgreSQL → ordinary tools → Git and exact request results', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-management-real-'));
  const gate = deferred();
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  const contexts: TranscriptContext[] = [];
  const errors: string[] = [];
  const posted: Array<{ id: string; text: string; occurredAt: string }> = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url() === `${origin}/api/messages`) posted.push(request.postDataJSON()); });
  try {
    db = await createTestDatabase();
    const memoryRoot = path.join(root, 'memory');
    const file = path.join(memoryRoot, 'MEMORY.md');
    await mkdir(memoryRoot); await writeFile(file, initialMemory);
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'management-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      memoryRoot, synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
    service = await LocalWebService.open({ ...options, syntheticStream: async (_model, context) => {
      contexts.push(structuredClone(context));
      const system = getCurrentSystemMessage(context.messages);
      expect(system && getSystemMessageText(system)).toContain('你喜欢红茶');
      expect(system && getSystemMessageText(system)).not.toContain('你喜欢绿茶');
      if (contexts.length === 1) {
        expect(JSON.stringify(context.messages.filter(message => message.role === 'user').at(-1))).toContain('现在喜欢绿茶');
        await gate.promise;
        return streamOf(call('management-read', 'read', { path: file }));
      }
      if (contexts.length === 2) {
        expect(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'management-read' && !message.isError)).toBe(true);
        return streamOf(call('management-edit', 'edit', { path: file, edits: [{ oldText: '你喜欢红茶', newText: '你喜欢绿茶' }] }));
      }
      if (contexts.length === 3) {
        expect(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'management-edit' && !message.isError)).toBe(true);
        return streamOf(assistant('已把偏好改为绿茶。'));
      }
      return streamOf(assistant('你希望删除哪条记忆？这次还没有修改。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.goto(origin);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('还没有可读取的 Wake 运行');
    await page.getByRole('tab', { name: '扩展', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('此服务未启用扩展管理');
    await page.getByRole('tab', { name: 'Memory', exact: true }).click();
    const summary = page.getByLabel('记忆摘要', { exact: true });
    await expect(summary).toContainText('你喜欢红茶');
    expect(contexts).toHaveLength(0);
    // Exercise real read-only empty/oversize/error states, without a mock API.
    await writeFile(file, '');
    await page.getByRole('button', { name: '刷新摘要', exact: true }).click();
    await expect(summary).toContainText('还没有记忆内容');
    await writeFile(file, 'x'.repeat(1_048_577));
    await page.getByRole('button', { name: '刷新摘要', exact: true }).click();
    await expect(summary).toContainText('暂时无法读取记忆');
    expect(await page.content()).not.toContain(root);
    await writeFile(file, initialMemory);
    await page.getByRole('button', { name: '刷新摘要', exact: true }).click();
    await expect(summary).toContainText('你喜欢红茶');
    expect(contexts).toHaveLength(0);
    await page.getByLabel('修改记忆', { exact: true }).fill('请把喝茶偏好更新为我现在喜欢绿茶。');
    await page.getByRole('button', { name: '提交记忆请求', exact: true }).dblclick();
    await expect.poll(() => contexts.length).toBe(1);
    expect(posted).toHaveLength(1);
    const firstId = posted[0]!.id;
    const result = page.getByLabel('记忆请求结果', { exact: true });
    await expect(result).not.toContainText('已把偏好改为绿茶');
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: 'Memory', exact: true }).click();
    expect(posted).toHaveLength(1);
    gate.resolve();
    await expect(result).toContainText('已把偏好改为绿茶');
    await expect(summary).toContainText('你喜欢绿茶');
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(await readFile(file, 'utf8')).toBe(nextMemory);
    const actual = await db.admin.query<{ run_id: string; completed: boolean; commit_id: string }>(
      `SELECT r.run_id, r.completed, m.commit_id FROM wake_runs r
       JOIN wake_run_requests q ON q.mira_id = r.mira_id AND q.run_id = r.run_id
       JOIN wake_requests w ON w.mira_id = q.mira_id AND w.wake_id = q.wake_id
       JOIN wake_memory_receipts m ON m.mira_id = r.mira_id AND m.run_id = r.run_id
       WHERE w.event_id = $1`, [firstId]);
    expect(actual.rows).toHaveLength(1);
    const run = actual.rows[0]!; expect(run.completed).toBe(true); expect(run.commit_id).toBeTruthy();
    const git = (...args: string[]) => execFileSync('git', ['-C', memoryRoot, ...args], { encoding: 'utf8' }).trim();
    expect(git('rev-parse', 'HEAD')).toBe(run.commit_id);
    expect(git('show', '-s', '--format=%B', run.commit_id)).toContain(`History-Id: ${run.run_id}`);
    const tools = (await db.admin.query<{ intent: { toolName: string }; outcome: unknown }>('SELECT intent, outcome FROM tool_executions ORDER BY context_version')).rows;
    expect(tools.map(row => row.intent.toolName)).toEqual(['read', 'edit']);
    expect(tools.every(row => row.outcome !== null)).toBe(true);
    expect(contexts).toHaveLength(3);

    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('已完成');
    // The run detail is selected through the real UI, not through a fabricated DTO.
    await page.getByRole('button', { name: new RegExp(run.run_id) }).click();
    await expect(page.getByRole('dialog').getByText('read', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog').getByText('edit', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('management-real-runs.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('heading', { name: 'Mira 回复', exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole('heading', { name: 'Mira 回复', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('management-real-runs-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.getByRole('tab', { name: 'Memory', exact: true }).click();
    await page.getByLabel('修改记忆', { exact: true }).fill('请删除那条记忆。');
    await page.getByRole('button', { name: '提交记忆请求', exact: true }).click();
    await expect(result).toContainText('你希望删除哪条记忆？这次还没有修改。');
    expect(await readFile(file, 'utf8')).toBe(nextMemory);
    expect(git('rev-parse', 'HEAD')).toBe(run.commit_id);
    expect(posted).toHaveLength(2);
    await page.screenshot({ path: testInfo.outputPath('management-real-memory-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(summary).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('management-real-memory-narrow.png'), fullPage: true });
    await result.getByText('你希望删除哪条记忆？这次还没有修改。', { exact: true }).scrollIntoViewIfNeeded();
    await expect(result.getByText('你希望删除哪条记忆？这次还没有修改。', { exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('management-real-memory-result-narrow.png'), fullPage: true });
    await page.goBack();
    await expect(page.getByRole('dialog')).not.toBeVisible();
    await expect(page.getByRole('article', { name: 'Mira 的消息', exact: true }).getByText('已把偏好改为绿茶。', { exact: true })).toBeVisible();
    await expect(page.getByRole('article', { name: '你的消息', exact: true })).toHaveCount(2);
    expect(errors).toEqual([]);
    // Reload the actual application and writer. Latest disk summary remains
    // visible while the model retains its durable pre-compaction Memory.
    await app.close(); app = undefined; await service.close(); service = undefined;
    service = await LocalWebService.open({ ...options, syntheticStream: (_model, context) => {
      const system = getCurrentSystemMessage(context.messages);
      expect(system && getSystemMessageText(system)).toContain('你喜欢红茶');
      return streamOf(assistant('重启后仍在同一条上下文中。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.reload();
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('继续');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('重启后仍在同一条上下文中。', { exact: true })).toBeVisible();
    expect((await db.admin.query("SELECT count(*)::int AS n FROM context_records WHERE envelope->>'kind' = 'checkpoint'")).rows[0].n).toBe(0);
  } finally {
    gate.resolve(); await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
  }
});

test('extension settings apply real lifecycle/configuration and staged update/rollback, with context in actual requests', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-management-extensions-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  try {
    const { ArtifactStore, ExtensionHost, readExtensionConfiguration } = await import('@mira/extension-host');
    const source = path.join(root, 'author'); await mkdir(source);
    const log = path.join(root, 'effects.txt');
    const config = path.join(root, 'extensions.json');
    const artifactsDirectory = path.join(root, 'artifacts');
    await writeFile(config, JSON.stringify({ entries: [], artifactsDirectory }));
    const version = async (name: string) => {
      await writeFile(path.join(source, 'entry.mjs'), `import { appendFileSync } from 'node:fs';
        const version = ${JSON.stringify(name)}; const log = ${JSON.stringify(log)};
        export default { name: 'management-fixture', apply({ mira: ctx }, config) {
          if (config?.fail) throw Error('RAW_PRIVATE_DIAGNOSTIC_SENTINEL');
          appendFileSync(log, 'apply:' + version + ':' + config.label + '\\n');
          ctx.onCleanup(() => appendFileSync(log, 'cleanup:' + version + '\\n'));
          ctx.registerContextProvider({ id: 'fixture-fact', async provide() { return { text: 'EXTENSION_FACT_' + version + '_' + config.label }; } });
          ctx.registerTool({ name: 'fixture_effect', description: 'Append a synthetic fixture effect', parameters: { type: 'object', properties: {} }, async execute() {
            appendFileSync(log, 'tool:' + version + ':' + config.label + '\\n'); return { text: 'effect recorded' };
          } });
        } };`);
    };
    const store = new ArtifactStore(artifactsDirectory);
    await version('one'); const first = await store.stage(source, 'entry.mjs');
    await version('two'); const second = await store.stage(source, 'entry.mjs');
    // Existing generated versions are setup facts. All tested controls below
    // go through the browser and production HTTP lifecycle path.
    const setup = new ExtensionHost({ ...await readExtensionConfiguration(config), receive: async () => 'inserted' });
    let originalRevision = '';
    try {
      await setup.start();
      expect((await setup.requestChange('fixture', { action: 'install', digest: first.digest, config: { label: 'initial', secret: 'PRIVATE_CONFIG_SENTINEL' } })).status).toBe('applied');
      expect((await setup.requestChange('fixture', { action: 'enable' })).status).toBe('applied');
      originalRevision = setup.inspect()[0]!.generated!.revision;
    } finally { await setup.close(); }
    db = await createTestDatabase();
    let requests = 0;
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'management-extensions', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      extensions: await readExtensionConfiguration(config), synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: (_model, context) => {
        requests++;
        expect(JSON.stringify(context.messages)).toContain('EXTENSION_FACT_one_updated');
        if (requests === 1) return streamOf(call('fixture-effect-call', 'fixture_effect', {}));
        return streamOf(assistant('扩展工具已执行。'));
      } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ host: '127.0.0.1', port });
    await page.goto(origin);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '扩展', exact: true }).click();
    const card = page.getByLabel('扩展 fixture', { exact: true });
    const reload = card.getByRole('button', { name: '重载', exact: true });
    const applyCount = async () => (await readFile(log, 'utf8')).split('\n').filter(line => line === 'apply:one:initial').length;
    await expect(card).toContainText('fixture_effect');
    await expect(card).toContainText('fixture-fact');
    expect(await page.content()).not.toContain('PRIVATE_CONFIG_SENTINEL');
    await card.getByRole('button', { name: '停用', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(config, 'utf8')).entries[0].enabled).toBe(false);
    await expect(card.getByRole('button', { name: '启用', exact: true })).toBeEnabled();
    const beforeEnable = await applyCount();
    const [enableResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === `${origin}/api/extensions/fixture` && response.request().method() === 'POST' && response.request().postDataJSON().action === 'enable'),
      card.getByRole('button', { name: '启用', exact: true }).click(),
    ]);
    expect(enableResponse.status()).toBe(200);
    expect(await enableResponse.json()).toMatchObject({ action: 'enable', status: 'applied', runtime: { enabled: true, status: 'active' } });
    await expect.poll(async () => JSON.parse(await readFile(config, 'utf8')).entries[0].enabled).toBe(true);
    // Desired configuration is saved before apply. The real receipt and ready
    // controls establish completion before recording the next operation's baseline.
    await expect(reload).toBeEnabled();
    await expect.poll(applyCount).toBe(beforeEnable + 1);
    const beforeReload = await applyCount();
    const [reloadResponse] = await Promise.all([
      page.waitForResponse(response => response.url() === `${origin}/api/extensions/fixture` && response.request().method() === 'POST' && response.request().postDataJSON().action === 'reload'),
      reload.click(),
    ]);
    expect(reloadResponse.status()).toBe(200);
    expect(await reloadResponse.json()).toMatchObject({ action: 'reload', status: 'applied', runtime: { enabled: true, status: 'active' } });
    await expect(reload).toBeEnabled();
    await expect.poll(applyCount).toBe(beforeReload + 1);
    // Lose one response only after production HTTP/lifecycle has applied it.
    // route.fetch reaches the real server; no response body is fabricated.
    let droppedReload = false;
    await page.route(`${origin}/api/extensions/fixture`, async route => {
      if (!droppedReload && route.request().method() === 'POST' && route.request().postDataJSON().action === 'reload') {
        droppedReload = true;
        const response = await route.fetch(); expect(response.status()).toBe(200);
        await route.abort('connectionreset');
      } else await route.continue();
    });
    await reload.click();
    await expect(page.getByRole('dialog')).toContainText('尚未确认此次操作的结果');
    await expect.poll(applyCount).toBe(beforeReload + 2);
    await page.getByRole('button', { name: '重新读取并核对', exact: true }).click();
    await expect(reload).toBeEnabled();
    expect(await applyCount()).toBe(beforeReload + 2);
    await page.unroute(`${origin}/api/extensions/fixture`);
    await card.getByRole('button', { name: '替换配置', exact: true }).click();
    await card.getByLabel('完整扩展配置', { exact: true }).fill('{"label":"updated","secret":"REPLACED_CONFIG_SENTINEL"}');
    await card.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(config, 'utf8')).entries[0].config.label).toBe('updated');
    await expect(card.getByLabel('完整扩展配置', { exact: true })).toHaveCount(0);
    await card.getByText('更新与回滚', { exact: true }).click();
    await card.getByLabel('已暂存版本', { exact: true }).selectOption(second.digest);
    await card.getByRole('button', { name: '应用已暂存更新', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(config, 'utf8')).entries[0].generated.digest).toBe(second.digest);
    await expect.poll(async () => await readFile(log, 'utf8')).toContain('apply:two:updated');
    // Roll back to the saved first-version/config revision selected by the user.
    // The config change made its own revision, which the UI lists by identity.
    const saved = JSON.parse(await readFile(config, 'utf8'));
    const prior = saved.entries[0].generated.history.find((entry: { id: string; digest: string; config: { label: string } }) => entry.id !== originalRevision && entry.digest === first.digest && entry.config.label === 'updated');
    expect(prior).toBeTruthy();
    await card.getByLabel('历史激活修订', { exact: true }).selectOption(prior.id);
    await card.getByRole('button', { name: '回滚到所选修订', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(config, 'utf8')).entries[0].generated.digest).toBe(first.digest);
    await page.screenshot({ path: testInfo.outputPath('management-real-extensions.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await card.getByRole('button', { name: '回滚到所选修订', exact: true }).scrollIntoViewIfNeeded();
    await expect(card.getByRole('button', { name: '回滚到所选修订', exact: true })).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath('management-real-extensions-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('请执行测试扩展工具。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('扩展工具已执行。', { exact: true })).toBeVisible();
    expect(await readFile(log, 'utf8')).toContain('tool:one:updated');
    expect((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n).toBe(1);
    expect(requests).toBe(2);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '扩展', exact: true }).click();
    await card.getByRole('button', { name: '替换配置', exact: true }).click();
    await card.getByLabel('完整扩展配置', { exact: true }).fill('{"label":"broken","fail":true}');
    await card.getByRole('button', { name: '保存配置', exact: true }).click();
    await expect(card).toContainText('失败');
    expect(await page.content()).not.toContain('RAW_PRIVATE_DIAGNOSTIC_SENTINEL');
    expect(await page.content()).not.toContain('REPLACED_CONFIG_SENTINEL');
  } finally { await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});

test('a real Wake paginates original and supplemental requests separately from execution records through the settings UI', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-management-members-'));
  const hold = deferred();
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  let modelRequests = 0;
  let memberPageReads = 0;
  page.on('request', request => { if (/\/api\/runs\/[^/]+\/requests\?before=/u.test(request.url())) memberPageReads++; });
  try {
    db = await createTestDatabase();
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'management-members', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      dreaming: { enabled: false }, autoCompaction: { enabled: false }, syntheticStream: async () => {
        modelRequests++;
        if (modelRequests === 1) await hold.promise;
        return streamOf(assistant(`批次 ${modelRequests} 已处理。`));
      } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.goto(origin);
    const composer = page.getByLabel('给 Mira 发消息', { exact: true });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    await composer.fill('先保持这轮处理中，后面会继续发送信息。'); await send.click();
    await expect.poll(() => modelRequests).toBe(1);
    // Every source request originates in the real composer. The first model is
    // held so production receipt binding, rather than fixture rows, adds live inputs.
    for (let i = 0; i < 55; i++) {
      await composer.fill(`真实合并请求 ${i + 1}`);
      await send.click();
      await expect(composer).toHaveValue('');
    }
    hold.resolve();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(modelRequests).toBe(2);
    const memberRun = (await db.admin.query<{ run_id: string; n: number }>('SELECT run_id, count(*)::int AS n FROM wake_run_requests GROUP BY run_id HAVING count(*) = 56')).rows;
    expect(memberRun).toHaveLength(1);
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '运行记录', exact: true }).click();
    await page.getByRole('button', { name: new RegExp(memberRun[0]!.run_id) }).click();
    const triggers = page.getByRole('heading', { name: '触发来源', exact: true }).locator('..');
    await expect(triggers.locator('li')).toHaveCount(50);
    await page.getByRole('button', { name: '更多触发请求', exact: true }).dblclick();
    await expect(triggers.locator('li')).toHaveCount(56);
    await expect(page.getByRole('button', { name: '更多触发请求', exact: true })).toHaveCount(0);
    expect(memberPageReads).toBe(1);
    const renderedIds = await triggers.locator('.technical-id').allTextContents();
    expect(new Set(renderedIds).size).toBe(56);
    const members = (await db.admin.query<{ history_id: string }>(`SELECT e.history_id FROM wake_run_requests q JOIN wake_requests w ON w.mira_id=q.mira_id AND w.wake_id=q.wake_id JOIN life_events e ON e.mira_id=w.mira_id AND e.event_id=w.event_id WHERE q.run_id=$1`, [memberRun[0]!.run_id])).rows;
    expect([...renderedIds].sort()).toEqual(members.map(member => member.history_id).sort());
    expect((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n).toBe(56);
  } finally { hold.resolve(); await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});

test('extension private settings traverse real browser, HTTP, Cordis and PostgreSQL without exposing credentials', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-settings-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  const secret = 'synthetic-extension-secret-e2e';
  const delayedParentPoll = deferred();
  let parentPollWaiting = false;
  const source = path.join(root, 'settings-extension.mjs');
  const configurationFile = path.join(root, 'extensions.json');
  const contexts: TranscriptContext[] = [];
  try {
    db = await createTestDatabase();
    await writeFile(source, `import {defineExtension} from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
      export default defineExtension({name:'settings-fixture',apply(ctx,config){
        const disconnected=()=>({state:'disconnected',visibleActions:['connect','authorize']});
        let status=disconnected(); let authorizationRequests=0;
        const settingsActions = ctx.registerSettings({fields:[{key:'appId',label:'Application ID',type:'text'},{key:'token',label:'Private token',type:'secret'},...['constructor','toString','valueOf'].map(key=>({key,label:'Private '+key,type:'secret'}))],
          actions:[{id:'connect',label:'Connect fixture',async execute({signal}){ if(!await ctx.credentials.has('token'))throw Error('missing'); for(const key of ['constructor','toString','valueOf'])if(await ctx.credentials.get(key)!=='synthetic-'+key)throw Error('prototype credential missing'); status={state:'connected',visibleActions:['authorize','disconnect']};}},
          {id:'disconnect',label:'Disconnect fixture',group:'secondary',async execute(){status=disconnected();}},
          {id:'authorize',label:'Authorize fixture',group:'primary',async execute({signal}){status={state:'pending',visibleActions:[],authorization:{url:'https://example.com/authorize?challenge=synthetic-public-'+(++authorizationRequests),label:'Official authorization',qr:true}}; await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})); status=disconnected();}}],status:()=>status});
        ctx.registerTool({name:'start_fixture',description:'Start plugin authorization',parameters:{type:'object'},async execute(){return {text:JSON.stringify(await settingsActions.start('authorize'))}}});
        ctx.registerTool({name:'start_hidden_fixture',description:'Check hidden settings action',parameters:{type:'object'},async execute(){try{await settingsActions.start('disconnect');return {text:'unexpected hidden settings action start'}}catch{return {text:'hidden settings action refused'}}}});
        ctx.registerTool({name:'check_fixture',description:'Check connection',parameters:{type:'object'},async execute(){return {text:status.state}}});
        ctx.onCleanup(()=>{status={state:'disconnected'}});
      }});`);
    const entries = [{ id: 'settings-fixture', path: source, config: { appId: 'initial' } }];
    await writeFile(configurationFile, JSON.stringify({ entries }));
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'extension-settings-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root,'spool'), settingsFile:path.join(root,'models.json'),
      synthetic:true, dreaming:{enabled:false}, autoCompaction:{enabled:false}, extensions:{entries,configurationFile},
      syntheticStream: (_model,context)=>{ contexts.push(structuredClone(context)); return streamOf(contexts.length === 1 ? call('settings-tool-hidden', 'start_hidden_fixture', {}) : contexts.length === 2 ? call('settings-tool-start', 'start_fixture', {}) : assistant('Synthetic settings checked.')); },
    });
    app = createLocalHttp({backend:service,port,assetsDirectory:path.join(sourceDirectory,'apps/web/dist')});
    await app.listen({port,host:'127.0.0.1'});
    await page.goto(origin);
    await page.getByRole('button',{name:'模型设置',exact:true}).click();
    await page.getByRole('tab',{name:'扩展',exact:true}).click();
    await page.getByRole('button',{name:'连接设置',exact:true}).click();
    const connectionSettings = page.getByLabel('settings-fixture 连接设置');
    const moreActions = connectionSettings.locator('summary', { hasText: '更多操作' });
    await expect(page.getByRole('button',{name:'Connect fixture',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'Authorize fixture',exact:true})).toBeVisible();
    await expect(page.getByRole('button',{name:'编辑连接设置',exact:true})).not.toBeVisible();
    await moreActions.click();
    await page.getByRole('button',{name:'编辑连接设置',exact:true}).click();
    await page.getByLabel('Private token',{exact:true}).fill('discarded-draft');
    await moreActions.click();
    await expect(page.getByLabel('Private token',{exact:true})).toHaveValue('discarded-draft');
    await page.getByRole('button',{name:'取消设置编辑',exact:true}).click();
    await moreActions.click();
    await page.getByRole('button',{name:'编辑连接设置',exact:true}).click();
    await expect(page.getByLabel('Private token',{exact:true})).toHaveValue('');
    await page.getByLabel('Application ID',{exact:true}).fill('saved-id');
    // Keep the parent's slower activation refresh behind a deterministic barrier.
    await page.route(`${origin}/api/extensions`, async route => {
      if (route.request().method() === 'GET') { parentPollWaiting = true; await delayedParentPoll.promise; }
      await route.continue();
    });
    await page.getByLabel('Private token',{exact:true}).fill(secret);
    for (const key of ['constructor', 'toString', 'valueOf']) {
      const input = page.getByLabel('Private ' + key, {exact:true});
      await expect(input).toBeEnabled(); await expect(input).toHaveValue('');
      await input.fill('synthetic-' + key);
    }
    await page.getByRole('button',{name:'保存连接设置',exact:true}).click();
    await expect(page.getByRole('button',{name:'编辑连接设置',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'编辑连接设置',exact:true}).click();
    await page.getByLabel('Private token',{exact:true}).fill('transient-next-draft');
    await expect.poll(() => parentPollWaiting, {timeout:10000}).toBe(true);
    const refreshedParent = page.waitForResponse(response => response.url() === `${origin}/api/extensions` && response.request().method() === 'GET');
    delayedParentPoll.resolve(); await (await refreshedParent).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    // A delayed parent activation A→B refresh must not remount the already
    // reconciled child and silently discard its new draft.
    await expect(page.getByLabel('Private token',{exact:true})).toHaveValue('transient-next-draft');
    await page.getByRole('button',{name:'取消设置编辑',exact:true}).click();
    await page.unroute(`${origin}/api/extensions`);
    // An unrelated ordinary edit must leave every blank secret unchanged, even
    // when its supported schema key is an Object.prototype property name.
    await page.getByRole('button',{name:'编辑连接设置',exact:true}).click();
    for (const key of ['constructor', 'toString', 'valueOf']) {
      const input = page.getByLabel('Private ' + key, {exact:true});
      await expect(input).toBeEnabled(); await expect(input).toHaveValue('');
      await expect(input).toHaveAttribute('placeholder', '已保存，留空保持不变');
    }
    await page.getByLabel('Application ID',{exact:true}).fill('ordinary-edit-only');
    await page.getByRole('button',{name:'保存连接设置',exact:true}).click();
    await expect(page.getByRole('button',{name:'编辑连接设置',exact:true})).toBeVisible();
    const staleSettingsRevision = await page.evaluate(async () => (await (await fetch('/api/extensions/settings-fixture/settings', { headers: { 'X-Mira-Client': 'web' } })).json()).settings.revision as string);
    await page.getByRole('button',{name:'Connect fixture',exact:true}).click();
    await expect(connectionSettings).toContainText('已连接');
    // The old UI revision and a fresh request for the now-hidden action both
    // traverse protected HTTP and the actual Host admission path.
    const rejectedStarts = await page.evaluate(async staleRevision => {
      const base = '/api/extensions/settings-fixture/settings';
      const current = (await (await fetch(base, { headers: { 'X-Mira-Client': 'web' } })).json()).settings;
      const statuses = [];
      for (const expectedRevision of [staleRevision, current.revision]) {
        const response = await fetch(base + '/actions', { method: 'POST', headers: { 'X-Mira-Client': 'web', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'connect', expectedRevision }) });
        statuses.push(response.status);
      }
      const after = (await (await fetch(base, { headers: { 'X-Mira-Client': 'web' } })).json()).settings;
      return { statuses, beforeOperation: current.operation, afterOperation: after.operation };
    }, staleSettingsRevision);
    expect(rejectedStarts.statuses).toEqual([409, 503]);
    expect(rejectedStarts.afterOperation).toEqual(rejectedStarts.beforeOperation);
    await expect(page.getByRole('button',{name:'Connect fixture',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'Disconnect fixture',exact:true})).toBeVisible();
    await moreActions.click();
    await expect(page.getByRole('button',{name:'Disconnect fixture',exact:true})).not.toBeVisible();
    await expect(page.getByRole('button',{name:'编辑连接设置',exact:true})).not.toBeVisible();
    await expect(page.getByRole('button',{name:'Authorize fixture',exact:true})).toBeVisible();
    await connectionSettings.scrollIntoViewIfNeeded();
    await page.screenshot({path:testInfo.outputPath('extension-grouped-actions-collapsed-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await moreActions.click();
    await page.getByRole('button',{name:'Disconnect fixture',exact:true}).scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('extension-grouped-actions-expanded-narrow.png'),fullPage:true});
    await page.getByRole('button',{name:'Disconnect fixture',exact:true}).click();
    await expect(connectionSettings).toContainText('未连接');
    await expect(page.getByRole('button',{name:'Disconnect fixture',exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'Connect fixture',exact:true}).click();
    await expect(connectionSettings).toContainText('已连接');
    await moreActions.click();
    await page.setViewportSize({width:1440,height:1000});
    expect(await readFile(configurationFile,'utf8')).not.toContain(secret);
    const protectedView = await page.evaluate(async()=>await (await fetch('/api/extensions/settings-fixture/settings',{headers:{'X-Mira-Client':'web'}})).text());
    expect(protectedView).not.toContain(secret); expect(protectedView).toContain('configured');
    await page.getByRole('button',{name:'Authorize fixture',exact:true}).click();
    await expect(page.getByRole('img',{name:'授权二维码'})).toBeVisible();
    await expect(page.getByRole('button',{name:'Authorize fixture',exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'取消当前操作',exact:true})).toBeVisible();
    await expect(connectionSettings.locator('details')).not.toHaveAttribute('open');
    const authorizationLink = page.getByRole('link', {name:'Official authorization', exact:true});
    await expect(authorizationLink).toHaveCSS('color', 'rgb(84, 121, 165)');
    await expect(authorizationLink).toHaveCSS('text-decoration-line', 'none');
    await authorizationLink.hover();
    await expect(authorizationLink).toHaveCSS('text-decoration-line', 'underline');
    await page.keyboard.press('Tab'); // Switch to keyboard modality before focusing.
    await authorizationLink.focus();
    await expect(authorizationLink).toHaveCSS('outline-style', 'solid');
    await expect(authorizationLink).toHaveCSS('outline-width', '3px');
    await expect(authorizationLink).toHaveCSS('outline-color', 'rgb(84, 121, 165)');
    await authorizationLink.blur();
    await page.mouse.move(0, 0);
    await page.screenshot({path:testInfo.outputPath('extension-settings-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('img',{name:'授权二维码'}).scrollIntoViewIfNeeded();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath('extension-settings-narrow.png'),fullPage:true});
    await page.getByRole('button',{name:'取消当前操作',exact:true}).click();
    await expect(page.getByLabel('settings-fixture 连接设置')).toContainText('操作已取消');
    // Reusing a declared action calls its handler again; it does not redraw the old URL.
    await page.getByRole('button',{name:'Authorize fixture',exact:true}).click();
    await expect(authorizationLink).toHaveAttribute('href', 'https://example.com/authorize?challenge=synthetic-public-2');
    await page.getByRole('button',{name:'取消当前操作',exact:true}).click();
    await expect(page.getByLabel('settings-fixture 连接设置')).toContainText('操作已取消');
    await page.getByRole('button',{name:'关闭设置',exact:true}).click();
    await page.getByLabel('给 Mira 发消息',{exact:true}).fill('Check synthetic settings.');
    await page.getByRole('button',{name:'发送消息',exact:true}).click();
    await expect.poll(()=>contexts.length).toBe(3);
    expect(JSON.stringify(contexts)).toContain('hidden settings action refused');
    expect(JSON.stringify(contexts)).not.toContain('unexpected hidden settings action start');
    expect(JSON.stringify(contexts)).not.toContain(secret);
    expect(JSON.stringify(contexts)).not.toContain('https://example.com/authorize');
    await page.getByRole('button',{name:'模型设置',exact:true}).click();
    await page.getByRole('tab',{name:'扩展',exact:true}).click();
    await page.getByRole('button',{name:'连接设置',exact:true}).click();
    await expect(page.getByLabel('settings-fixture 连接设置')).toContainText('操作仍在进行');
    await expect(page.getByRole('link',{name:'Official authorization',exact:true})).toHaveAttribute('href', 'https://example.com/authorize?challenge=synthetic-public-3');
    const pendingOperation = await page.evaluate(async()=> (await (await fetch('/api/extensions/settings-fixture/settings',{headers:{'X-Mira-Client':'web'}})).json()).settings.operation);
    expect(pendingOperation.state).toBe('pending');
    expect(JSON.stringify(contexts)).toContain(pendingOperation.id);
    await page.getByRole('button',{name:'取消当前操作',exact:true}).click();
    await expect(page.getByLabel('settings-fixture 连接设置')).toContainText('操作已取消');
    const history = await db.admin.query('SELECT intent, outcome FROM tool_executions');
    expect(JSON.stringify(history.rows)).not.toContain(secret);
    expect(JSON.stringify(history.rows)).not.toContain('https://example.com/authorize');
    expect(history.rows).toHaveLength(2);
    expect(JSON.stringify(history.rows)).toContain('hidden settings action refused');
    expect(await page.evaluate(()=>JSON.stringify([localStorage,sessionStorage]))).not.toContain(secret);
  } finally { delayedParentPoll.resolve(); await app?.close(); await service?.close(); await db?.close(); await rm(root,{recursive:true,force:true}); }
});


test('custom model discovery and format survive real browser save, PostgreSQL runtime and restart', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-model-settings-real-'));
  const key = 'synthetic-model-settings-private-key';
  const payloads: Record<string, unknown>[] = []; let discoveries = 0;
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  const provider = createServer(async (request, response) => {
    if (request.headers.authorization !== `Bearer ${key}`) { response.writeHead(401); response.end(); return; }
    if (request.url === '/v1/models') {
      discoveries++; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'fixture-effort', name: 'Fixture reasoning model', context_length: 100000, top_provider: { max_completion_tokens: 4096 }, reasoning: true, input: ['text'] }] })); return;
    }
    let raw = ''; for await (const chunk of request) raw += chunk.toString();
    payloads.push(JSON.parse(raw));
    response.setHeader('content-type', 'text/event-stream');
    const events = [{ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Configured reasoning format works.' }, finish_reason: null }] }, { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    response.end(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
  });
  await new Promise<void>((resolve, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', resolve); });
  const address = provider.address(); if (!address || typeof address === 'string') throw Error('Missing fixture address');
  try {
    db = await createTestDatabase();
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'model-settings-real', sourceDirectory, workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), dreaming: { enabled: false }, autoCompaction: { enabled: false } };
    service = await LocalWebService.open(options);
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') }); await app.listen({ host: '127.0.0.1', port });
    await page.goto(origin); await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('button', { name: '自定义连接', exact: true }).click();
    await page.getByRole('button', { name: '添加连接', exact: true }).click();
    await page.getByLabel('服务地址', { exact: true }).fill(`http://127.0.0.1:${address.port}/v1`);
    await page.getByLabel('API Key', { exact: true }).fill(key);
    await page.getByRole('button', { name: '获取可用模型', exact: true }).click();
    await page.getByLabel('发现的候选模型', { exact: true }).selectOption('fixture-effort');
    await expect(page.getByLabel('上下文窗口', { exact: true })).toHaveValue('100000');
    await expect(page.getByLabel('最大输出', { exact: true })).toHaveValue('4096');
    await page.getByLabel('推理参数格式', { exact: true }).selectOption('openrouter');
    await page.getByLabel('默认推理强度', { exact: true }).selectOption('high');
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText(/配置已保存/u)).toBeVisible();
    expect(discoveries).toBe(1); expect(payloads).toHaveLength(0);
    await page.screenshot({ path: testInfo.outputPath('model-settings-real-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('model-settings-real-narrow.png'), fullPage: true });
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain(key);
    expect(JSON.stringify(await service.settings())).not.toContain(key);
    await app.close(); app = undefined; await service.close(); service = undefined;
    service = await LocalWebService.open(options);
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') }); await app.listen({ host: '127.0.0.1', port });
    await page.goto(origin); await page.getByLabel('给 Mira 发消息', { exact: true }).fill('Use configured model.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('Configured reasoning format works.', { exact: true })).toBeVisible();
    expect(payloads).toHaveLength(1); expect(payloads[0]!['reasoning_effort']).toBeUndefined();
    expect(payloads[0]!['reasoning']).toEqual({ effort: 'high' });
    expect(payloads[0]!['model']).toBe('fixture-effort');
    const rows = await db.admin.query('SELECT envelope FROM context_records');
    expect(JSON.stringify(rows.rows)).not.toContain(key);
  } finally {
    await app?.close(); await service?.close(); await db?.close();
    await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
