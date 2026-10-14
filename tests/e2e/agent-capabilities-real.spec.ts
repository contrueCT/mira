import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { getCurrentSystemPrompt, getCurrentTools, type TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { readExtensionConfiguration } from '@mira/extension-host';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, model, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3216, origin = `http://127.0.0.1:${port}`;
const exists = (file: string) => access(file).then(() => true, () => false);

test('due reminder and child completion queue behind user steering at one real tool boundary and never repeat after restart', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-capabilities-browser-');
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
        expect(JSON.stringify(context.messages)).not.toContain('CHILD_JOINED_FINDING');
        return streamOf(assistant('已按新消息跳过后面的工具。'));
      }
      expect(parentContexts).toHaveLength(4);
      const lastInput = context.messages.filter(message => message.role === 'user').at(-1);
      expect(JSON.stringify(lastInput)).toContain('CHILD_JOINED_FINDING');
      expect(JSON.stringify(lastInput)).toContain('REMINDER_JOINED_DUE');
      return streamOf(assistant('提醒和子任务结果已一并处理。'));
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
    await page.getByRole('button', { name: '查看子任务 检查共享技能', exact: true }).click();
    const childDialog = page.getByRole('dialog', { name: '检查共享技能', exact: true });
    await expect(childDialog).toBeVisible();
    await expect(childDialog.locator('.child-current')).toContainText('工具 bash · 已开始');
    await expect(childDialog).not.toContainText('MAIN_MEMORY_SENTINEL');
    await expect(childDialog).not.toContainText('printf started');
    await page.screenshot({ path: testInfo.outputPath('child-running-desktop.png'), fullPage: true });
    await writeFile(childToolRelease, 'continue');
    await expect.poll(() => childCalls).toBe(2);
    await expect(childDialog.getByText('已读取两个技能，正在整理结果。', { exact: true })).toBeVisible();
    await expect(childDialog.locator('.child-current')).toContainText('生成回复 · 已开始');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('child-progress-mobile.png'), fullPage: true });
    await childDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect.poll(async () => (await db.admin.query("SELECT status FROM scheduled_deliveries WHERE schedule_key='joined-deadline'")).rows[0]?.status).toBe('enqueued');
    childRelease.resolve();
    await expect.poll(async () => (await db.admin.query("SELECT status FROM subagent_turns")).rows[0]?.status).toBe('completed');
    expect(parentContexts).toHaveLength(2);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n).toBe(1);
    await send('只完成当前工具，跳过后面的工具');
    await expect.poll(async () => (await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NULL')).rows[0].n).toBe(1);
    expect(parentContexts).toHaveLength(2); expect(await exists(effect)).toBe(false);
    await writeFile(release, 'finish');
    await expect(page.getByText('已按新消息跳过后面的工具。', { exact: true })).toBeVisible();
    await expect(page.getByText('提醒和子任务结果已一并处理。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(await readFile(effect, 'utf8')).toBe('once'); expect(await exists(forbidden)).toBe(false);
    expect(await readFile(memory, 'utf8')).toBe(initialMemory);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM wake_runs WHERE completed")).rows[0].n).toBe(2);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_run_requests GROUP BY run_id ORDER BY n')).rows.map(row => row.n)).toEqual([2, 2]);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NOT NULL')).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='reminder.due'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM wake_memory_checkpoints WHERE mira_id LIKE 'subagent:%'")).rows[0].n).toBe(0);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE call_id='joined-stale'")).rows[0].n).toBe(0);
    await page.getByRole('button', { name: '查看子任务 检查共享技能', exact: true }).click();
    await expect(childDialog.getByText('CHILD_JOINED_FINDING', { exact: true })).toBeVisible();
    await expect(childDialog.locator('.child-current')).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath('child-completed-desktop.png'), fullPage: true });
    await page.keyboard.press('Escape');
    await expect(childDialog).not.toBeVisible();
    await expect(page.getByRole('button', { name: '查看子任务 检查共享技能', exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('joined-capabilities-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('joined-capabilities-mobile.png'), fullPage: true });
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload();
    await expect(page.getByText('已按新消息跳过后面的工具。', { exact: true })).toBeVisible();
    await expect(page.getByText('提醒和子任务结果已一并处理。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(parentContexts).toHaveLength(4); expect(childCalls).toBe(2); expect(await readFile(effect, 'utf8')).toBe('once');
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='reminder.due'")).rows[0].n).toBe(1);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n).toBe(2);
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
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-child-compaction-browser-');
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
    await page.getByRole('button', { name: '查看子任务 长任务压缩验证', exact: true }).click();
    const activeDialog = page.getByRole('dialog', { name: '长任务压缩验证', exact: true });
    await expect(activeDialog.locator('.child-current')).toContainText('整理任务上下文 · 已开始');
    await page.screenshot({ path: testInfo.outputPath('child-compacting-desktop.png'), fullPage: true });
    await activeDialog.getByRole('button', { name: '关闭', exact: true }).click();
    summaryRelease.resolve();
    await expect(page.getByText('子任务压缩后已完成。', { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(summaries).toBe(1);
    const checkpoints = (await db.admin.query("SELECT mira_id FROM context_records WHERE envelope->>'kind'='checkpoint'")).rows;
    expect(checkpoints).toHaveLength(1); expect(checkpoints[0].mira_id).toMatch(/^subagent:/);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM wake_memory_checkpoints WHERE mira_id LIKE 'subagent:%'")).rows[0].n).toBe(0);
    await page.getByRole('button', { name: '查看子任务 长任务压缩验证', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '长任务压缩验证', exact: true });
    await expect(dialog.getByText('CHILD_COMPACTED_FINDING', { exact: true })).toBeVisible();
    await expect(dialog).not.toContainText('MAIN_PRIVATE_MEMORY');
    await page.screenshot({ path: testInfo.outputPath('child-compacted-desktop.png'), fullPage: true });
    const oldCalls = childCalls; await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload();
    await page.getByRole('button', { name: '查看子任务 长任务压缩验证', exact: true }).click();
    await expect(dialog.getByText('CHILD_COMPACTED_FINDING', { exact: true })).toBeVisible();
    expect(childCalls).toBe(oldCalls); expect(summaries).toBe(1);
  } finally { summaryRelease.resolve(); await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
