// Explicit UI fixture: no database, tools or model network. Real persistence is
// covered separately by PostgreSQL recovery tests, never claimed by this fixture.
import { createLocalHttp, type WebBackend } from '../../apps/server/src/http.ts';
import type { WebSettings, WebSettingsWrite } from '../../apps/server/src/web-settings.ts';
import { webConnectionMetadata } from '../../apps/server/src/web-model-config.ts';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
let settings: WebSettings = { revision: '0'.repeat(64), configuration: { builtinCredentials: {}, customConnections: [] }, selection: null };
const items: Awaited<ReturnType<WebBackend['timeline']>>['items'] = [
  { id: '10000000-0000-4000-8000-000000000001', role: 'user', text: 'Mira，我们从这里开始吧', occurredAt: '2026-10-06T08:00:00.000Z' },
  { id: '10000000-0000-4000-8000-000000000002', role: 'assistant', text: '好，我在。\n\n这里是一条持续的时间线。你可以和我聊天，刷新页面后继续之前的对话。', occurredAt: '2026-10-06T08:00:01.000Z' },
  { id: '10000000-0000-4000-8000-000000000003', role: 'user', text: '目前可以测试什么？', occurredAt: '2026-10-06T08:00:02.000Z' },
  { id: '10000000-0000-4000-8000-000000000004', role: 'assistant', text: '可以先看看消息发送、回复和模型设置。\n\n现在使用模拟模式，不会调用真实模型。准备好以后，再选择模型并在设置里填写 API Key。', occurredAt: '2026-10-06T08:00:03.000Z' },
];
let working = false;
const envelopes = new Map<string, string>();
const backend: WebBackend = {
  async status() { return { state: working ? 'working' : 'idle', mode: 'synthetic', model: '模拟模型', error: null }; },
  async timeline() { return { items: structuredClone(items), nextCursor: null }; },
  async submit(input) {
    const prior = envelopes.get(input.id); const exact = JSON.stringify(input);
    if (prior && prior !== exact) throw Error('Conflicting fixture envelope');
    if (prior) return { id: input.id, receipt: 'duplicate' };
    envelopes.set(input.id, exact); items.push({ id: randomUUID(), externalEventId: input.id, role: 'user', text: input.text, occurredAt: input.occurredAt }); working = true;
    setTimeout(() => { items.push({ id: randomUUID(), role: 'assistant', text: `已收到：${input.text}\n这是一条界面测试回复。`, occurredAt: new Date().toISOString() }); working = false; }, 250);
    return { id: input.id, receipt: 'inserted' };
  },
  async settings() { return structuredClone(settings); },
  async saveSettings(value) {
    const write = value as WebSettingsWrite;
    settings = { selection: write.selection, revision: '1'.repeat(64), configuration: {
      ...(write.configuration.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: write.configuration.defaultThinkingLevel }),
      builtinCredentials: Object.fromEntries(Object.entries(write.configuration.builtinCredentials).map(([id, entry]) => [id, { hasApiKey: typeof entry.apiKey === 'string' || (entry.apiKey !== null && entry.hasApiKey === true) }])),
      customConnections: write.configuration.customConnections.map(connection => ({ ...webConnectionMetadata(connection), hasApiKey: typeof connection.apiKey === 'string' || (connection.apiKey !== null && connection.hasApiKey === true) })),
    } };
    return structuredClone(settings);
  },
  async discover() { return { endpoint: 'http://127.0.0.1/models', models: [{ id: 'fixture-model', name: 'Fixture model' }] }; },
};
const app = createLocalHttp({ backend, port: 3211, assetsDirectory: path.resolve('apps/web/dist') });
await app.listen({ host: '127.0.0.1', port: 3211 });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close(); });
