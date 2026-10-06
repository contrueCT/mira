import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { normalizeContext } from '@earendil-works/pi-ai';
import { builtinModels, getBuiltinModelDataGeneratedAt } from '@earendil-works/pi-ai/providers/all';
import { getBuiltinCatalogModel, listBuiltinCatalog, parseModelConfiguration, createModelTransport, type CustomConnection, type CustomProtocol } from '@mira/server';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { MemoryWriter, effectTool, result, input } from '../recovery/fixtures.mts';

const syntheticKey = 'synthetic-custom-key';
function connection(api: CustomProtocol = 'openai-completions'): CustomConnection {
  return { id: 'openai', baseUrl: 'https://custom.example/proxy/api', api, apiKeyEnv: 'EXPLICIT_CUSTOM_KEY', models: [{ id: 'manual-id', contextWindow: 8192, maxTokens: 1024, reasoning: false, input: ['text'] }] };
}
function config(api: CustomProtocol = 'openai-completions') { return { builtinCredentials: {}, customConnections: [connection(api)] }; }
const transcript = normalizeContext({ messages: [{ role: 'user', content: 'Synthetic test', timestamp: 1 }] });
function sse(events: unknown[]): Response {
  return new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function completions(text = 'Synthetic transport answer', tools = false): Response {
  return sse([
    { id: 'synthetic-response', choices: [{ index: 0, delta: tools ? { role: 'assistant', tool_calls: [{ index: 0, id: 'transport-effect', type: 'function', function: { name: 'effect', arguments: '{}' } }] } : { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'synthetic-response', choices: [{ index: 0, delta: {}, finish_reason: tools ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }, '[DONE]',
  ]);
}
function responseEvents(): Response {
  const item = { id: 'msg-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Responses answer', annotations: [] }] };
  return sse([
    { type: 'response.created', response: { id: 'resp-1', status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg-1', part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg-1', delta: 'Responses answer' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id: 'resp-1', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 } } } },
  ]);
}
function anthropicEvents(): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg-1', type: 'message', role: 'assistant', content: [], model: 'manual-id', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Anthropic answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

test('catalog derives every bundled provider and chat model without credentials or static registry copies', () => {
  const actual = listBuiltinCatalog(); const upstream = builtinModels();
  assert.equal(actual.generatedAt, getBuiltinModelDataGeneratedAt());
  assert.deepEqual(actual.providers.map(provider => provider.id), upstream.getProviders().map(provider => provider.id));
  for (const provider of actual.providers) {
    const models = upstream.getModels(provider.id);
    assert.equal(provider.models.length, models.length);
    for (let i = 0; i < models.length; i++) {
      const source = models[i]!; const item = provider.models[i]!;
      assert.equal(item.id, source.id); assert.equal(item.protocol.id, source.api); assert.equal(item.contextWindow, source.contextWindow); assert.equal(item.maxTokens, source.maxTokens);
    }
  }
  const mixed = actual.providers.find(provider => new Set(provider.models.map(model => model.protocol.id)).size > 1);
  assert.ok(mixed, 'catalog includes providers with more than one model protocol');
  assert.equal(getBuiltinCatalogModel('openai', upstream.getModels('openai')[0]!.id).protocol.id, upstream.getModels('openai')[0]!.api);
  assert.throws(() => listBuiltinCatalog('unknown'), /Unknown/);
  assert.throws(() => getBuiltinCatalogModel('openai', 'missing'), /Unknown/);
  assert.equal(actual.providers.find(provider => provider.id === 'openai-codex')!.apiKeySupport.supported, false);
  assert.match(actual.providers.find(provider => provider.id === 'openai')!.apiKeySupport.explanation, /does not mean/);
});

test('custom configuration requires exact protocols, limits and explicit independent credential references', () => {
  assert.equal(parseModelConfiguration(config()).customConnections[0]!.baseUrl, 'https://custom.example/proxy/api');
  for (const patch of [
    { api: 'unknown' }, { baseUrl: 'https://user:secret@example.com' }, { baseUrl: 'https://example.com?key=secret' }, { baseUrl: 'https://example.com#fragment' },
    { baseUrl: 'file:///tmp/key' }, { modelsUrl: 'https://different.example/models' }, { apiKeyEnv: 'key\nvalue' }, { apiKey: 'secret' },
  ]) assert.throws(() => parseModelConfiguration({ ...config(), customConnections: [{ ...connection(), ...patch }] }));
  for (const patch of [{ contextWindow: 0 }, { maxTokens: 0 }, { maxTokens: 8193 }, { contextWindow: 1.5 }, { reasoning: undefined }, { input: [] }, { input: ['audio'] }, { id: 'invalid\nmodel' }]) {
    assert.throws(() => parseModelConfiguration({ ...config(), customConnections: [{ ...connection(), models: [{ ...connection().models[0], ...patch }] }] }));
  }
  assert.throws(() => parseModelConfiguration({ ...config(), customConnections: [connection(), connection()] }), /unique/);
  assert.throws(() => parseModelConfiguration({ ...config(), customConnections: [{ ...connection(), models: [connection().models[0], connection().models[0]] }] }), /Duplicate/);
  assert.equal(parseModelConfiguration({ customConnections: [{ ...connection(), models: [] }] }).customConnections[0]!.models.length, 0);
});

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
  test(`custom ${api} uses its actual Pi adapter, path, own key and bounded output limit`, async () => {
    let reads = 0; let requests = 0;
    const transport = createModelTransport(config(api), { kind: 'custom', connection: 'openai', model: 'manual-id' }, {
      env: name => { assert.equal(name, 'EXPLICIT_CUSTOM_KEY'); reads++; return syntheticKey; },
      fetch: async (url, init) => {
        requests++; const requestUrl = new URL(String(url));
        assert.equal(requestUrl.origin + requestUrl.pathname, `https://custom.example/proxy/api/${api === 'anthropic-messages' ? 'v1/messages' : api === 'openai-responses' ? 'responses' : 'chat/completions'}`);
        assert.equal(init?.redirect, 'error');
        const headers = new Headers(init?.headers);
        assert.equal(headers.get(api === 'anthropic-messages' ? 'x-api-key' : 'authorization'), api === 'anthropic-messages' ? syntheticKey : `Bearer ${syntheticKey}`);
        assert.equal(headers.get('x-unwanted-secret'), null);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        assert.equal(body['model'], 'manual-id');
        return api === 'openai-responses' ? responseEvents() : api === 'anthropic-messages' ? anthropicEvents() : completions();
      },
    });
    assert.equal(reads, 0); assert.equal(requests, 0); assert.equal(transport.model.provider, 'custom:openai'); assert.equal(transport.description.pricing, 'unknown');
    assert.equal(JSON.stringify(transport.model).includes(syntheticKey), false);
    const stream = await transport.streamFn(transport.model, transcript, { headers: { 'x-unwanted-secret': 'do-not-send' }, apiKey: 'wrong-key', maxTokens: 100 });
    const message = await stream.result();
    assert.equal(message.stopReason, 'stop', message.errorMessage); assert.equal(reads, 1); assert.equal(requests, 1);
    assert.throws(() => transport.streamFn(transport.model, transcript, { maxTokens: 1025 }), /limit/);
  });
}

test('custom transport rejects missing keys and cannot inherit built-in key variables, mutate destination, or follow redirects', async () => {
  let calls = 0; const read: string[] = [];
  const missing = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: name => { read.push(name); return name === 'OPENAI_API_KEY' ? 'ambient' : undefined; }, fetch: async () => { calls++; return completions(); } });
  assert.equal((await (await missing.streamFn(missing.model, transcript)).result()).stopReason, 'error');
  assert.deepEqual(read, ['EXPLICIT_CUSTOM_KEY']); assert.equal(calls, 0);
  const guarded = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch: async (url, init) => {
    assert.match(String(url), /^https:\/\/custom\.example\//); assert.equal(init?.redirect, 'error'); calls++;
    return new Response('secret-in-error-body', { status: 302, headers: { location: 'https://other.example/steal' } });
  } });
  guarded.model.baseUrl = 'https://other.example'; guarded.model.headers = { 'x-unwanted-secret': 'secret' };
  const message = await (await guarded.streamFn(guarded.model, transcript)).result();
  assert.equal(message.stopReason, 'error'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(message), /secret-in-error-body|synthetic-custom-key/);
  assert.throws(() => guarded.streamFn({ ...guarded.model, provider: 'openai' }, transcript), /different model/);
});

