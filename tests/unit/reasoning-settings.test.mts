import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { getSupportedThinkingLevels, type Model, type Api } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { PiDurableRuntime, resolveThinkingLevel, supportedThinkingLevels, compactionThinkingLevel, type ThinkingLevel } from '@mira/runtime-pi';
import { WebSettingsStore, parseWebSettingsWrite, parseModelConfiguration, createModelTransport, listBuiltinCatalog, type CustomProtocol } from '@mira/server';
import { MemoryWriter, model, input, assistant, streamOf } from '../recovery/fixtures.mts';

const key = 'sk-synthetic-reasoning-key';
function response(api: CustomProtocol): Response {
  if (api === 'anthropic-messages') {
    const events = [
      { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', content: [], model: 'reasoner', usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic summary or answer' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  }
  const item = { id: 'msg-synthetic', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Synthetic summary or answer', annotations: [] }] };
  const events = api === 'openai-completions' ? [
    { id: 'synthetic', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic summary or answer' }, finish_reason: null }] },
    { id: 'synthetic', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 } }, '[DONE]',
  ] : [
    { type: 'response.created', response: { id: 'synthetic', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'Synthetic summary or answer' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'synthetic', status: 'completed', output: [item], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 0 } } } },
  ];
  return new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function configuration(api: CustomProtocol, level: ThinkingLevel = 'high', reasoning = true) {
  return { defaultThinkingLevel: level, builtinCredentials: {}, customConnections: [{ id: 'reasoning', api, baseUrl: 'https://synthetic.example/v1', apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: 'reasoner', contextWindow: 100_000, maxTokens: 32_768, reasoning, input: ['text' as const] }] }] };
}
const selection = { kind: 'custom', connection: 'reasoning', model: 'reasoner' } as const;

test('reasoning capabilities use pinned Pi metadata, with medium default and independent lowest-supported summaries', () => {
  for (const provider of listBuiltinCatalog().providers) for (const entry of provider.models) {
    const upstream = builtinModels().getModel(provider.id, entry.id)!;
    assert.deepEqual(entry.thinkingLevels, getSupportedThinkingLevels(upstream));
    assert.equal(compactionThinkingLevel(upstream), entry.thinkingLevels[0] ?? 'off');
  }
  assert.equal(resolveThinkingLevel(model), 'off');
  assert.equal(resolveThinkingLevel({ ...model, reasoning: true }), 'medium');
  assert.equal(resolveThinkingLevel({ ...model, reasoning: true }, 'max'), 'high');
  const restricted: Model<Api> = { ...model, reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: 'low', xhigh: 'xhigh', max: null } };
  assert.deepEqual(supportedThinkingLevels(restricted), ['low', 'medium', 'high', 'xhigh']);
  assert.equal(resolveThinkingLevel(restricted, 'off'), 'low');
  assert.equal(compactionThinkingLevel(restricted), 'low');
  for (const value of ['auto', 'ultra', '', null, 3, {}]) assert.throws(() => parseModelConfiguration({ defaultThinkingLevel: value }));
});

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
  test(`actual ${api} serialization receives runtime reasoning, bounded output, restart preference and independent summary policy`, async () => {
    const bodies: Record<string, unknown>[] = []; const writer = new MemoryWriter();
    const transport = createModelTransport(configuration(api), selection, { env: () => key, fetch: async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response(api); } });
    assert.equal(transport.thinkingLevel, 'high');
    let runtime = new PiDurableRuntime({ writer, ...transport, autoCompaction: { enabled: false, reserveTokens: 4096 } });
    await runtime.run(input('First synthetic reasoning request'));
    runtime = new PiDurableRuntime({ writer, ...transport, autoCompaction: { enabled: false, reserveTokens: 4096 } });
    await runtime.run(input('Restart continuation'));
    for (const body of bodies) {
      if (api === 'openai-completions') { assert.equal(body['reasoning_effort'], 'high'); assert.equal(body['max_completion_tokens'], 4096); }
      if (api === 'openai-responses') { assert.deepEqual(body['reasoning'], { effort: 'high', summary: 'auto' }); assert.equal(body['max_output_tokens'], 4096); }
      if (api === 'anthropic-messages') { assert.deepEqual(body['thinking'], { type: 'enabled', budget_tokens: 3072, display: 'summarized' }); assert.equal(body['max_tokens'], 4096); }
    }
    await runtime.compact({ keepRecentTokens: 1, reserveTokens: 512 });
    const summary = bodies.at(-1)!;
    assert.equal(bodies.length, 3);
    assert.equal(summary['reasoning_effort'], undefined); assert.deepEqual(summary['reasoning'], api === 'openai-responses' ? { effort: 'none' } : undefined); assert.deepEqual(summary['thinking'], api === 'anthropic-messages' ? { type: 'disabled' } : undefined);
    assert.equal(summary[api === 'openai-completions' ? 'max_completion_tokens' : api === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'], 512);
    await runtime.run(input('Continue after summary'));
    assert.equal(bodies.length, 4);
    assert.doesNotMatch(JSON.stringify(writer.state), /sk-synthetic-reasoning-key/);
  });
}

