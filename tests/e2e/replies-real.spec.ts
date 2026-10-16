import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { TranscriptContext } from '@earendil-works/pi-ai';
import { createLocalHttp, LocalWebService } from '@mira/server';
import { readExtensionConfiguration } from '@mira/extension-host';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, model, streamOf } from '../recovery/fixtures.mts';
import { firstImage } from './attachment-fixtures/media.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const port = 3220, origin = `http://127.0.0.1:${port}`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
type Submitted = { id: string; text: string; occurredAt: string; attachmentIds?: string[]; replyToMessageId?: string };
const row = (page: Page, id: string) => page.locator(`article[data-message-id="${id}"]`);
const composer = (page: Page) => page.getByLabel('给 Mira 发消息', { exact: true });
const send = (page: Page) => page.getByRole('button', { name: '发送消息', exact: true }).click();
async function say(page: Page, text: string) { await composer(page).fill(text); await send(page); }
async function quote(page: Page, id: string) {
  await row(page, id).hover();
  await row(page, id).getByRole('button', { name: '回复这条消息', exact: true }).click();
}
async function post(page: Page, input: Submitted) {
  return page.evaluate(async body => {
    const response = await fetch('/api/messages', { method: 'POST', headers: { 'x-mira-client': 'web', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }, input);
}
function latestUserText(context: TranscriptContext): string {
  const message = context.messages.filter(item => item.role === 'user').at(-1);
  if (!message) throw Error('No user input reached the real runtime');
  return typeof message.content === 'string' ? message.content : message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
}
function eventHistoryId(context: TranscriptContext): string {
  // Select the actual originating event advertised to the model. Never hand
  // the synthetic provider an ID obtained from SQL, the submit body or the UI.
  const id = [...latestUserText(context).matchAll(/\[user \|[^\n]*History ID "([0-9a-f-]{36})"/gu)].at(-1)?.[1];
  if (!id || !uuid.test(id)) throw Error('Original user event History UUID is missing from real model context');
  return id;
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const element of await page.locator('.message-bubble, .reply-quote, .composer-reply').all()) {
    const box = await element.boundingBox();
    if (box) { expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1); }
  }
}


async function conversationGeometry(page: Page) {
  // Read all coordinates in one browser frame so a scroll/attachment load cannot
  // mix measurements. Overflow checks alone would miss a left-aligned user row
  // or a quote rendered beside its bubble after a CSS regression.
  const measurements = await page.locator('.message-row.assistant, .message-row.user').evaluateAll(elements => elements.map(element => {
    const timeline = element.closest('.timeline-content')!.getBoundingClientRect();
    const bubble = element.querySelector('.message-bubble')!.getBoundingClientRect();
    const quote = element.querySelector('.reply-quote')?.getBoundingClientRect();
    return { user: element.classList.contains('user'), pending: element.classList.contains('pending-message'),
      timeline: { left: timeline.left, right: timeline.right },
      bubble: { left: bubble.left, right: bubble.right, top: bubble.top },
      quote: quote ? { left: quote.left, right: quote.right, bottom: quote.bottom } : null };
  }));
  expect(measurements.length).toBeGreaterThan(0);
  for (const item of measurements) {
    const edge = item.user ? 'right' : 'left';
    const label = `${item.pending ? 'pending ' : ''}${item.user ? 'user' : 'assistant'}`;
    expect(Math.abs(item.bubble[edge] - item.timeline[edge]), `${label} bubble must align to the ${edge} timeline edge`).toBeLessThanOrEqual(2);
    if (item.quote) {
      expect(Math.abs(item.quote[edge] - item.bubble[edge]), `${label} quote must share the bubble's ${edge} edge`).toBeLessThanOrEqual(2);
      expect(item.quote.bottom, `${label} quote must be above, not beside, its bubble`).toBeLessThanOrEqual(item.bubble.top + 1);
    }
  }
  const dividers = page.locator('.date-divider');
  expect(await dividers.count()).toBeGreaterThan(0);
  for (const divider of await dividers.all()) await expect(divider).toHaveCSS('text-align', 'center');
}

// Real service composition, browser submissions, immutable files, PG records,
// Wake input and send_reply tool execution. No fake successful HTTP responses.
test('user quotes an assistant with an attachment and Mira explicitly quotes the canonical user event across restart', async ({ page, browser }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-replies-real-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  const contexts: TranscriptContext[] = [], posts: Submitted[] = [], errors: string[] = [];
  let chosenUserId: string | undefined;
  const firstQuestion = '周六想去湖边走走，帮我想个轻松的安排吧。';
  const firstAnswer = '可以上午沿湖散步，中午找家小店吃饭，下午留给你自由安排。';
  const secondQuestion = '我想慢一点，十点出门就好。';
  const secondAnswer = '那就十点出门，先走东岸步道。路程不长，也有地方坐下来休息。';
  const replyText = '就按这个节奏。附上我画的路线，午饭想在湖边吃。';
  const replyAnswer = '好，午饭安排在湖边。你画的路线可以顺着走，累了就在中途休息。';
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', req => { if (req.method() === 'POST' && req.url() === `${origin}/api/messages`) posts.push(req.postDataJSON()); });
  try {
    db = await createTestDatabase();
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'replies-real', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      synthetic: true, syntheticModel: { ...model, contextWindow: 100_000 }, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: (_model: unknown, context: TranscriptContext) => {
        contexts.push(structuredClone(context));
        if (contexts.length === 1) return streamOf({ ...assistant(firstAnswer), timestamp: Date.now() });
        if (contexts.length === 2) return streamOf({ ...assistant(secondAnswer), timestamp: Date.now() });
        if (contexts.length === 3) {
          chosenUserId = eventHistoryId(context);
          return streamOf({ ...assistant(), timestamp: Date.now(), stopReason: 'toolUse' as const, content: [
            { type: 'toolCall' as const, id: 'explicit-quoted-answer', name: 'send_reply', arguments: { replyToMessageId: chosenUserId, text: replyAnswer } },
          ] });
        }
        if (contexts.length === 4) return streamOf({ ...assistant(''), timestamp: Date.now() });
        return streamOf({ ...assistant('路线和刚才的约定都还在，我们继续。'), timestamp: Date.now() });
      } };
    const start = async () => {
      service = await LocalWebService.open(options);
      app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
      await app.listen({ port, host: '127.0.0.1' });
    };
    await start();
    await page.goto(origin);
    await say(page, firstQuestion); await expect(page.locator('.message-bubble').filter({ hasText: firstAnswer })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    await say(page, secondQuestion); await expect(page.locator('.message-bubble').filter({ hasText: secondAnswer })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    const initial = (await service!.timeline()).items;
    const first = initial.find(item => item.text === firstAnswer)!;
    const second = initial.find(item => item.text === secondAnswer)!;
    expect(first.id).toMatch(uuid); expect(second.id).toMatch(uuid);
    expect(initial).toHaveLength(4);
    await expect(page.locator('.date-divider')).toHaveCount(1);
    await expect(page.locator('.message-group.compact')).toHaveCount(0);

    await quote(page, first.id);
    const preview = page.getByLabel('回复预览', { exact: true });
    await expect(preview).toContainText(firstAnswer);
    await composer(page).fill(replyText);
    await page.getByLabel('选择附件', { exact: true }).setInputFiles([{ name: '湖边路线.png', mimeType: 'image/png', buffer: firstImage }]);
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled();
    await quote(page, second.id); await expect(preview).toContainText(secondAnswer); await expect(preview).not.toContainText(firstAnswer);
    await expect(composer(page)).toHaveValue(replyText);
    await page.getByRole('button', { name: '取消回复', exact: true }).click();
    await expect(preview).toHaveCount(0); await expect(composer(page)).toHaveValue(replyText);
    await expect(page.getByLabel('待发送附件', { exact: true })).toContainText('湖边路线.png');
    await quote(page, first.id);
    await page.screenshot({ path: testInfo.outputPath('replies-composer-desktop.png'), fullPage: true });
    await send(page);
    await expect(page.locator('.message-bubble').filter({ hasText: replyAnswer })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(contexts).toHaveLength(4); expect(posts).toHaveLength(3);
    expect(posts[2]!.replyToMessageId).toBe(first.id); expect(posts[2]!.attachmentIds).toHaveLength(1);
    const quotedInput = latestUserText(contexts[2]!);
    expect(quotedInput).toContain(firstAnswer); expect(quotedInput).toContain('Reply target: role=assistant');
    expect(quotedInput).toContain(first.id); expect(quotedInput).toContain('湖边路线.png');
    const timeline = (await service!.timeline()).items;
    const user = timeline.find(item => item.text === replyText)!;
    const publication = timeline.find(item => item.text === replyAnswer)!;
    expect(timeline).toHaveLength(6);
    expect(user.id).toBe(chosenUserId); expect(user.id).not.toBe(posts[2]!.id);
    expect(user.reply).toEqual({ messageId: first.id, role: 'assistant', text: firstAnswer });
    const persistedUser = await db.admin.query("SELECT event->'payload' AS payload FROM life_events WHERE event->>'id' = $1", [posts[2]!.id]);
    expect(persistedUser.rows).toHaveLength(1);
    expect(persistedUser.rows[0].payload.reply).toEqual(user.reply);
    expect((await service!.readAttachment(user.attachments![0]!.id)).bytes).toEqual(firstImage);
    expect(publication.reply).toEqual({ messageId: user.id, role: 'user', text: replyText, attachmentNames: ['湖边路线.png'] });
    expect(publication.id).toMatch(uuid);
    const executions = await db.admin.query("SELECT history_id, intent, outcome FROM tool_executions WHERE intent->>'toolName'='send_reply'");
    expect(executions.rows).toHaveLength(1);
    expect(executions.rows[0].history_id).toBe(publication.id);
    expect(executions.rows[0].intent.arguments.replyToMessageId).toBe(user.id);
    expect(executions.rows[0].outcome).not.toBeNull();
    expect(contexts[3]!.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'explicit-quoted-answer' && !message.isError)).toBe(true);
    await expect(row(page, user.id).locator('.reply-quote')).toContainText(firstAnswer);
    await expect(row(page, publication.id).locator('.reply-quote')).toContainText(replyText);
    await expect(row(page, publication.id).locator('.message-bubble')).toHaveCount(1);
    await expect(page.locator('.message-row.assistant')).toHaveCount(3);
    await expect(page.locator('.date-divider')).toHaveCount(1);
    expect(await page.locator('.timeline-content').innerText()).not.toMatch(uuid);
    for (const item of timeline) expect(await page.locator('.timeline-content').innerText()).not.toContain(item.id);

    // The timestamp is outside the bubble and appears on hover/focus. The quote
    // is an independently operable control, including keyboard navigation.
    await row(page, publication.id).hover();
    const meta = row(page, publication.id).locator('.message-meta');
    await expect(meta).toHaveCSS('opacity', '1');
    const bubbleBox = await row(page, publication.id).locator('.message-bubble').boundingBox();
    const metaBox = await meta.boundingBox();
    expect(metaBox!.x).toBeGreaterThanOrEqual(bubbleBox!.x + bubbleBox!.width - 1);
    await noOverflow(page); await conversationGeometry(page);
    await page.screenshot({ path: testInfo.outputPath('replies-timeline-desktop.png'), fullPage: true });
    await row(page, publication.id).getByRole('button', { name: '回复这条消息', exact: true }).focus();
    await page.keyboard.press('Enter'); await expect(preview).toContainText(replyAnswer);
    await page.getByRole('button', { name: '取消回复', exact: true }).click();
    await row(page, user.id).getByRole('button', { name: '查看引用的消息', exact: true }).click();
    await expect(row(page, first.id)).toBeInViewport();

    const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'UTC' });
    try {
      const narrow = await touch.newPage(); await narrow.goto(origin);
      await expect(row(narrow, publication.id)).toBeVisible();
      await noOverflow(narrow); await conversationGeometry(narrow);
      await row(narrow, publication.id).getByRole('button', { name: '回复这条消息', exact: true }).tap();
      await expect(narrow.getByLabel('回复预览', { exact: true })).toContainText(replyAnswer);
      await noOverflow(narrow); await conversationGeometry(narrow);
      await narrow.screenshot({ path: testInfo.outputPath('replies-composer-touch.png'), fullPage: true });
      await narrow.getByRole('button', { name: '取消回复', exact: true }).tap();
      await narrow.screenshot({ path: testInfo.outputPath('replies-timeline-narrow.png'), fullPage: true });
    } finally { await touch.close(); }

    const requestsBeforeRestart = contexts.length;
    await app!.close(); app = undefined; await service!.close(); service = undefined;
    await start(); expect(contexts).toHaveLength(requestsBeforeRestart);
    expect((await service!.timeline()).items).toEqual(timeline);
    await page.reload(); await expect(row(page, publication.id).locator('.reply-quote')).toContainText(replyText);
    await say(page, '继续刚才的安排。');
    await expect(page.locator('.message-bubble').filter({ hasText: '路线和刚才的约定都还在，我们继续。' })).toBeVisible();
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    expect(JSON.stringify(contexts.at(-1))).toContain(first.id);
    expect(JSON.stringify(contexts.at(-1))).toContain(user.id);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM tool_executions WHERE intent->>'toolName'='send_reply'")).rows[0].n).toBe(1);
    await expect(row(page, publication.id)).toHaveCount(1); expect(errors).toEqual([]);
  } finally { await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});

// A generic ordinary extension supplies synthetic source metadata. Lost ACKs
// interrupt real network traffic after commit; no fixture invents a receipt.
test('compact generic extension messages and time gaps preserve quoted source through lost acknowledgement and target conflicts', async ({ page }, testInfo) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-reply-receipt-'));
  let db: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  let service: LocalWebService | undefined, app: ReturnType<typeof createLocalHttp> | undefined;
  const contexts: TranscriptContext[] = [], posts: Submitted[] = [];
  let committed = false;
  const sourceText = '东岸步道今天开放，沿途有两处休息区。';
  const text = '收到，周六就走这条路线。';
  page.on('request', req => { if (req.method() === 'POST' && req.url() === `${origin}/api/messages`) posts.push(req.postDataJSON()); });
  try {
    db = await createTestDatabase();
    const entry = path.join(root, 'route-fixture.mjs');
    const occurredAt = new Date(Date.now() - 60_000).toISOString();
    const earlier = new Date(Date.parse(occurredAt) - 5_000).toISOString();
    const old = new Date(Date.parse(occurredAt) - 10 * 60_000).toISOString();
    await writeFile(entry, `export default { name: 'route-demo', async apply({mira}) { await mira.emitEvent({ id: 'route-checking', type: 'route.message', occurredAt: ${JSON.stringify(old)}, payload: { demo: true }, message: { direction: 'outbound', text: '湖边步道有几个入口，我来核对一下开放情况。', sourceLabel: '路线助手' } }); await mira.emitEvent({ id: 'route-summary', type: 'route.message', occurredAt: ${JSON.stringify(earlier)}, payload: { demo: true }, message: { direction: 'outbound', text: '刚整理了一下湖边的步行路线。', sourceLabel: '路线助手' } }); await mira.emitEvent({ id: 'route-open', type: 'route.message', occurredAt: ${JSON.stringify(occurredAt)}, payload: { demo: true }, message: { direction: 'outbound', text: ${JSON.stringify(sourceText)}, sourceLabel: '路线助手' } }); } };`);
    const config = path.join(root, 'extensions.json');
    await writeFile(config, JSON.stringify({ entries: [{ id: 'route-demo', path: entry }] }));
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'reply-receipts', sourceDirectory,
      workingDirectory: root, miraHome: root, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      synthetic: true, syntheticModel: { ...model, contextWindow: 100_000 }, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      extensions: await readExtensionConfiguration(config),
      syntheticStream: (_model, context) => { contexts.push(structuredClone(context)); return streamOf({ ...assistant('好，出门前再看一下天气。'), timestamp: Date.now() }); },
    });
    app = createLocalHttp({ backend: service, port, assetsDirectory: path.join(sourceDirectory, 'apps/web/dist') });
    await app.listen({ port, host: '127.0.0.1' }); await page.goto(origin);
    const target = (await service!.timeline()).items.find(item => item.text === sourceText)!;
    await expect(row(page, target.id)).toBeVisible();
    await expect(page.locator('.message-group.compact')).toHaveCount(1);
    await expect(page.locator('.date-divider')).toHaveCount(2);
    await quote(page, target.id); await expect(page.getByLabel('回复预览', { exact: true })).toContainText('路线助手');
    // Prevent polling from hiding the uncertain UI before the explicit retry.
    await page.route(`${origin}/api/timeline*`, route => route.abort('connectionreset'));
    await page.route(`${origin}/api/messages`, async route => {
      const response = await route.fetch(); expect(response.status()).toBe(201); committed = true;
      await route.abort('connectionreset');
    }, { times: 1 });
    await say(page, text);
    await expect.poll(() => committed).toBe(true);
    await expect(page.getByRole('button', { name: '核对并重试', exact: true })).toBeVisible();
    expect(posts).toHaveLength(1); expect(posts[0]!.replyToMessageId).toBe(target.id);
    await expect(page.locator('.pending-message .reply-quote')).toContainText(sourceText);
    await conversationGeometry(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await noOverflow(page); await conversationGeometry(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    const savedPending = await page.evaluate(() => Object.values(sessionStorage).join('\n'));
    expect(savedPending).toContain(target.id);
    await expect.poll(async () => (await service!.status()).state).toBe('idle');
    await page.unroute(`${origin}/api/timeline*`);
    await page.getByRole('button', { name: '核对并重试', exact: true }).click();
    const items = (await service!.timeline()).items;
    const user = items.find(item => item.text === text)!;
    const other = items.find(item => item.text === '好，出门前再看一下天气。')!;
    await expect(row(page, user.id)).toHaveCount(1);
    await expect(page.getByRole('button', { name: '核对并重试', exact: true })).toHaveCount(0);
    expect(posts).toHaveLength(1); // Timeline reconciliation needs no second POST.
    expect(user.reply?.source).toEqual(target.source);
    expect(latestUserText(contexts[0]!)).toContain('Reply target: role=assistant');
    expect(latestUserText(contexts[0]!)).toContain('"extensionId":"route-demo"');
    expect(latestUserText(contexts[0]!)).toContain('路线助手');
    expect(latestUserText(contexts[0]!)).toContain(sourceText);
    const duplicate = await post(page, posts[0]!);
    expect(duplicate).toEqual({ status: 200, body: { id: posts[0]!.id, receipt: 'duplicate' } });
    expect((await post(page, { ...posts[0]!, replyToMessageId: other.id })).status).toBe(409);
    expect(contexts).toHaveLength(1);
    expect((await db.admin.query("SELECT count(*)::int AS n FROM life_events WHERE event->>'type'='web.message'")).rows[0].n).toBe(1);
    expect((await service!.timeline()).items.filter(item => item.text === text)).toHaveLength(1);
    await row(page, target.id).hover();
    await expect(row(page, target.id).locator('.message-meta')).toHaveCSS('opacity', '1');
    await expect(row(page, target.id).locator('.message-source')).toContainText('路线助手');
    await noOverflow(page); await conversationGeometry(page);
    await page.screenshot({ path: testInfo.outputPath('replies-extension-source-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(page); await conversationGeometry(page);
    await page.screenshot({ path: testInfo.outputPath('replies-extension-source-narrow.png'), fullPage: true });
  } finally { await app?.close(); await service?.close(); await db?.close(); await rm(root, { recursive: true, force: true }); }
});