test('builtin transport uses the bundled implementation and explicit provider credential only', async () => {
  const catalog = builtinModels(); const model = catalog.getModels('openai')[0]!;
  const selected = createModelTransport({ builtinCredentials: { openai: { apiKeyEnv: 'CHOSEN_OPENAI_KEY' } }, customConnections: [] }, { kind: 'builtin', provider: 'openai', model: model.id }, {
    env: name => { assert.equal(name, 'CHOSEN_OPENAI_KEY'); return 'sk-synthetic-builtin-key'; },
    fetch: async (url, init) => { assert.equal(new URL(String(url)).origin, new URL(model.baseUrl).origin); assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer sk-synthetic-builtin-key'); const body = JSON.parse(String(init?.body)); assert.equal(body.max_output_tokens, 100); assert.equal(body.temperature, 0.3); return responseEvents(); },
  });
  assert.equal((await (await selected.streamFn(selected.model, transcript, { maxTokens: 100, temperature: 0.3 })).result()).stopReason, 'stop');
  assert.equal(selected.description.pricing, 'catalog-estimate');
  assert.throws(() => createModelTransport({ builtinCredentials: {}, customConnections: [] }, { kind: 'builtin', provider: 'openai', model: model.id }), /explicit API-key/);
  assert.throws(() => createModelTransport({ builtinCredentials: {}, customConnections: [] }, { kind: 'builtin', provider: 'openai-codex', model: catalog.getModels('openai-codex')[0]!.id }), /not supported/);
});

test('provider error bodies and injected transport failures do not expose credentials', async () => {
  for (const fetch of [async () => new Response(JSON.stringify({ error: { message: `bad ${syntheticKey}` } }), { status: 401, headers: { 'content-type': 'application/json' } }), async () => { throw Error(`network ${syntheticKey}`); }]) {
    const transport = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch });
    const message = await (await transport.streamFn(transport.model, transcript)).result();
    assert.equal(message.stopReason, 'error'); assert.doesNotMatch(JSON.stringify(message), /synthetic-custom-key/);
  }
});

