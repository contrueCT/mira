import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { createAssistantMessageEventStream, type TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, model, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3215; const origin = `http://127.0.0.1:${port}`;
const exists = (file: string) => access(file).then(() => true, () => false);

test('ordinary send interrupts model streaming and waits for just the active real tool, including restart and duplicate receipts', async ({ page }, testInfo) => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-live-browser-');
  const started = path.join(root, 'started'), release = path.join(root, 'release'), effect = path.join(root, 'effect'), forbidden = path.join(root, 'forbidden');
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  const streaming = deferred(); const contexts: TranscriptContext[] = []; const posts: Array<{ id: string; text: string; occurredAt: string }> = [];
  const errors: string[] = []; let requestAborted = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url() === `${origin}/api/messages`) posts.push(request.postDataJSON()); });
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'live-input-real', sourceDirectory,
    workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
    synthetic: true, syntheticModel: { ...model, contextWindow: 100_000 }, dreaming: { enabled: false }, autoCompaction: { enabled: false } };
  const start = async () => {
    service = await LocalWebService.open({ ...options, syntheticStream: (_model, context, streamOptions) => {
      contexts.push(structuredClone(context));
      if (contexts.length === 1) {
        const stream = createAssistantMessageEventStream(); streaming.resolve();
        streamOptions!.signal!.addEventListener('abort', () => {
          requestAborted = true; stream.push({ type: 'error', reason: 'aborted', error: { ...assistant('旧请求不应显示'), stopReason: 'aborted' } });
        }, { once: true });
        return stream;
      }
      if (contexts.length === 2) {
        expect(JSON.stringify(context.messages)).toContain('先执行第一个测试工具');
        return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
          { type: 'toolCall', id: 'active-command', name: 'bash', arguments: { command: `printf started > ${JSON.stringify(started)}; while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done; printf one-effect >> ${JSON.stringify(effect)}` } },
          { type: 'toolCall', id: 'old-sibling-command', name: 'bash', arguments: { command: `printf forbidden > ${JSON.stringify(forbidden)}` } },
        ] });
      }
      expect(contexts).toHaveLength(3);
      expect(JSON.stringify(context.messages)).toContain('不要执行第二个工具');
      expect(JSON.stringify(context.messages)).toContain('Execution did not start');
      expect(context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'active-command')).toBe(true);
      return streamOf(assistant('第一个工具已完成，第二个没有执行。'));
    } });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' });
  };
  const send = async (text: string) => {
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill(text);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
  };
  try {
    await start(); await page.goto(origin); await send('开始测试'); await streaming.promise;
    await expect(page.getByRole('button', { name: /停止|暂停/ })).toHaveCount(0);
    await send('先执行第一个测试工具');
    await expect.poll(() => requestAborted).toBe(true);
    await expect.poll(() => exists(started)).toBe(true);
    await send('不要执行第二个工具');
    await expect.poll(async () => (await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NULL')).rows[0].n).toBe(1);
    expect(contexts).toHaveLength(2); expect(await exists(effect)).toBe(false); expect(await exists(forbidden)).toBe(false);
    await writeFile(release, 'finish current tool');
    await expect(page.getByText('第一个工具已完成，第二个没有执行。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(await readFile(effect, 'utf8')).toBe('one-effect'); expect(await exists(forbidden)).toBe(false);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n).toBe(1);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n).toBe(1);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM wake_live_inputs WHERE input_record_id IS NOT NULL')).rows[0].n).toBe(2);
    const receipt = await page.evaluate(async body => {
      const response = await fetch('/api/messages', { method: 'POST', headers: { 'x-mira-client': 'web', 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return response.json();
    }, posts[2]!);
    expect(receipt.receipt).toBe('duplicate'); expect(contexts).toHaveLength(3);
    await page.screenshot({ path: testInfo.outputPath('live-input-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: testInfo.outputPath('live-input-mobile.png'), fullPage: true });
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); await page.reload();
    await expect(page.getByText('第一个工具已完成，第二个没有执行。', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(contexts).toHaveLength(3); expect(await readFile(effect, 'utf8')).toBe('one-effect'); expect(errors).toEqual([]);
    await expect(page.getByText('旧请求不应显示', { exact: true })).toHaveCount(0);
  } finally { await writeFile(release, 'cleanup'); await app?.close(); await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
