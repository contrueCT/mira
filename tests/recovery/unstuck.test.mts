import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalWebService, createLocalHttp } from '@mira/server';
import type { JsonObject, TranscriptContext } from '@earendil-works/pi-ai';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

async function until(check: () => Promise<boolean>, message: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!await check()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 20)); }
}
const call = (id: string, name: string, args: JsonObject) => streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }] });
// Conversation only: the system prompt itself names these event types.
const transcript = (context: TranscriptContext) => JSON.stringify(context.messages.filter(message => message.role !== 'system'));
const lastUser = (context: TranscriptContext) => { const message = context.messages.findLast(item => item.role === 'user'); return typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content); };
async function setup(prefix: string) {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp(`/tmp/${prefix}-`));
  const base = { connectionString: db.connectionString, schema: db.schema, sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, autoCompaction: { enabled: false as const }, dreaming: { enabled: false } };
  return { db, root, base, cleanup: async () => { await db.close(); await rm(root, { recursive: true, force: true }); } };
}
const idle = (service: LocalWebService) => until(async () => (await service.status()).state !== 'working', 'Wake did not settle');

test('real PG/service: a stuck tool moves to the background when the user asks, Mira answers, the real result wakes her later; NO_REPLY is hidden and 已读 is on the latest user message only', { timeout: 60_000 }, async () => {
  const { root, base, cleanup } = await setup('mira-unstuck-handoff'); let service: LocalWebService | undefined;
  const done = path.join(root, 'done'); const contexts: TranscriptContext[] = [];
  const release = path.join(root, 'release');
  const options = { ...base, miraId: 'unstuck-handoff', foreground: { steerGraceMs: 150, hardLimitMs: 60_000 },
    syntheticStream: (_model: unknown, context: TranscriptContext) => {
      contexts.push(context);
      const n = contexts.length;
      if (n === 1) return call('slow', 'bash', { command: `while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.05; done; echo finished-for-real > ${JSON.stringify(done)}; echo BUILD_OK` });
      if (n === 2) return streamOf(assistant('还在跑，我没被卡住，跑完告诉你。'));
      if (n === 3) return streamOf(assistant('NO_REPLY'));
      throw Error(`unexpected model request ${n}`);
    } };
  try {
    service = await LocalWebService.open(options);
    await service.submit({ id: 'ask-build', text: '跑一下构建', occurredAt: new Date().toISOString() });
    await until(async () => contexts.length === 1 && (await service!.status()).state === 'working', 'tool did not start');
    await new Promise(resolve => setTimeout(resolve, 100));
    await service.submit({ id: 'check-in', text: '怎么样了？', occurredAt: new Date().toISOString() });
    await until(async () => contexts.length >= 2, 'the check-in was not delivered while the tool still ran');
    const second = contexts[1]!;
    assert.match(lastUser(second), /怎么样了/);
    assert.match(lastUser(second), /\[Mira runtime status — system-sourced, not written by the user\]/);
    assert.match(lastUser(second), /nothing was cancelled/); assert.match(lastUser(second), /bash \(job /);
    assert.match(transcript(second), /backgrounded/); assert.match(transcript(second), /outcome unknown/);
    await idle(service);
    await assert.rejects(readFile(done, 'utf8'), 'the tool is still running after Mira replied');
    let timeline = await service.timeline();
    const users = timeline.items.filter(item => item.role === 'user');
    assert.deepEqual(users.map(item => [item.text, item.read ?? false]), [['跑一下构建', false], ['怎么样了？', true]]);
    assert.ok(timeline.items.some(item => item.role === 'assistant' && item.text.includes('还在跑')));
    assert.doesNotMatch(JSON.stringify(timeline), /runtime status|backgrounded|job/);
    // The real result arrives as an event that wakes Mira; she stays silent.
    await writeFile(release, '');
    await until(async () => contexts.length >= 3, 'settled event did not wake Mira');
    assert.match(transcript(contexts[2]!), /tool\.background\.settled/); assert.match(transcript(contexts[2]!), /BUILD_OK/);
    await idle(service);
    assert.equal(await readFile(done, 'utf8'), 'finished-for-real\n');
    timeline = await service.timeline();
    assert.ok(!timeline.items.some(item => item.text.trim() === 'NO_REPLY'), 'NO_REPLY is never shown');
    assert.deepEqual(timeline.items.filter(item => item.role === 'user').map(item => item.read ?? false), [false, true]);
    // HTTP projection carries `read` only for the latest user message.
    const app = createLocalHttp({ backend: service, port: 4319 });
    try {
      const response = await app.inject({ url: '/api/timeline', headers: { host: '127.0.0.1:4319', 'x-mira-client': 'web' } });
      const items = response.json().items as Array<{ role: string; read?: boolean; text: string }>;
      assert.deepEqual(items.filter(item => item.role === 'user').map(item => item.read ?? null), [null, true]);
      assert.ok(!items.some(item => item.text === 'NO_REPLY'));
    } finally { await app.close(); }
    // A new unread message moves 已读 off the older one until Mira receives it.
  } finally { await service?.close(); await cleanup(); }
});

test('real PG/service: restart while a tool runs in the background records an unknown outcome once and never re-runs it', { timeout: 60_000 }, async () => {
  const { root, base, cleanup } = await setup('mira-unstuck-restart'); let service: LocalWebService | undefined;
  const effect = path.join(root, 'effect'); const contexts: TranscriptContext[] = [];
  const options = { ...base, miraId: 'unstuck-restart', foreground: { steerGraceMs: 20_000, hardLimitMs: 300 },
    syntheticStream: (_model: unknown, context: TranscriptContext) => {
      contexts.push(context);
      const text = transcript(context);
      if (text.includes('tool.background.lost')) return streamOf(assistant('刚才那个命令因为重启结果未知，我先检查一下再说。'));
      if (contexts.length === 1) return call('long', 'bash', { command: `echo start >> ${JSON.stringify(effect)}; sleep 30` });
      return streamOf(assistant('命令还在后台跑。'));
    } };
  try {
    service = await LocalWebService.open(options);
    await service.submit({ id: 'start-long', text: '跑个长命令', occurredAt: new Date().toISOString() });
    await until(async () => contexts.length >= 2, 'hard limit did not move the tool to the background');
    assert.match(transcript(contexts[1]!), /backgrounded/);
    await idle(service);
    await service.close(); service = undefined;
    service = await LocalWebService.open(options);
    await until(async () => contexts.some(context => transcript(context).includes('tool.background.lost')), 'lost event did not wake Mira');
    await idle(service);
    const lost = contexts.find(context => transcript(context).includes('tool.background.lost'))!;
    assert.match(transcript(lost), /outcome is unknown and it was not re-run/);
    assert.equal(await readFile(effect, 'utf8'), 'start\n', 'never replayed');
    const count = contexts.length;
    await service.close(); service = undefined;
    service = await LocalWebService.open(options);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(contexts.length, count, 'lost is recorded once; a second restart does not wake again');
    assert.equal(await readFile(effect, 'utf8'), 'start\n');
  } finally { await service?.close(); await cleanup(); }
});

test('real PG/service: a hung context provider times out and the model request still goes out', { timeout: 60_000 }, async () => {
  const { root, base, cleanup } = await setup('mira-unstuck-provider'); let service: LocalWebService | undefined;
  const file = path.join(root, 'slow-provider.mjs');
  await writeFile(file, `import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
    export default defineExtension({ name: 'slow-provider', apply(ctx) { ctx.registerContextProvider({ id: 'slow', provide() { return new Promise(resolve => setTimeout(() => resolve({ text: 'too late' }), 1500)); } }); } });`);
  const prompts: string[] = []; const started = Date.now();
  const options = { ...base, miraId: 'unstuck-provider', extensions: { entries: [{ id: 'slow-provider', path: file }], contextProviderTimeoutMs: 100 },
    syntheticStream: (_model: unknown, context: TranscriptContext) => { prompts.push(getCurrentSystemPrompt(context.messages)); return streamOf(assistant('收到')); } };
  try {
    service = await LocalWebService.open(options);
    await service.submit({ id: 'hello', text: '在吗', occurredAt: new Date().toISOString() });
    await until(async () => prompts.length >= 1, 'model request was held by the provider');
    assert.ok(Date.now() - started < 10_000);
    assert.match(prompts[0]!, /"providerId":"slow","status":"timeout"/);
    assert.doesNotMatch(prompts[0]!, /too late/);
    await idle(service);
    const timeline = await service.timeline();
    assert.deepEqual(timeline.items.filter(item => item.role === 'user').map(item => item.read), [true]);
  } finally { await service?.close(); await cleanup(); }
});
