import { retryConfiguration, retrySelection, retryResponse, retryFailure, syntheticRetryKey } from '../recovery/model-retry-fixtures.mts';
import { access, mkdir, mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { getCurrentSystemPrompt, getCurrentTools, type JsonObject, type TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService, WebSettingsStore } from '@mira/server';
import { readExtensionConfiguration } from '@mira/extension-host';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, model, streamOf } from '../recovery/fixtures.mts';
import { fullOutput, largeToolText, outputPath } from '../recovery/tool-output-fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3216, origin = `http://127.0.0.1:${port}`;
const exists = (file: string) => access(file).then(() => true, () => false);

async function expectConversationOnly(page: Page) {
  await expect(page.locator('.mira-app .child-card')).toHaveCount(0);
  await expect(page.locator('.mira-app').getByRole('button', { name: /^查看子任务/u })).toHaveCount(0);
  // Every rendered row must retain ordinary text or an explicit attachment.
  await expect(page.locator('.message-row:not(:has(.message-bubble)):not(:has(.attachment-grid))')).toHaveCount(0);
}
async function openRunChildren(page: Page, runId: string) {
  await page.getByRole('button', { name: '模型设置', exact: true }).click();
  await page.getByRole('tab', { name: '运行记录', exact: true }).click();
  await page.locator('.run-list-button').filter({ hasText: runId }).click();
  await expect(page.getByRole('article', { name: '运行详情', exact: true })).toBeVisible();
}
async function closeSettings(page: Page) {
  await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '设置', exact: true })).toHaveCount(0);
  await expectConversationOnly(page);
}

