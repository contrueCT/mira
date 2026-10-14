import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  const started = path.join(root, 'started'), release = path.join(root, 'release'), effect = path.join(root, 'effect'), forbidden = path.join(root, 'forbidden');
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
      if (system.includes('task-scoped worker')) {
        childCalls++;
        for (const name of ['pdf', 'doc', 'transcribe', 'agent-browser', 'mira-web-search']) expect(system).toContain(`<name>${name}</name>`);
        expect(system).not.toContain('MAIN_MEMORY_SENTINEL');
        expect(getCurrentTools(context.messages).some(tool => tool.name.startsWith('subagent_') || tool.name === 'send_attachment')).toBe(false);
        if (childCalls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'child-skill-read', name: 'read', arguments: { path: path.join(sourceDirectory, 'skills/pdf/SKILL.md') } }] });
        expect(childCalls).toBe(2); expect(JSON.stringify(context.messages)).toContain('# PDF Skill');
        await childRelease.promise;
        return streamOf(assistant('CHILD_JOINED_FINDING'));
      }
      parentContexts.push(structuredClone(context));
      if (parentContexts.length === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'joined-spawn', name: 'subagent_spawn', arguments: { task: 'Inspect the public PDF skill and return a finding', fork: 'none' } }] });
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
    await start();
    const memory = path.join(root, 'Memory', 'MEMORY.md');
    const initialMemory = (await readFile(memory, 'utf8')) + '\nMAIN_MEMORY_SENTINEL\n';
    await writeFile(memory, initialMemory);
    await page.goto(origin); await send('委派独立任务，安排测试提醒，然后执行测试工具。');
    await expect.poll(() => exists(started)).toBe(true); await expect.poll(() => childCalls).toBe(2);
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
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='reminder.due'")).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM wake_memory_checkpoints WHERE mira_id LIKE 'subagent:%'")).rows[0].n).toBe(0);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE call_id='joined-stale'")).rows[0].n).toBe(0);
    await page.screenshot({ path: testInfo.outputPath('joined-capabilities-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('joined-capabilities-mobile.png'), fullPage: true });
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload();
    await expect(page.getByText('提醒和子任务结果已一并处理。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(parentContexts).toHaveLength(4); expect(childCalls).toBe(2); expect(await readFile(effect, 'utf8')).toBe('once');
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n).toBe(2);
  } finally { childRelease.resolve(); await writeFile(release, 'cleanup'); await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
