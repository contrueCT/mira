import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { getCurrentTools, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { ArtifactStore, readExtensionConfiguration, type ArtifactManifest } from '@mira/extension-host';
import type { ToolExecution } from '@mira/life';
import { decodeRecords } from '@mira/runtime-pi';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { toolName } from '../../packages/mcp-plugin/src/client.ts';
import { prepareExtensionPackage } from '../../scripts/prepare-extension-package.mts';
import { httpFixture } from '../fixtures/mcp/http.mts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = path.resolve(import.meta.dirname, '../..');
const port = 3220, origin = `http://127.0.0.1:${port}`;
const installation = 'mcp-acceptance';
const echo = toolName(installation, 'echo');
const control = `mcp_control_${createHash('sha256').update(installation).digest('hex').slice(0, 24)}`;
const secret = 'synthetic-mcp-bearer-never-real';
const installInput = '（合成测试）安装并启用本地准备的 MCP 扩展，然后执行一次 echo。';
const installReply = 'MCP 扩展已通过普通扩展流程安装并连接，echo 已执行一次。';
const restartReply = '重启后 MCP 已重新连接，刷新后的工具定义和私有凭据仍可使用。';
const unknownReply = '远端可能已执行，但响应丢失，结果尚不明确。这次调用不会自动重放。';
const call = (id: string, name: string, args: ToolCall['arguments']) => ({ ...assistant(), stopReason: 'toolUse' as const,
  content: [{ type: 'toolCall' as const, id, name, arguments: args }] });
function toolResult<T>(context: TranscriptContext, callId: string): T {
  const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === callId);
  expect(result?.role).toBe('toolResult');
  if (result?.role !== 'toolResult' || result.isError || result.content[0]?.type !== 'text') throw Error(`Missing successful result: ${callId}`);
  return JSON.parse(result.content[0].text) as T;
}