test('chat stays conversation-only while settings show child activity; child result and user steering enter at one real tool boundary while due reminder stays queued and never repeat after restart', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-capabilities-browser-'));
  const previousHome = process.env['HOME'];
  const userHome = path.join(root, 'user-home');
  const globalSkill = path.join(userHome, '.agents', 'skills', 'global-capabilities-fixture', 'SKILL.md');
  const started = path.join(root, 'started'), release = path.join(root, 'release'), effect = path.join(root, 'effect'), forbidden = path.join(root, 'forbidden');
  const childToolStarted = path.join(root, 'child-tool-started'), childToolRelease = path.join(root, 'child-tool-release');
  const childRelease = deferred(); const parentContexts: TranscriptContext[] = []; let childCalls = 0;
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  const config = path.join(root, 'extensions.json');
  await writeFile(config, JSON.stringify({ entries: [{ id: 'reminders', path: path.join(sourceDirectory, 'examples/extensions/reminders.ts') }] }));
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'joined-parent', sourceDirectory,
    workingDirectory: root, miraHome: root, memoryRoot: path.join(root, 'Memory'), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    synthetic: true, syntheticModel: { ...model, contextWindow: 100_000 }, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
  const start = async () => {
    service = await LocalWebService.open({ ...options, extensions: await readExtensionConfiguration(config), syntheticStream: async (_model, context) => {
      const system = getCurrentSystemPrompt(context.messages);
      expect(system).toContain('<name>global-capabilities-fixture</name>');
      expect(system).toContain('GLOBAL_SKILL_METADATA_SENTINEL');
      expect(system).not.toContain('GLOBAL_SKILL_BODY_SENTINEL');
      if (system.includes('task-scoped worker')) {
        childCalls++;
        for (const name of ['pdf', 'doc', 'transcribe', 'agent-browser', 'mira-web-search']) expect(system).toContain(`<name>${name}</name>`);
        expect(system).not.toContain('MAIN_MEMORY_SENTINEL');
        expect(getCurrentTools(context.messages).some(tool => tool.name.startsWith('subagent_') || tool.name === 'send_attachment')).toBe(false);
        if (childCalls === 1) {
          expect(JSON.stringify(context.messages)).not.toContain('GLOBAL_SKILL_BODY_SENTINEL');
          return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
            { type: 'toolCall', id: 'child-skill-read', name: 'read', arguments: { path: path.join(sourceDirectory, 'skills/pdf/SKILL.md') } },
            { type: 'toolCall', id: 'child-global-skill-read', name: 'read', arguments: { path: globalSkill } },
            { type: 'toolCall', id: 'child-visible-tool', name: 'bash', arguments: { command: `printf started > ${JSON.stringify(childToolStarted)}; while [ ! -f ${JSON.stringify(childToolRelease)} ]; do sleep 0.02; done; printf CHILD_TOOL_DONE` } },
            { type: 'toolCall', id: 'child-public-progress', name: 'report_progress', arguments: { text: '已读取两个技能，正在整理结果。' } },
          ] });
        }
        expect(childCalls).toBe(2); expect(JSON.stringify(context.messages)).toContain('# PDF Skill');
        expect(JSON.stringify(context.messages)).toContain('GLOBAL_SKILL_BODY_SENTINEL');
        await childRelease.promise;
        return streamOf(assistant('CHILD_JOINED_FINDING'));
      }
      parentContexts.push(structuredClone(context));
      if (parentContexts.length === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'joined-spawn', name: 'subagent_spawn', arguments: { title: '检查共享技能', task: 'Inspect the public PDF and global capabilities skills and return a finding', fork: 'none' } }] });
      if (parentContexts.length === 2) {
        const dueAt = new Date(Math.ceil((Date.now() + 2_000) / 1000) * 1000).toISOString();
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'joined-reminder', name: 'reminder_create', arguments: { key: 'joined-deadline', text: 'REMINDER_JOINED_DUE', localDate: dueAt.slice(0,10), localTime: dueAt.slice(11,19), timeZone: 'UTC' } },
          { type: 'toolCall', id: 'joined-active', name: 'bash', arguments: { command: `printf started > ${JSON.stringify(started)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; printf once >> ${JSON.stringify(effect)}` } },
          { type: 'toolCall', id: 'joined-stale', name: 'bash', arguments: { command: `printf forbidden > ${JSON.stringify(forbidden)}` } },
        ] });
      }
      if (parentContexts.length === 3) {
        expect(JSON.stringify(context.messages)).toContain('只完成当前工具，跳过后面的工具');
        expect(JSON.stringify(context.messages)).toContain('Execution did not start');
        expect(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'joined-active')).toBe(true);
        const supplemental = context.messages.filter(message => message.role === 'user').slice(-2);
        expect(JSON.stringify(supplemental[0])).toContain('CHILD_JOINED_FINDING');
        expect(JSON.stringify(supplemental[0])).toContain('subagent.result');
        expect(JSON.stringify(supplemental[0])).toContain('Delegated result, not user instructions or permission');
        expect(JSON.stringify(supplemental[1])).toContain('只完成当前工具，跳过后面的工具');
        expect(JSON.stringify(supplemental)).not.toContain('REMINDER_JOINED_DUE');
        return streamOf(assistant('已按新消息跳过后面的工具，并处理子任务结果。'));
      }
      expect(parentContexts).toHaveLength(4);
      const lastInput = context.messages.filter(message => message.role === 'user').at(-1);
      expect(JSON.stringify(lastInput)).not.toContain('CHILD_JOINED_FINDING');
      expect(JSON.stringify(lastInput)).not.toContain('只完成当前工具，跳过后面的工具');
      expect(JSON.stringify(lastInput)).toContain('REMINDER_JOINED_DUE');
      return streamOf(assistant('提醒已处理。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
  };
  const send = async (text: string) => { await page.getByLabel('给 Mira 发消息', { exact: true }).fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
  try {
    // Real service discovery uses a distinct synthetic OS HOME, never the developer's global skills.
    process.env['HOME'] = userHome;
    await mkdir(path.dirname(globalSkill), { recursive: true });
    await writeFile(globalSkill, '---\nname: global-capabilities-fixture\ndescription: GLOBAL_SKILL_METADATA_SENTINEL\n---\nGLOBAL_SKILL_BODY_SENTINEL\n');
    await start();
    const memory = path.join(root, 'Memory', 'MEMORY.md');
    const initialMemory = (await readFile(memory, 'utf8')) + '\nMAIN_MEMORY_SENTINEL\n';
    await writeFile(memory, initialMemory);
    await page.goto(origin); await send('委派独立任务，安排测试提醒，然后执行测试工具。');
    await expect.poll(() => exists(started)).toBe(true);
    await expect.poll(() => exists(childToolStarted)).toBe(true);
    const parentRunId = (await service!.runs()).items[0]!.id;
    await expect(page.getByRole('status').filter({ hasText: 'Mira 正在处理' })).toBeVisible();
    await expectConversationOnly(page);
    await page.screenshot({ path: testInfo.outputPath('main-chat-no-child-cards-running-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('main-chat-no-child-cards-running-mobile.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });
    await openRunChildren(page, parentRunId);
    await expect(page.locator('.run-children .child-card')).toContainText('检查共享技能');
    await page.getByRole('button', { name: '查看子任务 检查共享技能', exact: true }).click();
    const childDialog = page.getByRole('dialog', { name: '检查共享技能', exact: true });
    await expect(childDialog).toBeVisible();
    await expect(childDialog.locator('.child-current')).toContainText('工具 bash · 已开始');
    await expect(childDialog).not.toContainText('MAIN_MEMORY_SENTINEL');
    await expect(childDialog).not.toContainText('printf started');
    await page.screenshot({ path: testInfo.outputPath('settings-child-running-desktop.png'), fullPage: true });
    await writeFile(childToolRelease, 'continue');
    await expect.poll(() => childCalls).toBe(2);
    await expect(childDialog.getByText('已读取两个技能，正在整理结果。', { exact: true })).toBeVisible();
    await expect(childDialog.locator('.child-current')).toContainText('生成回复 · 已开始');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('settings-child-progress-mobile.png'), fullPage: true });
    await childDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await closeSettings(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => (await db.admin.query("SELECT status FROM scheduled_deliveries WHERE schedule_key='joined-deadline'")).rows[0]?.status).toBe('enqueued');
    childRelease.resolve();
    await expect.poll(async () => (await db.admin.query("SELECT status FROM subagent_turns")).rows[0]?.status).toBe('completed');
    const liveInputs = async () => (await db.admin.query(`
      SELECT i.run_id,e.event->>'type' AS type,e.event->>'source' AS source,i.input_record_id
      FROM wake_live_inputs i JOIN wake_requests w ON w.mira_id=i.mira_id AND w.wake_id=i.wake_id
      JOIN life_events e ON e.mira_id=w.mira_id AND e.event_id=w.event_id
      WHERE i.mira_id=$1 ORDER BY w.receipt_order`, ['joined-parent'])).rows;
    // Terminal state and the sourced supplemental receipt must already commit
    // together while the main tool remains blocked; a count alone can race.
    const childReceipt = { run_id: parentRunId, type: 'subagent.result', source: 'system', input_record_id: null };
    await expect.poll(liveInputs).toEqual([childReceipt]);
    expect((await db.admin.query("SELECT outcome FROM tool_executions WHERE mira_id=$1 AND call_id='joined-active'", ['joined-parent'])).rows[0].outcome).toBeNull();
    expect(parentContexts).toHaveLength(2);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n).toBe(1);
    await send('只完成当前工具，跳过后面的工具');
    await expect.poll(liveInputs).toEqual([
      childReceipt,
      { run_id: parentRunId, type: 'web.message', source: 'user', input_record_id: null },
    ]);
    expect(parentContexts).toHaveLength(2); expect(await exists(effect)).toBe(false);
    await writeFile(release, 'finish');
    await expect(page.getByText('已按新消息跳过后面的工具，并处理子任务结果。', { exact: true })).toBeVisible();
    await expect(page.getByText('提醒已处理。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(await readFile(effect, 'utf8')).toBe('once'); expect(await exists(forbidden)).toBe(false);
    expect(await readFile(memory, 'utf8')).toBe(initialMemory);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM wake_runs WHERE completed")).rows[0].n).toBe(2);
    const membership = (await db.admin.query(`
      SELECT r.run_id,e.event->>'type' AS type FROM wake_run_requests r
      JOIN wake_requests w ON w.mira_id=r.mira_id AND w.wake_id=r.wake_id
      JOIN life_events e ON e.mira_id=w.mira_id AND e.event_id=w.event_id
      WHERE r.mira_id=$1 ORDER BY w.receipt_order`, ['joined-parent'])).rows;
    expect(membership.filter(row => row.run_id === parentRunId).map(row => row.type)).toEqual(['web.message', 'subagent.result', 'web.message']);
    const queued = membership.filter(row => row.run_id !== parentRunId);
    expect(queued).toHaveLength(1); expect(queued[0].type).toBe('reminder.due');
    expect((await liveInputs()).map(row => ({ ...row, input_record_id: row.input_record_id !== null }))).toEqual([
      { ...childReceipt, input_record_id: true },
      { run_id: parentRunId, type: 'web.message', source: 'user', input_record_id: true },
    ]);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='reminder.due'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM wake_memory_checkpoints WHERE mira_id LIKE 'subagent:%'")).rows[0].n).toBe(0);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE call_id='joined-stale'")).rows[0].n).toBe(0);
    await openRunChildren(page, parentRunId);
    await expect(page.locator('.run-children .child-card')).toContainText('检查共享技能');
    await page.getByRole('button', { name: '查看子任务 检查共享技能', exact: true }).click();
    await expect(childDialog.getByText('CHILD_JOINED_FINDING', { exact: true })).toBeVisible();
    await expect(childDialog.locator('.child-current')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('child-completed-desktop.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(childDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '查看子任务 检查共享技能', exact: true })).toBeFocused();
    await closeSettings(page);
    await page.screenshot({ path: testInfo.outputPath('joined-capabilities-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('joined-capabilities-mobile.png'), fullPage: true });
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload();
    await expect(page.getByText('已按新消息跳过后面的工具，并处理子任务结果。', { exact: true })).toBeVisible();
    await expect(page.getByText('提醒已处理。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(parentContexts).toHaveLength(4); expect(childCalls).toBe(2); expect(await readFile(effect, 'utf8')).toBe('once');
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='reminder.due'")).rows[0].n).toBe(1);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n).toBe(2);
    await openRunChildren(page, parentRunId);
    await expect(page.locator('.run-children .child-card')).toContainText('检查共享技能');
    await page.getByRole('button', { name: '查看子任务 检查共享技能', exact: true }).click();
    await expect(childDialog.getByText('CHILD_JOINED_FINDING', { exact: true })).toBeVisible();
    await expect(childDialog.locator('.child-current')).toHaveCount(0);
    await childDialog.getByRole('button', { name: '关闭', exact: true }).click();
  } finally {
    try { childRelease.resolve(); await writeFile(childToolRelease, 'cleanup'); await writeFile(release, 'cleanup'); await app?.close(); await service?.close(); await db.close(); }
    finally {
      if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('long child compacts through real tools and PostgreSQL, remains inspectable after service restart', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-child-compaction-browser-'));
  const evidence = path.join(root, 'evidence.txt'); await writeFile(evidence, 'read-only evidence line\n'.repeat(520));
  let app: ReturnType<typeof createLocalHttp> | undefined; let service: LocalWebService | undefined;
  let childCalls = 0, summaries = 0, parentCalls = 0;
  const summaryRelease = deferred();
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'compaction-browser-parent', sourceDirectory,
    workingDirectory: root, miraHome: root, memoryRoot: path.join(root, 'Memory'), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    synthetic: true, syntheticModel: { ...model, contextWindow: 100_000 }, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
  const start = async () => {
    service = await LocalWebService.open({ ...options, syntheticStream: async (_m, context) => {
      const system = getCurrentSystemPrompt(context.messages);
      if (system.includes('Summarize this task-scoped worker')) {
        summaries++;
        const data = JSON.parse(String(context.messages.find(message => message.role === 'user')?.content));
        expect(data.memory_snapshot).toBeNull(); expect(data.persona_context).not.toContain('MAIN_PRIVATE_MEMORY');
        expect(JSON.stringify(data.source_messages)).toContain('read-only evidence');
        await summaryRelease.promise;
        return streamOf(assistant('BROWSER_TASK_SUMMARY: inspected evidence, no publication or external effects.'));
      }
      if (system.includes('task-scoped worker')) {
        childCalls++; expect(childCalls).toBeLessThan(40);
        expect(system).not.toContain('MAIN_PRIVATE_MEMORY');
        if (JSON.stringify(context.messages).includes('BROWSER_TASK_SUMMARY')) return streamOf(assistant('CHILD_COMPACTED_FINDING'));
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: `evidence-read-${childCalls}`, name: 'read', arguments: { path: evidence } }] });
      }
      parentCalls++;
      if (parentCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'browser-compact-spawn', name: 'subagent_spawn', arguments: { title: '长任务压缩验证', task: 'Read the assigned evidence until enough context exists, then report', fork: 'none' } }] });
      return streamOf(assistant(parentCalls === 2 ? '子任务正在读取证据。' : '子任务压缩后已完成。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
  };
  try {
    await start(); await writeFile(path.join(root, 'Memory', 'MEMORY.md'), 'MAIN_PRIVATE_MEMORY');
    await page.goto(origin);
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('让子任务检查指定证据。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect.poll(() => summaries, { timeout: 60_000 }).toBe(1);
    const parentRunId = (await service!.runs()).items[0]!.id;
    await expectConversationOnly(page);
    await openRunChildren(page, parentRunId);
    await page.getByRole('button', { name: '查看子任务 长任务压缩验证', exact: true }).click();
    const activeDialog = page.getByRole('dialog', { name: '长任务压缩验证', exact: true });
    await expect(activeDialog.locator('.child-current')).toContainText('整理任务上下文 · 已开始');
    await page.screenshot({ path: testInfo.outputPath('child-compacting-desktop.png'), fullPage: true });
    await activeDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await closeSettings(page);
    summaryRelease.resolve();
    await expect(page.getByText('子任务压缩后已完成。', { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(summaries).toBe(1);
    const checkpoints = (await db.admin.query("SELECT mira_id FROM context_records WHERE envelope->>'kind'='checkpoint'")).rows;
    expect(checkpoints).toHaveLength(1); expect(checkpoints[0].mira_id).toMatch(/^subagent:/);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM wake_memory_checkpoints WHERE mira_id LIKE 'subagent:%'")).rows[0].n).toBe(0);
    await openRunChildren(page, parentRunId);
    await page.getByRole('button', { name: '查看子任务 长任务压缩验证', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '长任务压缩验证', exact: true });
    await expect(dialog.getByText('CHILD_COMPACTED_FINDING', { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('MAIN_PRIVATE_MEMORY');
    await page.screenshot({ path: testInfo.outputPath('child-compacted-desktop.png'), fullPage: true });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await closeSettings(page);
    const oldCalls = childCalls; await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload();
    await openRunChildren(page, parentRunId);
    await page.getByRole('button', { name: '查看子任务 长任务压缩验证', exact: true }).click();
    await expect(dialog.getByText('CHILD_COMPACTED_FINDING', { exact: true })).toBeVisible();
    expect(childCalls).toBe(oldCalls); expect(summaries).toBe(1);
  } finally { summaryRelease.resolve(); await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});


test('a child question, its answer and subagent_close stay out of the chat in a real browser over PostgreSQL', async ({ page }) => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-child-report-browser-'));
  let app: ReturnType<typeof createLocalHttp> | undefined; let service: LocalWebService | undefined; let childId = '';
  const resultOf = (context: TranscriptContext, id: string) => { const found = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === id); return found ? JSON.stringify(found.content) : null; };
  const tool = (id: string, name: string, args: JsonObject) => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }] });
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'report-browser-parent', sourceDirectory,
    workingDirectory: root, miraHome: root, memoryRoot: path.join(root, 'Memory'), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    synthetic: true, syntheticModel: { ...model, contextWindow: 100_000 }, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
  try {
    service = await LocalWebService.open({ ...options, syntheticStream: async (_m, context) => {
      const text = JSON.stringify(context.messages);
      if (getCurrentSystemPrompt(context.messages).includes('task-scoped worker')) {
        if (text.includes('ANSWER_BLUE')) return resultOf(context, 'r2') === null ? tool('r2', 'task_report', { summary: 'REPORT_DONE_BLUE wrote /tmp/x.txt' }) : streamOf(assistant('done'));
        return resultOf(context, 'r1') === null ? tool('r1', 'task_report', { summary: 'REPORT_SUMMARY_SECRET', question: 'QUESTION_WHICH_COLOR?' }) : streamOf(assistant('waiting'));
      }
      const spawned = resultOf(context, 'p-spawn');
      if (spawned === null) return tool('p-spawn', 'subagent_spawn', { title: '问颜色', task: 'Ask which colour to use', fork: 'none' });
      childId = /\\"id\\":\\"([0-9a-f-]{36})\\"/.exec(spawned)?.[1] ?? childId;
      if (text.includes('QUESTION_WHICH_COLOR?') && resultOf(context, 'p-send') === null) return tool('p-send', 'subagent_send', { id: childId, message: 'ANSWER_BLUE' });
      if (text.includes('REPORT_DONE_BLUE') && resultOf(context, 'p-close') === null) return tool('p-close', 'subagent_close', { id: childId });
      if (resultOf(context, 'p-close') !== null) return streamOf(assistant('颜色定好了，用蓝色。'));
      return streamOf(assistant('NO_REPLY'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
    await page.goto(origin);
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('帮我定个颜色。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText('颜色定好了，用蓝色。', { exact: true })).toBeVisible({ timeout: 60_000 });
    await expectConversationOnly(page);
    const chat = page.locator('.mira-app');
    for (const hidden of ['REPORT_SUMMARY_SECRET', 'QUESTION_WHICH_COLOR', 'REPORT_DONE_BLUE', 'ANSWER_BLUE', 'NO_REPLY', 'task_report', 'subagent']) await expect(chat).not.toContainText(hidden);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM subagent_closures')).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT result->'report'->>'question' AS q FROM subagent_turns ORDER BY sequence")).rows.map(row => row.q)).toEqual(['QUESTION_WHICH_COLOR?', null]);
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('reasoning saved in the real browser reaches credential-bound SDK payloads and survives restart', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-reasoning-browser-'));
  const originalFetch = globalThis.fetch; const levels: unknown[] = []; const probes: unknown[] = [];
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  const settingsFile = path.join(root, 'models.json');
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'reasoning-browser', sourceDirectory,
    workingDirectory: root, miraHome: root, settingsFile, spoolDirectory: path.join(root, 'spool'), dreaming: { enabled: false }, autoCompaction: { enabled: false } };
  const start = async () => {
    service = await LocalWebService.open(options);
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
  };
  const send = async (text: string) => { await page.getByLabel('给 Mira 发消息', { exact: true }).fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
  const saveLevel = async (level: string) => {
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await page.getByLabel('默认推理强度', { exact: true }).selectOption(level);
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await expect(page.getByText(/配置已保存/)).toBeVisible();
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
  };
  try {
    const store = new WebSettingsStore(settingsFile, sourceDirectory); const initial = await store.get();
    await store.save({ revision: initial.revision, selection: { kind: 'custom', connection: 'browser-wire', model: 'browser-reasoner' },
      configuration: { defaultThinkingLevel: 'medium', builtinCredentials: {}, customConnections: [{ id: 'browser-wire', api: 'openai-completions', baseUrl: 'https://reasoning-browser.invalid/v1', apiKey: 'sk-synthetic-browser-reasoning',
        models: [{ id: 'browser-reasoner', reasoning: true, input: ['text'], contextWindow: 100_000, maxTokens: 4096 }] }] } });
    globalThis.fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      if (url.origin !== 'https://reasoning-browser.invalid') return originalFetch(input, init);
      const payload = JSON.parse(String(init?.body));
      // Saving a reasoning Chat Completions model without an explicit format runs
      // the one-request settings probe (ADR 0041) before the first save only.
      if (JSON.stringify(payload.messages).includes('Reply with OK.')) probes.push(payload.reasoning_effort); else levels.push(payload.reasoning_effort);
      return new Response([
        { id: 'wire-response', choices: [{ index: 0, delta: { role: 'assistant', content: `WIRE_LEVEL_${payload.reasoning_effort}` }, finish_reason: null }] },
        { id: 'wire-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]',
      ].map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    };
    await start(); await page.goto(origin); await expect.poll(async () => (await service!.status()).state).toBe('idle');
    await saveLevel('high'); await send('验证保存的高推理档位。');
    await expect(page.getByText('WIRE_LEVEL_high', { exact: true })).toBeVisible(); expect(levels).toEqual(['high']); expect(probes).toEqual(['high']);
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    await app!.close(); app = undefined; await service!.close(); service = undefined; await start(); await page.reload();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    await page.getByRole('button', { name: '模型设置', exact: true }).click();
    await expect(page.getByLabel('默认推理强度', { exact: true })).toHaveValue('high');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('默认推理强度', { exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByLabel('默认推理强度', { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('reasoning-real-settings-mobile.png'), fullPage: true });
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await saveLevel('low'); await send('继续验证低推理档位。');
    await expect(page.getByText('WIRE_LEVEL_low', { exact: true })).toBeVisible(); expect(levels).toEqual(['high', 'low']); expect(probes).toEqual(['high']);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM context_records WHERE envelope::text LIKE '%sk-synthetic-browser-reasoning%'")).rows[0].n).toBe(0);
  } finally { await app?.close(); await service?.close(); globalThis.fetch = originalFetch; await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('oversized extension output remains bounded and readable through ordinary file tools across a real browser/service restart', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-output-browser-'));
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  const modulePath = path.join(root, 'large-extension.mjs'), counter = path.join(root, 'effects');
  const sdk = pathToFileURL(path.join(sourceDirectory, 'packages/extension-sdk/src/index.ts')).href;
  await writeFile(modulePath, `import { appendFile } from 'node:fs/promises';
import { defineExtension } from ${JSON.stringify(sdk)};
export default defineExtension({ name: 'large-output', apply(api) { api.registerTool({ name: 'large_output', description: 'Synthetic large output fixture', parameters: { type: 'object', properties: {} }, async execute() { await appendFile(${JSON.stringify(counter)}, ${JSON.stringify('once\n')}); return { text: ${JSON.stringify(largeToolText)}, details: { receipt: 'complete' } }; } }); } });`);
  let requests = 0, savedPath = '';
  const start = async () => {
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'browser-output-budget', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      extensions: { entries: [{ id: 'large-output', path: modulePath }] }, synthetic: true, syntheticModel: { ...model, contextWindow: 200_000 },
      dreaming: { enabled: false }, autoCompaction: { enabled: false }, syntheticStream: async (_model, context) => {
        requests++;
        if (requests === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'large-browser-call', name: 'large_output', arguments: {} }] });
        const output = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'large-browser-call');
        expect(output?.role).toBe('toolResult'); if (output?.role !== 'toolResult') throw Error('Missing known result');
        expect(output.content.reduce((bytes, block) => bytes + (block.type === 'text' ? Buffer.byteLength(block.text) : 0), 0)).toBeLessThanOrEqual(16_384);
        // Head+tail preview keeps the end of the output; the middle is marked as omitted.
        expect(JSON.stringify(output.content)).toContain('FULL_ORIGINAL_TAIL'); expect(JSON.stringify(output.content)).toContain('omitted from the middle');
        const full = await fullOutput(output); expect(full.content[0]?.type === 'text' && full.content[0].text).toBe(largeToolText);
        savedPath = outputPath(output);
        if (requests === 2) {
          const lines = (await readFile(savedPath, 'utf8')).trimEnd().split('\n').length;
          return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-large-tail', name: 'read', arguments: { path: savedPath, offset: lines - 1, limit: 2 } }] });
        }
        if (requests === 3) {
          const tail = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'read-large-tail');
          expect(JSON.stringify(tail)).toContain('FULL_ORIGINAL_TAIL');
          return streamOf(assistant('完整结果已保留，并读取了末尾证据。'));
        }
        expect(requests).toBe(4);
        return streamOf(assistant('已恢复相同原文，没有重执行工具。'));
      } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
  };
  const send = async (text: string) => { await page.getByLabel('给 Mira 发消息', { exact: true }).fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
  try {
    await start(); await page.goto(origin); await send('读取大工具结果的末尾。');
    await expect(page.getByText('完整结果已保留，并读取了末尾证据。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(await readFile(counter, 'utf8')).toBe('once\n');
    const saved = (await db.admin.query("SELECT outcome FROM tool_executions WHERE call_id='large-browser-call'")).rows[0].outcome;
    expect(saved.payload.content[0].text).toBe(largeToolText);
    await page.screenshot({ path: testInfo.outputPath('tool-output-complete-desktop.png'), fullPage: true });
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await rm(savedPath); await start(); await page.reload(); await send('核对刚才的原文仍可读取。');
    await expect(page.getByText('已恢复相同原文，没有重执行工具。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(await readFile(counter, 'utf8')).toBe('once\n');
    expect((await db.admin.query("SELECT outcome FROM tool_executions WHERE call_id='large-browser-call'")).rows[0].outcome).toEqual(saved);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('tool-output-recovered-mobile.png'), fullPage: true });
  } finally { if (app) await app.close(); if (service) await service.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real browser observes request retry through PG and the credential-bound SDK without duplicate effects', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-retry-browser-'));
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  let calls = 0; const effect = path.join(root, 'effect');
  const firstResponse = deferred(), finalResponse = deferred();
  const statusRequests: number[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/status') statusRequests.push(Date.now()); });
  const settingsFile = path.join(root, 'models.json');
  const store = new WebSettingsStore(settingsFile, sourceDirectory);
  const initial = await store.get();
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'retry-browser', sourceDirectory, workingDirectory: root, miraHome: root,
    settingsFile, spoolDirectory: path.join(root, 'spool'), autoCompaction: { enabled: false }, dreaming: { enabled: false },
    modelFetch: (async () => {
      calls++;
      if (calls === 1) {
        // Let the receipt refresh observe working before this real SDK request completes.
        await firstResponse.promise;
        return retryResponse('', 'browser-once-call', 'bash', { command: `printf once >> ${JSON.stringify(effect)}` });
      }
      if (calls === 2) { const response = retryFailure(429, 'PRIVATE_RETRY_FAILURE'); response.headers.set('retry-after', '3'); return response; }
      // Keep the actual requesting phase observable for stable narrow-screen capture.
      await finalResponse.promise;
      return retryResponse('模型请求已恢复，只执行了一次工具。');
    }) as typeof globalThis.fetch };
  const start = async () => {
    service = await LocalWebService.open(options);
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
  };
  try {
    await store.save({ revision: initial.revision, selection: retrySelection, configuration: { builtinCredentials: {},
      customConnections: retryConfiguration.customConnections.map(({ apiKeyEnv: _env, ...connection }) => ({ ...connection, apiKey: syntheticRetryKey })) } });
    await start();
    // Only the browser clock is controlled. HTTP, PostgreSQL, SDK and retry backoff
    // use their real paths/timers; status responses are never intercepted or mocked.
    await page.clock.install({ time: new Date('2026-10-14T12:00:00Z') });
    await page.clock.pauseAt(new Date('2026-10-14T12:00:01Z'));
    await page.goto(origin); await expect(page.locator('.identity-detail')).toContainText('在这里');
    const idleReads = statusRequests.length;
    const clockStart = await page.evaluate(() => Date.now());
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('执行一次合成工具，然后回复。');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.locator('.working-indicator')).toHaveText(/Mira 正在处理/);
    expect(statusRequests).toHaveLength(idleReads + 1);
    const workingReads = statusRequests.length;
    firstResponse.resolve();
    await expect.poll(async () => (await service!.status()).modelRetry?.phase).toBe('waiting');
    // The manual working refresh must rearm the 5s idle timer at 1.2s. No reload,
    // explicit refresh or maximum Retry-After can conceal a stale idle timer here.
    await page.clock.runFor(1199); expect(statusRequests).toHaveLength(workingReads);
    await page.clock.runFor(1);
    await expect(page.getByRole('status').filter({ hasText: '等待重试（第 2/5 次）' })).toBeVisible();
    expect(statusRequests).toHaveLength(workingReads + 1);
    expect(await page.evaluate(() => Date.now()) - clockStart).toBe(1200);
    expect((await service!.status()).state).toBe('working'); expect((await service!.status()).error).toBeNull();
    await page.screenshot({ path: testInfo.outputPath('model-retry-real-desktop.png'), fullPage: true, animations: 'disabled' });
    await expect.poll(() => calls).toBe(3);
    await page.clock.runFor(1200);
    await expect(page.getByRole('status').filter({ hasText: '正在重试模型请求（第 2/5 次）' })).toBeVisible();
    expect((await service!.status()).modelRetry?.phase).toBe('requesting');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('model-retry-real-narrow.png'), fullPage: true, animations: 'disabled' });
    await testInfo.attach('retry-status-poll-observations', { contentType: 'application/json', body: JSON.stringify({ statusRequests, firstActivePollMs: 1200, oldIdlePollMs: 5000 }) });
    finalResponse.resolve();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    await page.clock.runFor(1200);
    await expect(page.getByText('模型请求已恢复，只执行了一次工具。', { exact: true })).toBeVisible();
    await expect(page.locator('.working-indicator')).toHaveCount(0);
    await page.clock.resume();
    expect(calls).toBe(3); expect(await readFile(effect, 'utf8')).toBe('once');
    expect((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n).toBe(1);
    const records = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    expect(JSON.stringify(records)).not.toContain('PRIVATE_RETRY_FAILURE');
    expect(JSON.stringify(records)).not.toContain(syntheticRetryKey);
    await expect(page.getByText('PRIVATE_RETRY_FAILURE')).toHaveCount(0);
    await page.reload(); await expect(page.getByText('模型请求已恢复，只执行了一次工具。', { exact: true })).toBeVisible();
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload();
    await expect(page.getByText('模型请求已恢复，只执行了一次工具。', { exact: true })).toBeVisible();
    await expect(page.locator('.working-indicator')).toHaveCount(0);
    expect(calls).toBe(3); expect(await readFile(effect, 'utf8')).toBe('once');
    expect((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows).toEqual(records);
  } finally { firstResponse.resolve(); finalResponse.resolve(); await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('terminal process spans browser messages and restart invalidates its handle without replay or terminal UI', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-terminal-browser-'));
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  let calls = 0; let sessionId = ''; let offset = 0; const effect = path.join(root, 'effect');
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'terminal-browser', sourceDirectory,
    workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
  const start = async () => {
    service = await LocalWebService.open({ ...options, syntheticStream: async (_model, context) => {
      calls++;
      if (calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'browser-terminal-start', name: 'exec_command',
        arguments: { command: `printf once >> ${JSON.stringify(effect)}; printf READY; read line; printf "REPLY:%s" "$line"; read finish`, yield_ms: 1000 } }] });
      if (calls === 3 || calls === 5) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: `browser-terminal-${calls}`, name: 'write_stdin',
        arguments: { session_id: sessionId, offset, ...(calls === 3 ? { chars: 'hello\n' } : {}), yield_ms: 1000 } }] });
      const last = context.messages.findLast(message => message.role === 'toolResult'); expect(last?.role).toBe('toolResult');
      if (last?.role !== 'toolResult') throw Error('Missing terminal evidence');
      const result = JSON.parse(last.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
      sessionId = result.session_id; offset = result.next_offset;
      if (calls === 2) { expect(result.status).toBe('running'); expect(result.output).toBe('READY'); return streamOf(assistant('终端仍在运行，等待下一条输入。')); }
      if (calls === 4) { expect(result.output).toBe('REPLY:hello'); return streamOf(assistant('同一终端收到了 hello。')); }
      expect(calls).toBe(6); expect(result.status).toBe('unavailable'); return streamOf(assistant('服务重启后旧终端已不可用，没有重放命令。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
  };
  const send = async (text: string) => { await page.getByLabel('给 Mira 发消息', { exact: true }).fill(text); await page.getByRole('button', { name: '发送消息', exact: true }).click(); };
  try {
    await start(); await page.goto(origin); await send('启动等待输入的终端。');
    await expect(page.getByText('终端仍在运行，等待下一条输入。', { exact: true })).toBeVisible();
    await send('给刚才的终端发送 hello。'); await expect(page.getByText('同一终端收到了 hello。', { exact: true })).toBeVisible();
    expect(await readFile(effect, 'utf8')).toBe('once'); await expectConversationOnly(page);
    await expect(page.locator('.mira-app')).not.toContainText('session_id');
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload(); expect(calls).toBe(4);
    await send('检查旧终端，不要重新运行命令。');
    await expect(page.getByText('服务重启后旧终端已不可用，没有重放命令。', { exact: true })).toBeVisible();
    expect(await readFile(effect, 'utf8')).toBe('once');
    expect((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n).toBe(3);
    await expectConversationOnly(page);
    await page.screenshot({ path: testInfo.outputPath('terminal-conversation-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('terminal-conversation-mobile.png'), fullPage: true });
  } finally { await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