test('real adapter composition retains full Mira prompt, same-round tool intent, and recovery context offline', async () => {
  const writer = new MemoryWriter(); let calls = 0; let effects = 0; const requests: string[] = [];
  const transport = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch: async (_url, init) => {
    calls++; requests.push(String(init?.body)); return completions('After tool', calls === 1);
  } });
  const tool = effectTool(async () => { effects++; assert.equal(writer.state.executions.length, 1); return result; });
  const runtime = new PiDurableRuntime({ writer, model: transport.model, streamFn: transport.streamFn, tools: [tool], miraPrompt: { environmentContext: 'Synthetic transport test', authorizationContext: 'User requested a synthetic effect' } });
  await runtime.run(input('Perform the synthetic effect'));
  assert.equal(calls, 2); assert.equal(effects, 1); assert.ok(writer.state.executions[0]!.outcome);
  assert.match(requests[0]!, /Mira/); assert.match(requests[0]!, /Synthetic transport test/);
  assert.match(requests[1]!, /synthetic effect done/);
  assert.doesNotMatch(JSON.stringify(writer.state), /synthetic-custom-key|Bearer/);
  const restored = new PiDurableRuntime({ writer, model: transport.model, streamFn: transport.streamFn, tools: [tool], miraPrompt: { environmentContext: 'Synthetic transport test', authorizationContext: 'User requested a synthetic effect' } });
  await restored.run(input('Continue'));
  assert.equal(calls, 3); assert.equal(effects, 1); assert.match(requests[2]!, /Perform the synthetic effect/);
  await restored.compact({ keepRecentTokens: 1, reserveTokens: 512 });
  assert.ok(calls > 3); const afterCompaction = calls;
  await restored.run(input('Continue after explicit compaction'));
  assert.equal(calls, afterCompaction + 1); assert.equal(effects, 1); assert.match(requests.at(-1)!, /Mira/);
  assert.doesNotMatch(JSON.stringify(writer.state), /synthetic-custom-key|Bearer/);
});

