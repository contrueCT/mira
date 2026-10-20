import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { WebSettingsStore, createModelTransport, parseModelConfiguration } from '@mira/server';
import { MemoryWriter, input } from '../recovery/fixtures.mts';
import { allowLocalTestHttp } from '../deny-model-network.mts';

const key = 'synthetic-custom-model-private-key';
const events = [{ id: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Saved model works' }, finish_reason: null }] }, { id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
const completion = () => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });

test('real HTTP discovery and saved explicit wire format preserve effort, legacy behavior, errors and secrets', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-custom-setup-'));
  await mkdir(path.join(directory, 'source'));
  const payloads: Record<string, unknown>[] = []; let discoveries = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (request.url === '/v1/models') {
      discoveries++; response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'gpt-6-luna', name: 'Fixture model', context_length: 32000, top_provider: { max_completion_tokens: 4096 }, input: ['text'], reasoning: true }] })); return;
    }
    assert.equal(request.url, '/v1/chat/completions');
    let body = ''; for await (const part of request) body += part.toString();
    const parsed = JSON.parse(body) as Record<string, unknown>; payloads.push(parsed);
    if ('reasoning_effort' in parsed) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `litellm.UnsupportedParamsError: openai does not support parameters: ['reasoning_effort']; ${key}` } })); return;
    }
    response.setHeader('content-type', 'text/event-stream'); response.end(await completion().text());
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`; const revoke = allowLocalTestHttp(origin);
  const file = path.join(directory, 'private', 'settings.json'); const source = path.join(directory, 'source');
  try {
    let store = new WebSettingsStore(file, source);
    const connection = { id: 'fixture', api: 'openai-completions' as const, baseUrl: `${origin}/v1`, apiKey: key, models: [] };
    const found = await store.discover(connection);
    assert.equal(discoveries, 1); assert.ok(!JSON.stringify(found).includes(key));
    assert.deepEqual(found.models[0], { id: 'gpt-6-luna', name: 'Fixture model', contextWindow: 32000, maxTokens: 4096, input: ['text'], reasoning: true });
    const model = found.models[0]!;
    const saved = await store.save({ ...await store.get(), selection: { kind: 'custom', connection: 'fixture', model: model.id }, configuration: { defaultThinkingLevel: 'high', builtinCredentials: {}, customConnections: [{ ...connection, models: [{ id: model.id, name: model.name!, contextWindow: model.contextWindow!, maxTokens: model.maxTokens!, input: model.input!, reasoning: model.reasoning! }] }] } });
    assert.ok(!JSON.stringify(saved).includes(key));
    store = new WebSettingsStore(file, source);
    const restarted = await store.get(); assert.equal(restarted.configuration.customConnections[0]!.models[0]!.reasoning, true);
    assert.equal(restarted.configuration.customConnections[0]!.models[0]!.reasoningFormat, undefined);
    let diagnostic = '';
    const transport = store.transport(restarted, { onFailure: failure => { if (failure) diagnostic = failure.message; } });
    assert.equal(transport.thinkingLevel, 'high', 'legacy profiles must not silently lose configured effort');
    await assert.rejects(new PiDurableRuntime({ writer: new MemoryWriter(), ...transport, autoCompaction: { enabled: false } }).run(input('Use saved model')));
    assert.equal(payloads.length, 1, '400 must not trigger a stripped retry');
    assert.equal(payloads[0]!['reasoning_effort'], 'high');
    assert.match(diagnostic, /reasoning_effort/); assert.ok(!diagnostic.includes(key));
    const retained = restarted.configuration.customConnections[0]!;
    const enabled = await store.save({ ...restarted, configuration: { ...restarted.configuration, customConnections: [{ ...retained, models: retained.models.map(entry => ({ ...entry, reasoningFormat: 'openrouter' })) }] } });
    store = new WebSettingsStore(file, source);
    const optedIn = store.transport(await store.get());
    assert.equal(optedIn.thinkingLevel, 'high');
    await new PiDurableRuntime({ writer: new MemoryWriter(), ...optedIn, autoCompaction: { enabled: false } }).run(input('Explicit fixture-compatible format'));
    assert.equal(payloads.length, 2); assert.equal(payloads[1]!['reasoning_effort'], undefined);
    assert.deepEqual(payloads[1]!['reasoning'], { effort: 'high' });
    assert.equal(payloads[1]!['model'], model.id);
    assert.equal((await store.get()).configuration.customConnections[0]!.models[0]!.reasoningFormat, 'openrouter');
    assert.ok(!JSON.stringify(enabled).includes(key));
  } finally {
    revoke(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

for (const format of ['openai', 'openrouter', 'litellm'] as const) {
  test(`explicit ${format} format sends the configured effort without mixed fields`, async () => {
    for (const effort of ['low', 'medium', 'high'] as const) {
      let body: Record<string, unknown> | undefined;
      const configuration = { builtinCredentials: {}, customConnections: [{ id: 'fixture', api: 'openai-completions' as const, baseUrl: 'https://synthetic.example/v1', apiKeyEnv: 'KEY', models: [{ id: 'gpt-6-luna', contextWindow: 32000, maxTokens: 4096, reasoning: true, reasoningFormat: format, input: ['text' as const] }] }] };
      const transport = createModelTransport(configuration, { kind: 'custom', connection: 'fixture', model: 'gpt-6-luna' }, { env: () => key, fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return completion(); } });
      const stream = await transport.streamFn(transport.model, normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 1 }] }), { reasoning: effort });
      await stream.result(); assert.ok(body);
      assert.equal(body['reasoning_effort'], format !== 'openrouter' ? effort : undefined);
      assert.deepEqual(body['reasoning'], format === 'openrouter' ? { effort } : undefined);
      assert.deepEqual(body['allowed_openai_params'], format === 'litellm' ? ['reasoning_effort'] : undefined);
      assert.equal(body['drop_params'], undefined);
    }
  });
}

test('invalid or wrong-protocol compatibility declarations fail before requests', () => {
  for (const [api, reasoningFormat] of [['openai-completions', true], ['openai-completions', 'unsupported'], ['openai-completions', null], ['openai-responses', 'openrouter'], ['openai-responses', 'litellm'], ['anthropic-messages', 'openai']]) {
    assert.throws(() => parseModelConfiguration({ customConnections: [{ id: 'fixture', api, baseUrl: 'https://synthetic.example/v1', apiKeyEnv: 'KEY', models: [{ id: 'test', contextWindow: 32000, maxTokens: 4096, reasoning: true, reasoningFormat, input: ['text'] }] }] }));
  }
});

test('automatic custom format preserves pinned Pi URL compatibility and configured effort', async () => {
  for (const [baseUrl, expectedField] of [['https://synthetic.example/v1', 'reasoning_effort'], ['https://openrouter.ai/api/v1', 'reasoning']] as const) {
    let body: Record<string, unknown> | undefined;
    const configuration = { builtinCredentials: {}, customConnections: [{ id: 'fixture', api: 'openai-completions' as const, baseUrl, apiKeyEnv: 'KEY', models: [{ id: 'fixture-model', contextWindow: 32000, maxTokens: 4096, reasoning: true, input: ['text' as const] }] }] };
    const transport = createModelTransport(configuration, { kind: 'custom', connection: 'fixture', model: 'fixture-model' }, { env: () => key, fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return completion(); } });
    const stream = await transport.streamFn(transport.model, normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 1 }] }), { reasoning: 'high' });
    await stream.result(); assert.ok(body);
    assert.equal(body['reasoning_effort'], expectedField === 'reasoning_effort' ? 'high' : undefined);
    assert.deepEqual(body['reasoning'], expectedField === 'reasoning' ? { effort: 'high' } : undefined);
  }
});