test('non-reasoning and explicitly off models never serialize an enabled reasoning option; invalid low Anthropic budget never sends', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) for (const reasoning of [false, true]) {
    let body: Record<string, unknown> | undefined;
    const transport = createModelTransport(configuration(api, reasoning ? 'off' : 'max', reasoning), selection, { env: () => key, fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return response(api); } });
    await new PiDurableRuntime({ writer: new MemoryWriter(), ...transport }).run(input());
    assert.ok(body); assert.equal(body['reasoning_effort'], undefined); assert.deepEqual(body['reasoning'], api === 'openai-responses' && reasoning ? { effort: 'none' } : undefined); assert.deepEqual(body['thinking'], api === 'anthropic-messages' && reasoning ? { type: 'disabled' } : undefined);
  }
  let sent = 0;
  const transport = createModelTransport(configuration('anthropic-messages'), selection, { env: () => key, fetch: async () => { sent++; return response('anthropic-messages'); } });
  await assert.rejects(new PiDurableRuntime({ writer: new MemoryWriter(), ...transport, autoCompaction: { reserveTokens: 1024 } }).run(input()));
  assert.equal(sent, 0);
});

test('builtin adaptive Anthropic uses actual effort mapping, and runtime capability adaptation reaches OpenAI wire payload', async () => {
  const catalog = builtinModels();
  const adaptive = catalog.getModels('anthropic').find(entry => entry.compat && 'forceAdaptiveThinking' in entry.compat && entry.compat.forceAdaptiveThinking === true && entry.thinkingLevelMap?.xhigh === 'xhigh')!;
  assert.ok(adaptive);
  let body: Record<string, unknown> | undefined;
  const transport = createModelTransport({ defaultThinkingLevel: 'xhigh', builtinCredentials: { anthropic: { apiKeyEnv: 'SYNTHETIC' } }, customConnections: [] }, { kind: 'builtin', provider: 'anthropic', model: adaptive.id }, { env: () => key, fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return response('anthropic-messages'); } });
  await new PiDurableRuntime({ writer: new MemoryWriter(), ...transport }).run(input());
  assert.ok(body); assert.equal((body['thinking'] as Record<string, unknown>)['type'], 'adaptive'); assert.deepEqual(body['output_config'], { effort: 'xhigh' });
  const adapted = createModelTransport(configuration('openai-completions', 'max'), selection, { env: () => key, fetch: async (_url, init) => { body = JSON.parse(String(init?.body)); return response('openai-completions'); } });
  assert.equal(adapted.thinkingLevel, 'high');
  await new PiDurableRuntime({ writer: new MemoryWriter(), ...adapted }).run(input());
  assert.equal(body['reasoning_effort'], 'high');
});

test('explicit runtime default is present on every normal request and summary lowest mandatory level is separate', async () => {
  await new PiDurableRuntime({ writer: new MemoryWriter(), model: { ...model, reasoning: true }, streamFn: (_model, _context, options) => { assert.equal(options?.reasoning, 'medium'); return streamOf(assistant()); } }).run(input());
  const seen: (ThinkingLevel | undefined)[] = []; const writer = new MemoryWriter();
  const mandatory: Model<Api> = { ...model, reasoning: true, contextWindow: 100_000, thinkingLevelMap: { off: null, minimal: null } };
  const runtime = new PiDurableRuntime({ writer, model: mandatory, thinkingLevel: 'high', streamFn: (_model, _context, options) => { seen.push(options?.reasoning); return streamOf(assistant('Synthetic summary or answer')); } });
  await runtime.run(input('One')); await runtime.run(input('Two')); await runtime.compact({ keepRecentTokens: 1, reserveTokens: 512 }); await runtime.run(input('Three'));
  assert.deepEqual(seen, ['high', 'high', 'low', 'high']);
});

