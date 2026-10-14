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
    await expect(card).toContainText('fixture_effect');
    await expect(card).toContainText('fixture-fact');
    expect(await page.content()).not.toContain('PRIVATE_CONFIG_SENTINEL');
    await card.getByRole('button', { name: '停用', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(config, 'utf8')).entries[0].enabled).toBe(false);
    await card.getByRole('button', { name: '启用', exact: true }).click();
    await expect.poll(async () => JSON.parse(await readFile(config, 'utf8')).entries[0].enabled).toBe(true);
    const beforeReload = (await readFile(log, 'utf8')).split('\n').filter(line => line === 'apply:one:initial').length;
    await card.getByRole('button', { name: '重载', exact: true }).click();
    await expect.poll(async () => (await readFile(log, 'utf8')).split('\n').filter(line => line === 'apply:one:initial').length).toBe(beforeReload + 1);
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
    await card.getByRole('button', { name: '重载', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('尚未确认此次操作的结果');
    await expect.poll(async () => (await readFile(log, 'utf8')).split('\n').filter(line => line === 'apply:one:initial').length).toBe(beforeReload + 2);
    await page.getByRole('button', { name: '重新读取并核对', exact: true }).click();
    await expect(card.getByRole('button', { name: '重载', exact: true })).toBeEnabled();
    expect((await readFile(log, 'utf8')).split('\n').filter(line => line === 'apply:one:initial').length).toBe(beforeReload + 2);
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
