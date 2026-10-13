import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { Api, Model, TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, streamOf } from '../recovery/fixtures.mts';
import { firstImage, secondImage, shortVideo, pdfDocument, wordDocument } from './attachment-fixtures/media.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3214;
const origin = `http://127.0.0.1:${port}`;
const vision: Model<Api> = { id: 'gemini-synthetic-attachments', name: 'Synthetic attachments', api: 'google-generative-ai', provider: 'google',
  baseUrl: 'http://127.0.0.1:1/never', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 512 };
type Submitted = { id: string; text: string; occurredAt: string; attachmentIds: string[] };
const media = [
  { name: 'blue.png', mimeType: 'image/png', buffer: firstImage },
  { name: 'gold.png', mimeType: 'image/png', buffer: secondImage },
  { name: 'clip.mp4', mimeType: 'video/mp4', buffer: shortVideo },
  { name: 'notes.pdf', mimeType: 'application/pdf', buffer: pdfDocument },
  { name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: wordDocument },
];
async function transfer(page: Page, kind: 'drop' | 'paste', files: typeof media) {
  await page.locator('form.composer').evaluate((element, input) => {
    const transfer = new DataTransfer();
    for (const file of input.files) transfer.items.add(new File([Uint8Array.from(atob(file.data), ch => ch.charCodeAt(0))], file.name, { type: file.mimeType }));
    element.dispatchEvent(input.kind === 'drop' ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer })
      : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, { kind, files: files.map(file => ({ name: file.name, mimeType: file.mimeType, data: file.buffer.toString('base64') })) });
}
async function send(page: Page) { await page.getByRole('button', { name: '发送消息', exact: true }).click(); }
async function request(page: Page, input: Submitted) {
  return page.evaluate(async body => {
    const response = await fetch('/api/messages', { method: 'POST', headers: { 'x-mira-client': 'web', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, input);
}

// Only provider output is scripted. Upload, receipt, event, Wake, runtime input,
// tool execution, publication, files, PG and every rendered card are production.
test('real bidirectional attachments preserve ordered model input, immutable publications and restart recovery', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-attachments-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined;
  let app: ReturnType<typeof createLocalHttp> | undefined;
  const contexts: TranscriptContext[] = [];
  const posts: Submitted[] = [];
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && req.url() === `${origin}/api/messages`) posts.push(req.postDataJSON()); });
  const paths = media.map(file => path.join(root, `generated-${file.name}`));
  try {
    db = await createTestDatabase();
    for (let i = 0; i < media.length; i++) await writeFile(paths[i]!, media[i]!.buffer);
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'attachments-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      synthetic: true, syntheticModel: vision, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: async (_model: unknown, context: TranscriptContext) => {
        contexts.push(structuredClone(context));
        if (contexts.length === 1) return streamOf({ ...assistant(), stopReason: 'toolUse' as const, content: [
          { type: 'toolCall' as const, id: 'publish-generated-files', name: 'send_attachment', arguments: { paths, text: '为你生成的附件' } },
        ] });
        // This occurs only after the actual send_attachment tool and durable outcome.
        if (contexts.length === 2) { await writeFile(paths[0]!, 'OVERWRITTEN ORIGINAL'); for (const file of paths.slice(1)) await rm(file); }
        if (contexts.length === 6) {
          // The model explicitly selects a path advertised in a prior real user
          // payload. The test never injects an attachment-read outcome.
          const payloads = context.messages.filter(message => message.role === 'user').flatMap(message => {
            const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
            return blocks.flatMap(block => {
              if (block.type !== 'text') return [];
              const payload = block.text.split('Payload (JSON):\n')[1];
              if (!payload) return [];
              return [JSON.parse(payload) as { attachments?: Array<{ name: string; path: string }> }];
            });
          });
          const video = payloads.flatMap(payload => payload.attachments ?? []).find(file => file.name === 'clip.mp4');
          if (!video) throw Error('No video reference was exposed in the actual provider input');
          return streamOf({ ...assistant(), stopReason: 'toolUse' as const, content: [
            { type: 'toolCall' as const, id: 'explicit-video-read', name: 'read', arguments: { path: video.path } },
          ] });
        }
        return streamOf(assistant(`附件验证回复 ${contexts.length}`));
      } };
    const start = async () => {
      service = await LocalWebService.open(options);
      app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
      await app.listen({ port, host: '127.0.0.1' });
    };
    await start(); await page.goto(origin);
    // Keyboard-accessible + opens the actual native picker; attachment-only send.
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: '添加附件', exact: true }).click();
    await (await picker).setFiles(media.slice(0, 2));
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await expect(page.getByLabel('待发送附件', { exact: true })).toContainText('gold.png');
    await send(page);
    await expect(page.getByText('附件验证回复 2', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(posts[0]!.text).toBe(''); expect(posts[0]!.attachmentIds).toHaveLength(2);
    const firstUsers = contexts[0]!.messages.filter(message => message.role === 'user');
    const firstContent = firstUsers.at(-1)!.content;
    expect(Array.isArray(firstContent)).toBe(true);
    if (!Array.isArray(firstContent)) throw Error('Image input was not hydrated');
    expect(firstContent.filter(block => block.type === 'image').map(block => block.data)).toEqual([firstImage.toString('base64'), secondImage.toString('base64')]);
    expect(contexts[1]!.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'publish-generated-files' && !message.isError)).toBe(true);
    const timeline = await service!.timeline();
    expect(JSON.stringify(timeline)).not.toContain(root);
    const publication = timeline.items.find(item => item.text === '为你生成的附件');
    expect(publication?.attachments?.map(file => file.name)).toEqual(media.map(file => `generated-${file.name}`));
    for (let i = 0; i < media.length; i++) {
      expect((await service!.readAttachment(publication!.attachments![i]!.id)).bytes).toEqual(media[i]!.buffer);
    }
    expect(await readFile(paths[0]!, 'utf8')).toBe('OVERWRITTEN ORIGINAL');
    const duplicate = await request(page, posts[0]!);
    expect(duplicate).toEqual({ status: 200, body: { id: posts[0]!.id, receipt: 'duplicate' } });
    const changed = await request(page, { ...posts[0]!, attachmentIds: [...posts[0]!.attachmentIds].reverse() });
    expect(changed.status).toBe(409);
    expect(contexts).toHaveLength(2);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n).toBe(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE intent->>'toolName'='send_attachment'")).rows[0].n).toBe(1);
    const records = JSON.stringify((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows);
    expect(records).not.toContain(firstImage.toString('base64'));
    expect(records).toContain(posts[0]!.attachmentIds[0]);

    // Real protected Blob preview/download. Both dismissal paths preserve timeline.
    await page.getByRole('button', { name: '预览图片 generated-blue.png', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect.poll(() => page.getByRole('dialog').locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(320);
    await page.screenshot({ path: testInfo.outputPath('attachments-real-preview-desktop.png'), fullPage: true });
    const downloaded = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载文件', exact: true }).click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('generated-blue.png');
    expect(await readFile((await download.path())!)).toEqual(firstImage);
    await page.getByRole('button', { name: '关闭附件预览', exact: true }).click();
    await page.getByRole('button', { name: '预览图片 generated-gold.png', exact: true }).click();
    await page.goBack(); await expect(page.getByRole('dialog')).not.toBeVisible();
    await page.getByRole('button', { name: '预览视频 generated-clip.mp4', exact: true }).click();
    const videoPreview = page.getByRole('dialog').locator('video');
    await expect(videoPreview).toHaveAttribute('controls', '');
    // Exercise the actual decoder and playback clock, not merely a rendered
    // control or a fabricated loadedmetadata/play event.
    await expect.poll(() => videoPreview.evaluate((video: HTMLVideoElement) => ({
      metadataReady: video.readyState >= HTMLMediaElement.HAVE_METADATA,
      width: video.videoWidth, height: video.videoHeight,
      finiteDuration: Number.isFinite(video.duration) && video.duration > 0,
      error: video.error?.code ?? null,
    }))).toEqual({ metadataReady: true, width: 160, height: 90, finiteDuration: true, error: null });
    await videoPreview.evaluate(async (video: HTMLVideoElement) => { video.muted = true; await video.play(); });
    await expect.poll(() => videoPreview.evaluate((video: HTMLVideoElement) => video.currentTime)).toBeGreaterThan(0);
    await videoPreview.evaluate((video: HTMLVideoElement) => video.pause());
    expect(await videoPreview.evaluate((video: HTMLVideoElement) => video.error?.code ?? null)).toBeNull();
    await page.screenshot({ path: testInfo.outputPath('attachments-real-video-preview-desktop.png'), fullPage: true });
    await expect(page.getByRole('link', { name: '下载文件', exact: true })).toBeVisible();
    const videoDownloadEvent = page.waitForEvent('download');
    await page.getByRole('link', { name: '下载文件', exact: true }).click();
    const videoDownload = await videoDownloadEvent;
    expect(videoDownload.suggestedFilename()).toBe('generated-clip.mp4');
    expect(await readFile((await videoDownload.path())!)).toEqual(shortVideo);
    await page.getByRole('button', { name: '关闭附件预览', exact: true }).click();
    await page.getByRole('button', { name: '查看附件 generated-notes.pdf', exact: true }).click();
    await expect(page.getByRole('dialog')).toContainText('不会在这里解析或预览内容');
    await page.getByRole('button', { name: '关闭附件预览', exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath('attachments-real-timeline-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('attachments-real-timeline-narrow.png'), fullPage: true });
    await page.getByRole('button', { name: '预览图片 generated-blue.png', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('attachments-real-preview-narrow.png'), fullPage: true });
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).not.toBeVisible();

    await transfer(page, 'drop', media.slice(2));
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await send(page); await expect(page.getByText('附件验证回复 3', { exact: true })).toBeVisible();
    const videoRequest = JSON.stringify(contexts[2]);
    expect(videoRequest).not.toContain(shortVideo.toString('base64'));
    expect(videoRequest).not.toContain('miraNativeVideos');
    expect(videoRequest).toContain('notes.pdf'); expect(videoRequest).toContain('notes.docx');
    expect(videoRequest).not.toContain('SYNTHETIC_DOCUMENT_BODY_NOT_MODEL_TEXT');
    expect(videoRequest).not.toContain('SYNTHETIC_WORD_BODY_NOT_MODEL_TEXT');
    await transfer(page, 'paste', [media[1]!]);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await send(page); await expect(page.getByText('附件验证回复 4', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    const persisted = (await service!.timeline()).items;
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); expect(contexts).toHaveLength(4);
    expect((await service!.timeline()).items).toEqual(persisted);
    await page.reload();
    await expect(page.getByRole('button', { name: '预览图片 generated-blue.png', exact: true })).toBeVisible();
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('继续核对附件'); await send(page);
    await expect(page.getByText('附件验证回复 5', { exact: true })).toBeVisible();
    expect(JSON.stringify(contexts[4])).toContain(firstImage.toString('base64'));
    expect(JSON.stringify(contexts[4])).not.toContain(shortVideo.toString('base64'));
    expect(JSON.stringify(contexts[4])).not.toContain('miraNativeVideos');
    expect((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE intent->>'toolName'='read'")).rows[0].n).toBe(0);
    await page.getByLabel('给 Mira 发消息', { exact: true }).fill('现在请读取 clip.mp4 视频'); await send(page);
    await expect(page.getByText('附件验证回复 7', { exact: true })).toBeVisible();
    expect(JSON.stringify(contexts[5])).not.toContain(shortVideo.toString('base64'));
    const videoResult = contexts[6]!.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'explicit-video-read');
    expect(videoResult?.role === 'toolResult' && !videoResult.isError).toBe(true);
    expect(JSON.stringify(videoResult)).toContain('attachment-read');
    expect(JSON.stringify(videoResult)).toContain('miraNativeVideos');
    expect(JSON.stringify(videoResult)).toContain(shortVideo.toString('base64'));
    expect(JSON.stringify(contexts[6]!.messages.filter(message => message.role === 'user'))).not.toContain(shortVideo.toString('base64'));
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    const videoRecords = JSON.stringify((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows);
    expect(videoRecords).toContain('attachment-read');
    expect(videoRecords).not.toContain(shortVideo.toString('base64'));
    const afterRead = (await service!.timeline()).items;
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); expect(contexts).toHaveLength(7);
    expect((await service!.timeline()).items).toEqual(afterRead);
    await page.reload(); await page.getByLabel('给 Mira 发消息', { exact: true }).fill('继续刚才的视频分析'); await send(page);
    await expect(page.getByText('附件验证回复 8', { exact: true })).toBeVisible();
    const restoredVideo = contexts[7]!.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'explicit-video-read');
    expect(JSON.stringify(restoredVideo)).toContain(shortVideo.toString('base64'));
    expect((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE intent->>'toolName'='read'")).rows[0].n).toBe(1);
    expect((await service!.readAttachment(publication!.attachments![0]!.id)).bytes).toEqual(firstImage);
    expect(errors).toEqual([]);
  } finally { await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});

// Failures below interrupt actual network requests; no fake successful API or
// timeline is supplied. A staged upload does not count as a durable message.
test('pending upload removal and failed upload retry never silently send an incomplete message', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-attachments-pending-'));
  const hold = deferred(); let held = false; let block = true;
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  try {
    db = await createTestDatabase();
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'attachments-pending', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, syntheticModel: vision,
      dreaming: { enabled: false }, autoCompaction: { enabled: false }, syntheticStream: () => streamOf(assistant('重试附件已收到')) });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' }); await page.goto(origin);
    await page.route(`${origin}/api/attachments?*`, async route => { if (block) { held = true; await hold.promise; } await route.continue().catch(() => {}); });
    await page.getByLabel('选择附件', { exact: true }).setInputFiles([media[0]!]);
    await expect.poll(() => held).toBe(true);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: '移除附件 blue.png', exact: true }).click();
    block = false; hold.resolve(); await page.unroute(`${origin}/api/attachments?*`);
    expect((await db.admin.query('SELECT count(*)::int AS n FROM life_events')).rows[0].n).toBe(0);
    await page.route(`${origin}/api/attachments?*`, route => route.abort('connectionreset'), { times: 1 });
    await transfer(page, 'paste', [media[1]!]);
    await expect(page.getByRole('button', { name: '重新上传', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('attachments-real-upload-failed.png'), fullPage: true });
    await page.getByRole('button', { name: '重新上传', exact: true }).click();
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await send(page); await expect(page.getByText('重试附件已收到', { exact: true })).toBeVisible();
    const events = (await db.admin.query("SELECT event->'payload' AS payload FROM life_events")).rows;
    expect(events).toHaveLength(1); expect(events[0].payload.attachments.map((file: { name: string }) => file.name)).toEqual(['gold.png']);
  } finally { hold.resolve(); await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});

test('unsupported model receives a video only as an ordinary reference before and after restart', async ({ page }) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-video-reference-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined; let app: ReturnType<typeof createLocalHttp> | undefined;
  const contexts: TranscriptContext[] = [];
  try {
    db = await createTestDatabase();
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'video-reference-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticModel: { ...vision, id: 'text-only', api: 'openai-responses', provider: 'offline', input: ['text'] } as Model<Api>,
      dreaming: { enabled: false }, autoCompaction: { enabled: false }, syntheticStream: (_model: unknown, context: TranscriptContext) => {
        contexts.push(structuredClone(context)); return streamOf(assistant(`普通视频引用 ${contexts.length}`));
      } };
    const start = async () => {
      service = await LocalWebService.open(options);
      app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
      await app.listen({ port, host: '127.0.0.1' });
    };
    await start(); await page.goto(origin);
    await page.getByLabel('选择附件', { exact: true }).setInputFiles([media[2]!]);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await send(page); await expect(page.getByText('普通视频引用 1', { exact: true })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    const before = (await service!.timeline()).items;
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); expect(contexts).toHaveLength(1);
    expect((await service!.timeline()).items).toEqual(before);
    await page.reload(); await page.getByLabel('给 Mira 发消息', { exact: true }).fill('继续'); await send(page);
    await expect(page.getByText('普通视频引用 2', { exact: true })).toBeVisible();
    for (const context of contexts) {
      const request = JSON.stringify(context);
      expect(request).toContain('clip.mp4'); expect(request).toContain('video/mp4');
      expect(request).not.toContain(shortVideo.toString('base64')); expect(request).not.toContain('miraNativeVideos');
    }
    expect((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n).toBe(0);
  } finally { await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});