test('model CLI help, list and details run offline with JSON output', () => {
  for (const args of [['--help'], ['list', 'openai'], ['details', 'openai', builtinModels().getModels('openai')[0]!.id]]) {
    const result = spawnSync(process.execPath, ['apps/server/src/models-cli.mts', ...args], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    if (args[0] === '--help') assert.match(result.stdout, /No command invokes a generative model/); else assert.ok(JSON.parse(result.stdout));
  }
});


test('transport cancellation prevents credential resolution and HTTP before an already aborted request', async () => {
  let reads = 0; let calls = 0;
  const transport = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => { reads++; return syntheticKey; }, fetch: async () => { calls++; return completions(); } });
  const controller = new AbortController(); controller.abort();
  const message = await (await transport.streamFn(transport.model, transcript, { signal: controller.signal })).result();
  assert.equal(message.stopReason, 'aborted'); assert.equal(reads, 0); assert.equal(calls, 0);
});


for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
  test(`${api} discards all SDK ambient custom/account headers at the final HTTP boundary`, async () => {
    const overrides: Record<string, string> = {
      OPENAI_CUSTOM_HEADERS: 'Authorization: Bearer unrelated-secret\nX-Ambient-Secret: unrelated-secret\nAnthropic-Beta: unrelated-secret',
      ANTHROPIC_CUSTOM_HEADERS: 'Authorization: Bearer unrelated-secret\nX-Ambient-Secret: unrelated-secret\nAnthropic-Beta: unrelated-secret',
      OPENAI_ORG_ID: 'unrelated-org', OPENAI_PROJECT_ID: 'unrelated-project',
    };
    const before = Object.fromEntries(Object.keys(overrides).map(name => [name, process.env[name]]));
    Object.assign(process.env, overrides);
    try {
      let requests = 0;
      const transport = createModelTransport(config(api), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch: async (_url, init) => {
        requests++;
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('x-ambient-secret'), null); assert.equal(headers.get('openai-organization'), null); assert.equal(headers.get('openai-project'), null);
        assert.doesNotMatch(JSON.stringify([...headers]), /unrelated/);
        if (api === 'anthropic-messages') { assert.equal(headers.get('authorization'), null); assert.equal(headers.get('x-api-key'), syntheticKey); assert.equal(headers.get('anthropic-version'), '2023-06-01'); }
        else assert.equal(headers.get('authorization'), `Bearer ${syntheticKey}`);
        return api === 'anthropic-messages' ? anthropicEvents() : api === 'openai-responses' ? responseEvents() : completions();
      } });
      assert.equal((await (await transport.streamFn(transport.model, transcript)).result()).stopReason, 'stop');
      assert.equal(requests, 1);
    } finally { for (const name of Object.keys(overrides)) { if (before[name] === undefined) delete process.env[name]; else process.env[name] = before[name]; } }
  });
}

test('streaming errors sanitize every partial and final provider diagnostic before persistence', async () => {
  const transport = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch: async () => sse([
    { id: 'synthetic-response', choices: [{ index: 0, delta: { role: 'assistant', content: `partial ${syntheticKey}` }, finish_reason: syntheticKey }] }, '[DONE]',
  ]) });
  const stream = await transport.streamFn(transport.model, transcript);
  const events = []; for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.equal(message.stopReason, 'error'); assert.doesNotMatch(JSON.stringify(events), /synthetic-custom-key|rawStopReason|Unsupported stop reason/);
  assert.doesNotMatch(JSON.stringify(message), /synthetic-custom-key|rawStopReason/);
  assert.deepEqual(message.content, []);
});