// Real browser → HTTP → isolated PostgreSQL → Wake/Pi → ordinary generated
// extension lifecycle → Cordis → official MCP SDK → local HTTP server. Only
// model outputs and the remote MCP service are synthetic. The fixture installs
// the exact-origin network tripwire; no live model, account or OAuth is used.
test('ordinary MCP installation, protected settings and unknown effects survive real browser/service/PG restarts', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let fixture: Awaited<ReturnType<typeof httpFixture>> | undefined;
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  const contexts: TranscriptContext[] = [];
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  const card = page.getByRole('article', { name: `扩展 ${installation}`, exact: true });
  const panel = page.getByRole('region', { name: `${installation} 连接设置`, exact: true });
  const openSettings = async () => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByRole('tab', { name: '扩展', exact: true }).click();
    await card.getByRole('button', { name: '连接设置', exact: true }).click();
    await expect(panel).toBeVisible();
  };
  const send = async (text: string) => {
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
  };
  const stop = async () => {
    await page.goto('about:blank');
    await app?.close(); app = undefined;
    await service?.close(); service = undefined;
  };
  try {
    // This gate fails rather than silently skipping when PostgreSQL is absent.
    db = await createTestDatabase();
    fixture = await httpFixture();
    const workspace = await prepareExtensionPackage(path.join(sourceDirectory, 'packages/mcp-plugin'), path.join(root, 'workspace'));
    const artifacts = new ArtifactStore(path.join(root, 'artifacts'));
    const checkedArtifact = await artifacts.stage(workspace.directory, workspace.entryRelative);
    const checked = await artifacts.test(checkedArtifact, { command: process.execPath, args: ['--input-type=module', '-e', "const {default: plugin} = await import('./entry.mjs'); if (plugin.name !== 'mira-mcp-plugin') throw Error('wrong export');"] });
    expect(checked.passed, checked.stderr).toBe(true); expect(checked.unchanged).toBe(true);
    const configuration = path.join(root, 'extensions.json');
    await writeFile(configuration, JSON.stringify({ entries: [], artifactsDirectory: artifacts.root }));
    const common = { connectionString: db.connectionString, schema: db.schema, miraId: 'mcp-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
    const start = async () => {
      service = await LocalWebService.open({ ...common, extensions: await readExtensionConfiguration(configuration), syntheticStream: async (_model, context) => {
        contexts.push(structuredClone(context));
        const serialized = JSON.stringify(context);
        expect(serialized).not.toContain(secret);
        expect(serialized).not.toMatch(/https:\/\/[^"\s]+\/(?:authorize|authorization)(?:[?"\s/]|$)/u);
        const declarations = getCurrentTools(context.messages);
        const records = (await db!.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
        const saved = decodeRecords(records.map(row => row.envelope)).flatMap(entry => entry.type === 'message' ? [entry.message] : []);
        expect(getCurrentTools(saved)).toEqual(declarations);
        const remote = declarations.find(tool => tool.name === echo);
        switch (contexts.length) {
          case 1:
            expect(serialized).toContain(installInput); expect(remote).toBeUndefined();
            for (const name of ['extension_stage', 'extension_manage', 'extension_inspect']) expect(declarations.some(tool => tool.name === name)).toBe(true);
            return streamOf(call('mcp-stage', 'extension_stage', { sourceRoot: workspace.directory, entryRelative: workspace.entryRelative }));
          case 2: {
            const artifact = toolResult<ArtifactManifest>(context, 'mcp-stage');
            expect(artifact.digest).toBe(checkedArtifact.digest); expect(remote).toBeUndefined();
            return streamOf(call('mcp-install', 'extension_manage', { id: installation, action: 'install', digest: artifact.digest,
              config: { transport: 'http', url: fixture!.url, protocol: '2026-07-28', auth: 'none', argsJson: '[]', toolsJson: '[]' } }));
          }
          case 3:
            expect(toolResult<{ status: string; test: string }>(context, 'mcp-install')).toMatchObject({ status: 'applied', test: 'passed' });
            expect((await readExtensionConfiguration(configuration)).entries[0]?.enabled).toBe(false);
            expect(remote).toBeUndefined(); expect(fixture!.effects()).toBe(0);
            return streamOf(call('mcp-activate', 'extension_manage', { id: installation, action: 'activate' }));
          case 4:
            expect(toolResult<{ status: string }>(context, 'mcp-activate').status).toBe('applied');
            expect(remote?.parameters).toMatchObject({ properties: { text: { type: 'string' } } });
            return streamOf(call('mcp-first-echo', echo, { text: 'browser-to-MCP' }));
          case 5:
            expect(toolResult(context, 'mcp-first-echo')).toEqual({ revision: 1, text: 'browser-to-MCP' });
            return streamOf(assistant(installReply));
          case 6:
            expect(remote?.parameters).toMatchObject({ properties: { count: { type: 'number' } } });
            return streamOf(call('mcp-current', control, { operation: 'current' }));
          case 7:
            expect(toolResult(context, 'mcp-current')).toBeNull();
            return streamOf(call('mcp-after-restart', echo, { count: 7 }));
          case 8:
            expect(toolResult(context, 'mcp-after-restart')).toEqual({ revision: 2, count: 7 });
            return streamOf(assistant(restartReply));
          case 9:
            return streamOf(call('mcp-lost-response', echo, { count: 9 }));
          case 10:
            expect(serialized).toContain('mcp-lost-response');
            expect(serialized).toContain('success or failure is unknown');
            expect(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'mcp-lost-response')).toBe(false);
            return streamOf(assistant(unknownReply));
          default: throw Error('Unexpected model request or replay');
        }
      } });
      app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
      await app.listen({ host: '127.0.0.1', port });
      await expect.poll(async () => (await service!.status()).state).toBe('idle');
      await page.goto(origin);
    };
    const counts = async () => (await db!.admin.query('SELECT (SELECT count(*) FROM life_events)::integer AS events, (SELECT count(*) FROM wake_requests)::integer AS wakes, (SELECT count(*) FROM wake_runs)::integer AS runs, (SELECT count(*) FROM tool_executions)::integer AS tools')).rows[0];
    const executions = async () => (await db!.admin.query<ToolExecution>('SELECT intent, outcome FROM tool_executions ORDER BY context_version')).rows;
    await start(); expect(contexts).toHaveLength(0);
    await send(installInput); await expect(page.getByText(installReply, { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(contexts).toHaveLength(5); expect(fixture.calls).toHaveLength(1); expect(fixture.effects()).toBe(1);
    expect(await counts()).toEqual({ events: 1, wakes: 1, runs: 1, tools: 4 });
    const initialExecutions = await executions();
    expect(initialExecutions.map(item => item.intent.toolName)).toEqual(['extension_stage', 'extension_manage', 'extension_manage', echo]);
    for (const item of initialExecutions) {
      expect(item.outcome?.callId).toBe(item.intent.callId);
      expect(item.intent.assistantRecordId).toBeTruthy();
      expect(item.outcome?.payload).toMatchObject({ role: 'toolResult', toolCallId: item.intent.callId, isError: false });
    }
    await openSettings(); await expect(panel).toContainText('已连接');
    await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Authorize', exact: true })).toHaveCount(0);
    await panel.locator('summary', { hasText: '更多操作' }).click();
    await expect(panel.getByRole('button', { name: 'Refresh tools', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();

    // A real private credential enters only through the existing settings UI.
    // Synthetic bearer mode has no account, registration or authorization flow.
    await panel.getByRole('button', { name: '编辑连接设置', exact: true }).click();
    await panel.getByLabel('HTTP authentication', { exact: true }).selectOption('bearer');
    await panel.getByLabel('Bearer token', { exact: true }).fill(secret);
    await panel.getByRole('button', { name: '保存连接设置', exact: true }).click();
    await expect(panel.getByRole('button', { name: '编辑连接设置', exact: true })).toBeVisible();
    await expect(panel).toContainText('已连接');
    expect(await readFile(configuration, 'utf8')).not.toContain(secret);
    expect(await page.content()).not.toContain(secret);
    const protectedView = await page.evaluate(async id => await (await fetch(`/api/extensions/${id}/settings`, { headers: { 'X-Mira-Client': 'web' } })).json(), installation);
    expect(JSON.stringify(protectedView)).not.toContain(secret);
    expect(protectedView.settings.fields.find((field: { key: string }) => field.key === 'bearerToken').configured).toBe(true);

    fixture.change();
    const operations: string[] = [];
    for (let repeat = 0; repeat < 2; repeat++) {
      const previousOperation = (await service!.extensionSettings(installation))?.operation?.id;
      await panel.getByRole('button', { name: 'Refresh tools', exact: true }).click();
      await expect.poll(async () => {
        const operation = (await service!.extensionSettings(installation))?.operation;
        return operation?.id !== previousOperation && operation?.state === 'succeeded';
      }).toBe(true);
      await expect(panel).toContainText('操作已完成');
      operations.push((await service!.extensionSettings(installation))!.operation!.id);
    }
    expect(new Set(operations).size).toBe(2);
    expect((await service!.extensionSettings(installation))?.status.visibleActions).toEqual(['refresh', 'disconnect']);
    expect(contexts).toHaveLength(5); expect(fixture.effects()).toBe(1);
    for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['narrow', { width: 390, height: 844 }]] as const) {
      await page.setViewportSize(viewport);
      await panel.getByRole('heading', { name: '连接与设置', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
      await expect(panel.getByRole('button', { name: 'Refresh tools', exact: true })).toBeInViewport({ ratio: 1 });
      await expect(panel.getByRole('button', { name: 'Disconnect', exact: true })).toBeInViewport({ ratio: 1 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`mcp-settings-connected-${label}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(panel).toContainText('未连接');
    await expect(panel.getByRole('button', { name: 'Refresh tools', exact: true })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Disconnect', exact: true })).toHaveCount(0);
    await panel.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(panel).toContainText('已连接');
    await expect(panel.getByRole('button', { name: 'Connect', exact: true })).toHaveCount(0);

    const beforeRestart = await counts();
    await stop(); await start();
    expect(contexts).toHaveLength(5); expect(fixture.effects()).toBe(1); expect(await counts()).toEqual(beforeRestart);
    expect((await service!.extensionSettings(installation))?.status.state).toBe('connected');
    expect((await service!.extensionSettings(installation))?.fields.find(field => field.key === 'bearerToken')?.configured).toBe(true);
    expect(await executions()).toEqual(initialExecutions);
    await send('（合成测试）检查当前 MCP 操作，再使用刷新后的 echo。');
    await expect(page.getByText(restartReply, { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(contexts).toHaveLength(8); expect(fixture.effects()).toBe(2);

    // The remote receives and performs this call, then drops the response. The
    // runtime must preserve an unknown intent and reason forward without retry.
    fixture.mode('lost');
    await send('（合成测试）执行一次 echo；若响应丢失，报告未知结果，不要重试。');
    await expect(page.getByText(unknownReply, { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(contexts).toHaveLength(10); expect(fixture.calls).toHaveLength(3); expect(fixture.effects()).toBe(3);
    const afterUnknown = await executions();
    expect(afterUnknown).toHaveLength(7);
    expect(afterUnknown.at(-1)?.intent).toMatchObject({ callId: 'mcp-lost-response', toolName: echo, arguments: { count: 9 } });
    expect(afterUnknown.at(-1)?.outcome).toBeNull();
    const unknownCounts = await counts();
    fixture.mode('normal'); await stop(); await start();
    expect(contexts).toHaveLength(10); expect(fixture.calls).toHaveLength(3); expect(fixture.effects()).toBe(3);
    expect(await executions()).toEqual(afterUnknown); expect(await counts()).toEqual(unknownCounts);
    await expect(page.getByText(unknownReply, { exact: true })).toBeVisible();
    expect((await service!.extensionSettings(installation))?.status.state).toBe('connected');

    await openSettings();
    await card.getByRole('button', { name: '停用', exact: true }).click();
    await expect.poll(async () => (await readExtensionConfiguration(configuration)).entries[0]?.enabled).toBe(false);
    await expect.poll(async () => await service!.extensionSettings(installation)).toBeNull();
    await stop(); await start();
    expect(await service!.extensionSettings(installation)).toBeNull();
    expect((await service!.extensions()).extensions.find(extension => extension.id === installation)).toMatchObject({ enabled: false, tools: [] });
    expect(contexts).toHaveLength(10); expect(fixture.calls).toHaveLength(3); expect(fixture.effects()).toBe(3);
    expect(await executions()).toEqual(afterUnknown); expect(await counts()).toEqual(unknownCounts);
    expect(JSON.stringify(contexts)).not.toContain(secret);
    expect(JSON.stringify((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows)).not.toContain(secret);
    expect(pageErrors).toEqual([]);
    await artifacts.verify(checkedArtifact);
  } finally {
    await app?.close(); await service?.close(); await fixture?.close(); await db?.close(); await rm(root, { recursive: true, force: true });
  }
});