test('private settings persist reasoning preference without a key leak, adapt a changed model, preserve CAS and reject malformed levels', async () => {
  const root = await realpath(await mkdtemp('/tmp/mira-reasoning-settings-')); const source = path.join(root, 'source'); await mkdir(source);
  try {
    const store = new WebSettingsStore(path.join(root, 'data', 'models.json'), source); const initial = await store.get();
    const { apiKeyEnv: _env, ...connection } = configuration('openai-completions').customConnections[0]!;
    const saved = await store.save({ ...initial, selection, configuration: { defaultThinkingLevel: 'max', builtinCredentials: {}, customConnections: [{ ...connection, apiKey: key }] } });
    assert.equal(saved.configuration.defaultThinkingLevel, 'max'); assert.equal(store.transport(saved).thinkingLevel, 'high');
    assert.doesNotMatch(JSON.stringify(saved), /sk-synthetic-reasoning-key/);
    assert.equal(JSON.parse(await readFile(store.file, 'utf8')).configuration.defaultThinkingLevel, 'max');
    assert.deepEqual(await new WebSettingsStore(store.file, source).get(), saved);
    const changed = await store.save({ ...saved, configuration: { ...saved.configuration, customConnections: saved.configuration.customConnections.map(entry => ({ ...entry, models: entry.models.map(model => ({ ...model, reasoning: false })) })) } });
    assert.equal(changed.configuration.defaultThinkingLevel, 'max'); assert.equal(store.transport(changed).thinkingLevel, 'off');
    await assert.rejects(store.save({ ...saved, configuration: { ...saved.configuration, defaultThinkingLevel: 'low' } }), /Settings changed/);
    for (const value of ['auto', null, 5, { level: 'high' }]) assert.throws(() => parseWebSettingsWrite({ ...changed, configuration: { ...changed.configuration, defaultThinkingLevel: value } }), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('actual Google SDK serializes configured reasoning budgets and explicit off under the same output cap', async t => {
  const bodies: Record<string, unknown>[] = [];
  // Pi Google intentionally rejects per-call fetch injection. Intercept its SDK's
  // actual global fetch; the process-wide network deny guard is never relaxed.
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Synthetic Google answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  for (const defaultThinkingLevel of ['low', 'off'] as const) {
    const transport = createModelTransport({ defaultThinkingLevel, builtinCredentials: { google: { apiKeyEnv: 'SYNTHETIC' } }, customConnections: [] }, { kind: 'builtin', provider: 'google', model: 'gemini-2.5-flash' }, { env: () => key });
    await new PiDurableRuntime({ writer: new MemoryWriter(), ...transport, autoCompaction: { reserveTokens: 4096 } }).run(input());
  }
  const first = bodies[0]!['generationConfig'] as Record<string, unknown>; const second = bodies[1]!['generationConfig'] as Record<string, unknown>;
  assert.equal(first['maxOutputTokens'], 4096); assert.deepEqual(first['thinkingConfig'], { includeThoughts: true, thinkingBudget: 2048 });
  assert.equal(second['maxOutputTokens'], 4096); assert.deepEqual(second['thinkingConfig'], { thinkingBudget: 0 });
});

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
  test(`saved Web reasoning settings dispatch through real ${api} serialization while stale or forged snapshots cannot resolve a key`, async () => {
    const root = await realpath(await mkdtemp('/tmp/mira-web-reasoning-transport-')); const source = path.join(root, 'source'); await mkdir(source);
    try {
      const file = path.join(root, 'data', 'models.json'); const store = new WebSettingsStore(file, source);
      const { apiKeyEnv: _env, ...connection } = configuration(api).customConnections[0]!;
      let saved = await store.save({ ...await store.get(), selection, configuration: { defaultThinkingLevel: 'high', builtinCredentials: {}, customConnections: [{ ...connection, apiKey: key }] } });
      const bodies: Record<string, unknown>[] = [];
      const fetch: typeof globalThis.fetch = async (url, init) => {
        assert.equal(new URL(String(url)).origin, 'https://synthetic.example');
        assert.equal(new Headers(init?.headers).get(api === 'anthropic-messages' ? 'x-api-key' : 'authorization'), api === 'anthropic-messages' ? key : `Bearer ${key}`);
        bodies.push(JSON.parse(String(init?.body))); return response(api);
      };
      const run = async (transport: ReturnType<WebSettingsStore['transport']>) => new PiDurableRuntime({ writer: new MemoryWriter(), ...transport, autoCompaction: { enabled: false, reserveTokens: 4096 } }).run(input());
      await run(store.transport(saved, { fetch }));
      // A reopened store and reordered public keys describe the same persisted
      // snapshot. Property insertion order must never decide credential access.
      const reopened = new WebSettingsStore(file, source); const restored = await reopened.get();
      await run(reopened.transport({ selection: restored.selection, configuration: { customConnections: restored.configuration.customConnections, builtinCredentials: restored.configuration.builtinCredentials, defaultThinkingLevel: restored.configuration.defaultThinkingLevel! }, revision: restored.revision }, { fetch }));
      assert.equal(bodies.length, 2);
      for (const body of bodies) {
        if (api === 'openai-completions') assert.equal(body['reasoning_effort'], 'high');
        if (api === 'openai-responses') assert.deepEqual(body['reasoning'], { effort: 'high', summary: 'auto' });
        if (api === 'anthropic-messages') assert.deepEqual(body['thinking'], { type: 'enabled', budget_tokens: 3072, display: 'summarized' });
      }
      for (const configuration of [
        { ...saved.configuration, defaultThinkingLevel: 'low' as const },
        { ...saved.configuration, customConnections: saved.configuration.customConnections.map(entry => ({ ...entry, baseUrl: 'https://different.example/v1' })) },
      ]) await assert.rejects(run(store.transport({ ...saved, configuration }, { fetch })), /Unable to read the configured API key/);
      assert.equal(bodies.length, 2, 'a correct revision alone never authorizes changed metadata or a new credential destination');
      const stale = store.transport(saved, { fetch });
      saved = await store.save({ ...saved, configuration: { ...saved.configuration, defaultThinkingLevel: 'off' } });
      await assert.rejects(run(stale), /Unable to read the configured API key/);
      assert.equal(bodies.length, 2, 'an actual revision change invalidates captured transports before dispatch');
      await run(store.transport(saved, { fetch }));
      assert.equal(bodies.length, 3);
      const disabled = bodies.at(-1)!;
      assert.equal(disabled['reasoning_effort'], undefined);
      assert.deepEqual(disabled['reasoning'], api === 'openai-responses' ? { effort: 'none' } : undefined);
      assert.deepEqual(disabled['thinking'], api === 'anthropic-messages' ? { type: 'disabled' } : undefined);
      assert.doesNotMatch(JSON.stringify(saved), /sk-synthetic-reasoning-key/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('pinned Google discrete-thinking model serializes explicit and capability-adapted native levels without a token budget', async t => {
  const bodies: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Synthetic discrete-thinking answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  for (const defaultThinkingLevel of ['high', 'off'] as const) {
    const transport = createModelTransport({ defaultThinkingLevel, builtinCredentials: { google: { apiKeyEnv: 'SYNTHETIC' } }, customConnections: [] }, { kind: 'builtin', provider: 'google', model: 'gemini-3.1-pro-preview' }, { env: () => key });
    assert.equal(transport.thinkingLevel, defaultThinkingLevel === 'off' ? 'low' : 'high');
    await new PiDurableRuntime({ writer: new MemoryWriter(), ...transport, autoCompaction: { reserveTokens: 4096 } }).run(input());
  }
  for (const [index, level] of ['HIGH', 'LOW'].entries()) {
    const config = bodies[index]!['generationConfig'] as Record<string, unknown>;
    assert.equal(config['maxOutputTokens'], 4096); assert.deepEqual(config['thinkingConfig'], { includeThoughts: true, thinkingLevel: level });
  }
});