test('final protocol payload cannot exceed configured or requested output caps', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    let calls = 0;
    const configuration = config(api); configuration.customConnections[0]!.models[0]!.maxTokens = 8;
    const transport = createModelTransport(configuration, { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch: async (_url, init) => {
      calls++; const body = JSON.parse(String(init?.body)) as Record<string, number>;
      for (const key of ['max_tokens', 'max_completion_tokens', 'max_output_tokens']) if (body[key] !== undefined) assert.ok(body[key]! <= 8);
      return api === 'anthropic-messages' ? anthropicEvents() : api === 'openai-responses' ? responseEvents() : completions();
    } });
    const message = await (await transport.streamFn(transport.model, transcript)).result();
    if (api === 'openai-responses') { assert.equal(calls, 0); assert.equal(message.stopReason, 'error'); }
    else { assert.equal(calls, 1); assert.equal(message.stopReason, 'stop'); }
  }
});

test('Google API-key setup rejects ambient cloud-mode flags without reading a key or dispatching', () => {
  const model = builtinModels().getModels('google')[0]!;
  for (const name of ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE']) {
    const previous = process.env[name]; process.env[name] = 'true';
    try { assert.throws(() => createModelTransport({ builtinCredentials: { google: { apiKeyEnv: 'EXPLICIT_GOOGLE' } }, customConnections: [] }, { kind: 'builtin', provider: 'google', model: model.id }, { env: () => { throw Error('Must not read key'); } }), /Unset GOOGLE_GENAI/); }
    finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; }
  }
});


test('complete-message transport never leaks a key split across upstream text deltas', async () => {
  const split = Math.floor(syntheticKey.length / 2);
  const transport = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch: async () => sse([
    { id: 'synthetic-response', choices: [{ index: 0, delta: { role: 'assistant', content: syntheticKey.slice(0, split) }, finish_reason: null }] },
    { id: 'synthetic-response', choices: [{ index: 0, delta: { content: syntheticKey.slice(split) }, finish_reason: null }] },
    { id: 'synthetic-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]',
  ]) });
  const stream = await transport.streamFn(transport.model, transcript); const events = [];
  for await (const event of stream) events.push(event);
  assert.deepEqual(events.map(event => event.type), ['error']);
  assert.doesNotMatch(JSON.stringify(events), /synthetic-custom-key/);
  assert.deepEqual((await stream.result()).content, []);
});

test('credential echoes in tool arguments fail without rewriting an executable tool message', async () => {
  const transport = createModelTransport(config(), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => syntheticKey, fetch: async () => sse([
    { id: 'synthetic-response', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'echo-call', type: 'function', function: { name: 'effect', arguments: JSON.stringify({ value: syntheticKey }) } }] }, finish_reason: null }] },
    { id: 'synthetic-response', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
  ]) });
  const message = await (await transport.streamFn(transport.model, transcript)).result();
  assert.equal(message.stopReason, 'error'); assert.deepEqual(message.content, []); assert.doesNotMatch(JSON.stringify(message), /synthetic-custom-key|echo-call/);
});

test('SDK raw logging modes are rejected before keys, requests or raw console output', () => {
  for (const [api, variable] of [['openai-completions', 'OPENAI_LOG'], ['openai-responses', 'OPENAI_LOG'], ['anthropic-messages', 'ANTHROPIC_LOG']] as const) {
    const previous = process.env[variable]; process.env[variable] = 'debug';
    try {
      assert.throws(() => createModelTransport(config(api), { kind: 'custom', connection: 'openai', model: 'manual-id' }, { env: () => { throw Error('Must not read a key'); }, fetch: async () => { assert.fail('Must not request'); } }), /SDK logging can expose credentials/);
    } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
  }
});


test('builtin OpenAI rejects the SDK ChatGPT credential path before an uncapped request', async () => {
  const model = builtinModels().getModels('openai')[0]!; let requests = 0;
  const transport = createModelTransport({ builtinCredentials: { openai: { apiKeyEnv: 'EXPLICIT_OPENAI' } }, customConnections: [] }, { kind: 'builtin', provider: 'openai', model: model.id }, {
    env: () => 'synthetic-non-api-key-token', fetch: async () => { requests++; return responseEvents(); },
  });
  const message = await (await transport.streamFn(transport.model, transcript, { maxTokens: 100, temperature: 0.3 })).result();
  assert.equal(requests, 0); assert.equal(message.stopReason, 'error'); assert.doesNotMatch(JSON.stringify(message), /synthetic-non-api-key-token/);
});
