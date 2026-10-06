import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { discoverModels, modelDiscoveryLimits, type CustomConnection } from '@mira/server';

const env = { CUSTOM_KEY: 'synthetic-discovery-key' };
const connection = (overrides: Partial<CustomConnection> = {}): CustomConnection => ({
  id: 'custom', baseUrl: 'https://provider.example/prefix/v1', api: 'openai-completions',
  apiKeyEnv: 'CUSTOM_KEY', models: [], ...overrides,
});
const json = (payload: unknown): Response => Response.json(payload);
const neverFetch: typeof fetch = async () => { assert.fail('Invalid input must not send a request'); };
const listed = (payload: unknown, custom = connection()) => discoverModels(custom, { env, fetch: async () => json(payload) });

for (const [api, baseUrl, endpoint] of [
  ['openai-completions', 'https://provider.example', 'https://provider.example/models'],
  ['openai-responses', 'https://provider.example/api/v4/', 'https://provider.example/api/v4/models'],
  ['openai-completions', 'https://provider.example/api/coding/paas/v4', 'https://provider.example/api/coding/paas/v4/models'],
  ['openai-responses', 'https://provider.example/anthropic', 'https://provider.example/anthropic/models'],
  ['anthropic-messages', 'https://provider.example', 'https://provider.example/v1/models'],
  ['anthropic-messages', 'https://provider.example/api/anthropic/', 'https://provider.example/api/anthropic/v1/models'],
  ['anthropic-messages', 'https://provider.example/v1', 'https://provider.example/v1/v1/models'],
  ['openai-completions', 'http://localhost:11434/custom/v1', 'http://localhost:11434/custom/v1/models'],
] as const) {
  test(`discovery uses the exact ${api} API prefix at ${baseUrl}`, async () => {
    let calls = 0;
    const result = await discoverModels(connection({ api, baseUrl }), {
      env: { ...env, OPENAI_API_KEY: 'unused-openai', ANTHROPIC_API_KEY: 'unused-anthropic' },
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, endpoint);
        assert.equal(init?.method, 'GET');
        assert.equal(init?.redirect, 'error');
        assert.equal(init?.credentials, 'omit');
        assert.equal(init?.referrerPolicy, 'no-referrer');
        assert.equal(init?.cache, 'no-store');
        assert.ok(init?.signal instanceof AbortSignal);
        const headers = new Headers(init?.headers);
        assert.equal(headers.get('accept'), 'application/json');
        if (api === 'anthropic-messages') {
          assert.equal(headers.get('x-api-key'), env.CUSTOM_KEY);
          assert.equal(headers.get('anthropic-version'), '2023-06-01');
          assert.equal(headers.get('authorization'), null);
        } else {
          assert.equal(headers.get('authorization'), `Bearer ${env.CUSTOM_KEY}`);
          assert.equal(headers.get('x-api-key'), null);
          assert.equal(headers.get('anthropic-version'), null);
        }
        return json({ data: [], has_more: false });
      },
    });
    assert.equal(calls, 1);
    assert.deepEqual(result, { endpoint, models: [] });
  });
}

test('discovery accepts an explicit same-origin models URL without probing other paths', async () => {
  const modelsUrl = 'https://provider.example/explicit/catalog';
  let calls = 0;
  const result = await discoverModels(connection({ modelsUrl }), {
    env, fetch: async url => { calls++; assert.equal(url, modelsUrl); return json({ models: [] }); },
  });
  assert.deepEqual(result, { endpoint: modelsUrl, models: [] });
  assert.equal(calls, 1);
});

test('discovery validates complete custom connection input before looking up credentials or fetching', async () => {
  const invalid = [
    { api: 'openai' }, { apiKeyEnv: 'not a variable' }, { id: 'bad identifier' }, { models: null },
    { apiKey: 'must-not-inline-a-key' }, { baseUrl: 'https://user:secret@provider.example/v1' },
    { baseUrl: 'https://provider.example/v1?key=secret' }, { baseUrl: 'https://provider.example/v1#secret' },
    { baseUrl: 'file:///private/models' }, { baseUrl: 'not a url' },
    { modelsUrl: 'https://other.example/models' }, { modelsUrl: 'http://provider.example/models' },
    { modelsUrl: 'https://provider.example:444/models' }, { modelsUrl: 'https://user:secret@provider.example/models' },
    { modelsUrl: 'https://provider.example/models?key=secret' }, { modelsUrl: 'https://provider.example/models#secret' },
  ];
  for (const overrides of invalid) {
    await assert.rejects(discoverModels({ ...connection(), ...overrides } as CustomConnection, {
      env: new Proxy({}, { get() { assert.fail('Invalid configuration must not access credentials'); } }), fetch: neverFetch,
    }), /^Error: Invalid custom connection for model discovery$/u);
  }
});

test('discovery reads only its named, own environment key and never uses built-in credential fallback', async () => {
  const reads: PropertyKey[] = [];
  const specific = new Proxy({ CUSTOM_KEY: env.CUSTOM_KEY }, {
    get(target, property) { reads.push(property); return Reflect.get(target, property); },
  });
  await discoverModels(connection(), { env: specific, fetch: async () => json({ data: [] }) });
  assert.deepEqual(reads, ['CUSTOM_KEY']);
  const unrelated = { OPENAI_API_KEY: 'synthetic-openai', ANTHROPIC_API_KEY: 'synthetic-anthropic' };
  await assert.rejects(discoverModels(connection(), { env: unrelated, fetch: neverFetch }), /valid API key/u);
  await assert.rejects(discoverModels(connection(), { env: Object.create(env) as typeof env, fetch: neverFetch }), /valid API key/u);
});

test('missing and malformed API keys fail generically before network access', async () => {
  for (const key of [undefined, '', ' ', '\t', '\n', 'secret\r\nInjected: yes', ' secret', 'secret ', 'with space', '密钥', 'sk-ant-oat-synthetic-token', 'x'.repeat(16_385)]) {
    await assert.rejects(discoverModels(connection(), { env: { CUSTOM_KEY: key }, fetch: neverFetch }),
      /^Error: Model discovery requires a valid API key in the configured environment variable$/u);
  }
  const throwing = Object.defineProperty({}, 'CUSTOM_KEY', { get() { throw Error('secret credential failure'); } });
  await assert.rejects(discoverModels(connection(), { env: throwing, fetch: neverFetch }), /valid API key/u);
});

test('OpenAI data rows preserve IDs and optional names, deduplicate stably, and do not infer capabilities', async () => {
  const result = await listed({ data: [
    { id: 'model-z', name: 'First name', context_window: 42, max_tokens: 1000, reasoning: true, cost: 2 },
    { id: 'model-a' }, { id: 'model-z', name: 'Later name' },
  ] });
  assert.deepEqual(result.models, [{ id: 'model-z', name: 'First name' }, { id: 'model-a' }]);
});

test('data takes precedence over any models shape, including an empty data array', async () => {
  for (const models of [null, 42, 'bad shape', {}, [{ slug: 'ignored' }]]) {
    assert.deepEqual((await listed({ data: [{ id: 'primary' }], models })).models, [{ id: 'primary' }]);
    assert.deepEqual((await listed({ data: [], models })).models, []);
  }
});

test('compatible catalogs use slug then id only when data is absent', async () => {
  const result = await listed({ models: [
    { slug: 'slug-first', id: 'ignored', name: 'Readable' },
    { id: 'id-fallback' }, { slug: '', id: 'empty-slug-fallback' },
    { slug: 42, id: 'non-string-fallback' }, { slug: 'slug-first' },
  ] });
  assert.deepEqual(result.models, [
    { id: 'slug-first', name: 'Readable' }, { id: 'id-fallback' },
    { id: 'empty-slug-fallback' }, { id: 'non-string-fallback' },
  ]);
  assert.deepEqual((await listed({ models: [] })).models, []);
});

test('malformed response shapes, rows, IDs, and names fail without returning partial results', async () => {
  for (const payload of [
    null, [], 42, 'secret body', {}, { data: null, models: [{ id: 'fallback-must-not-run' }] },
    { data: {} }, { models: {} }, { data: [null] }, { data: ['model'] }, { data: [{}] },
    { data: [{ id: 42 }] }, { data: [{ id: '' }] }, { data: [{ id: ' whitespace ' }] },
    { data: [{ id: 'bad\nline' }] }, { data: [{ id: 'x'.repeat(513) }] },
    { data: [{ id: 'valid' }, { id: 'invalid', name: null }] }, { models: [{ name: 'missing-id' }] },
  ]) {
    await assert.rejects(listed(payload), /^Error: Model discovery returned an invalid response$/u);
  }
});

test('Anthropic paginates after_id, maps display_name, and keeps auth and origin unchanged', async () => {
  const urls: string[] = [];
  const signals: AbortSignal[] = [];
  const cursor = 'id/with ?=& unicode☀';
  const endpoint = 'https://provider.example/anthropic/v1/models';
  const result = await discoverModels(connection({ api: 'anthropic-messages', baseUrl: 'https://provider.example/anthropic' }), {
    env, fetch: async (url, init) => {
      urls.push(String(url));
      signals.push(init!.signal!);
      assert.equal(new Headers(init?.headers).get('x-api-key'), env.CUSTOM_KEY);
      return urls.length === 1
        ? json({ data: [{ id: 'z', display_name: 'Zed' }, { id: cursor }], has_more: true, last_id: cursor })
        : json({ data: [{ id: 'z', display_name: 'Duplicate' }, { id: 'a' }], has_more: false, last_id: 'a' });
    },
  });
  assert.deepEqual(result, { endpoint, models: [{ id: 'z', name: 'Zed' }, { id: cursor }, { id: 'a' }] });
  const next = new URL(endpoint); next.searchParams.set('after_id', cursor);
  assert.deepEqual(urls, [endpoint, next.href]);
  assert.equal(signals[0], signals[1]);
});

test('Anthropic rejects missing pagination metadata, invalid cursors, and cursor cycles', async () => {
  const custom = connection({ api: 'anthropic-messages' });
  for (const payload of [
    { data: [] }, { models: [], has_more: false }, { data: [], has_more: 'false' },
    { data: [], has_more: true, last_id: 'a' }, { data: [{ id: 'a' }], has_more: true },
    { data: [{ id: 'a' }], has_more: true, last_id: '' },
    { data: [{ id: 'a', display_name: null }], has_more: false },
  ]) await assert.rejects(listed(payload, custom), /invalid (response|pagination)/u);
  let calls = 0;
  await assert.rejects(discoverModels(custom, { env, fetch: async () => {
    calls++;
    const cursor = calls % 2 ? 'a' : 'b';
    return json({ data: [{ id: cursor }], has_more: true, last_id: cursor });
  } }), /invalid pagination/u);
  assert.equal(calls, 3);
});

test('Anthropic pagination uses a validated snapshot despite caller mutation during discovery', async () => {
  const custom = connection({ api: 'anthropic-messages' });
  let calls = 0;
  await discoverModels(custom, { env, fetch: async (url, init) => {
    calls++;
    assert.ok(String(url).startsWith('https://provider.example/prefix/v1/v1/models'));
    assert.equal(new Headers(init?.headers).get('x-api-key'), env.CUSTOM_KEY);
    custom.baseUrl = 'https://other.example'; custom.api = 'openai-responses'; custom.apiKeyEnv = 'OTHER_KEY';
    return json({ data: [{ id: String(calls) }], has_more: calls === 1, last_id: String(calls) });
  } });
  assert.equal(calls, 2);
});

test('HTTP failures cancel bodies, do not leak response text, and never probe fallback endpoints', async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 405, 429, 500]) {
    let cancelled = false;
    let calls = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(`secret ${env.CUSTOM_KEY}`)); },
      cancel() { cancelled = true; },
    });
    await assert.rejects(discoverModels(connection(), { env, fetch: async () => {
      calls++; return new Response(body, { status, headers: { location: 'https://other.example/models' } });
    } }), new RegExp(`^Error: Model discovery request failed \\(HTTP ${status}\\)$`, 'u'));
    assert.equal(cancelled, true);
    assert.equal(calls, 1);
  }
});

test('a followed redirect or mismatched final URL from an injected fetch is rejected and cancelled', async () => {
  for (const metadata of [{ redirected: true }, { url: 'https://other.example/models' }, { url: 'https://provider.example/other/models' }]) {
    let cancelled = false;
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } }));
    for (const [name, value] of Object.entries(metadata)) Object.defineProperty(response, name, { value });
    await assert.rejects(discoverModels(connection(), { env, fetch: async () => response }), /redirects are not allowed/u);
    assert.equal(cancelled, true);
  }
});

test('network, reader, JSON, and UTF-8 errors expose no raw error or body content', async () => {
  await assert.rejects(discoverModels(connection(), { env, fetch: async () => {
    throw Error(`transport included ${env.CUSTOM_KEY} https://private.example`);
  } }), /^Error: Model discovery request failed$/u);
  const errored = new ReadableStream<Uint8Array>({ pull(controller) { controller.error(Error(env.CUSTOM_KEY)); } });
  await assert.rejects(discoverModels(connection(), { env, fetch: async () => new Response(errored) }), /^Error: Model discovery request failed$/u);
  for (const body of ['{malformed secret JSON', new Uint8Array([0xff]), '']) {
    await assert.rejects(discoverModels(connection(), { env, fetch: async () => new Response(body) }), /^Error: Model discovery returned an invalid response$/u);
  }
});

test('advertised oversized bodies are cancelled before reading even if cancellation does not resolve', async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise(() => undefined); } });
  await assert.rejects(discoverModels(connection(), { env, fetch: async () => new Response(body, {
    headers: { 'content-length': String(modelDiscoveryLimits.maxResponseBytes + 1) },
  }) }), /byte limit/u);
  assert.equal(cancelled, true);
});

test('actual streamed bytes are bounded independently of content-length and oversized readers are cancelled', async () => {
  for (const advertised of [undefined, '1', 'invalid']) {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(modelDiscoveryLimits.maxResponseBytes + 1)); },
      cancel() { cancelled = true; },
    });
    const headers = advertised === undefined ? {} : { 'content-length': advertised };
    await assert.rejects(discoverModels(connection(), { env, fetch: async () => new Response(body, { headers }) }), /byte limit/u);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  }
});

test('response byte limit is cumulative across pages and counts encoded bytes', async () => {
  let calls = 0;
  await assert.rejects(discoverModels(connection({ api: 'anthropic-messages' }), { env, fetch: async () => {
    calls++;
    return json({ data: [{ id: String(calls) }], has_more: true, last_id: String(calls), unused: 'x'.repeat(1_100_000) });
  } }), /byte limit/u);
  assert.equal(calls, 2);
  await assert.rejects(listed({ data: [], unused: '☀'.repeat(Math.ceil(modelDiscoveryLimits.maxResponseBytes / 3)) }), /byte limit/u);
});

test('model row limit is bounded even for duplicate IDs, and an exact-limit complete list succeeds', async () => {
  const data = Array.from({ length: modelDiscoveryLimits.maxModels }, () => ({ id: 'same' }));
  assert.deepEqual((await listed({ data })).models, [{ id: 'same' }]);
  await assert.rejects(listed({ data: [...data, { id: 'same' }] }), /model limit/u);
  let calls = 0;
  await assert.rejects(discoverModels(connection({ api: 'anthropic-messages' }), { env, fetch: async () => {
    calls++;
    return json({ data, has_more: true, last_id: String(calls) });
  } }), /model limit/u);
  assert.equal(calls, 2);
});

test('page limit fails rather than returning partial results, but the last permitted complete page succeeds', async () => {
  for (const complete of [false, true]) {
    let calls = 0;
    const operation = discoverModels(connection({ api: 'anthropic-messages' }), { env, fetch: async () => {
      calls++;
      return json({ data: [{ id: String(calls) }], has_more: !complete || calls < modelDiscoveryLimits.maxPages, last_id: String(calls) });
    } });
    if (complete) assert.equal((await operation).models.length, modelDiscoveryLimits.maxPages);
    else await assert.rejects(operation, /page limit/u);
    assert.equal(calls, modelDiscoveryLimits.maxPages);
  }
});

test('pre-cancelled discovery does not fetch and does not expose the caller abort reason', async () => {
  const controller = new AbortController(); controller.abort(Error(env.CUSTOM_KEY));
  await assert.rejects(discoverModels(connection(), { env, fetch: neverFetch, signal: controller.signal }),
    /^Error: Model discovery was cancelled or timed out$/u);
});

test('external cancellation bounds an unresponsive fetch and cancels a late-arriving response', async () => {
  const controller = new AbortController();
  let resolve!: (response: Response) => void;
  let signal: AbortSignal | undefined;
  const pending = discoverModels(connection(), { env, signal: controller.signal, fetch: async (_url, init) => {
    signal = init!.signal!;
    return new Promise<Response>(done => { resolve = done; });
  } });
  const rejected = assert.rejects(pending, /cancelled or timed out/u);
  controller.abort(Error(env.CUSTOM_KEY));
  await rejected;
  assert.equal(signal?.aborted, true);
  let cancelled = false;
  resolve(new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } })));
  await setImmediate();
  assert.equal(cancelled, true);
});

test('external cancellation stops a stalled reader and releases its lock without awaiting cancellation', async () => {
  const controller = new AbortController();
  let cancelled = false;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const body = new ReadableStream<Uint8Array>({
    pull() { reading(); },
    cancel() { cancelled = true; return new Promise(() => undefined); },
  });
  const pending = discoverModels(connection(), { env, signal: controller.signal, fetch: async () => new Response(body) });
  const rejected = assert.rejects(pending, /cancelled or timed out/u);
  await started;
  await setImmediate();
  controller.abort();
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('one 15-second timeout covers all pages, including transports that ignore AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolveFirst!: (response: Response) => void;
  let calls = 0;
  const signals: AbortSignal[] = [];
  const pending = discoverModels(connection({ api: 'anthropic-messages' }), { env, fetch: async (_url, init) => {
    calls++;
    signals.push(init!.signal!);
    if (calls === 1) return new Promise<Response>(resolve => { resolveFirst = resolve; });
    return new Promise<Response>(() => undefined);
  } });
  const rejected = assert.rejects(pending, /cancelled or timed out/u);
  t.mock.timers.tick(modelDiscoveryLimits.timeoutMs - 1);
  resolveFirst(json({ data: [{ id: 'first' }], has_more: true, last_id: 'first' }));
  await setImmediate();
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0]!.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signals[0]!.aborted, true);
});

test('the global timeout also bounds an unresponsive response body', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const pending = discoverModels(connection(), { env, fetch: async () => new Response(body) });
  const rejected = assert.rejects(pending, /cancelled or timed out/u);
  await setImmediate();
  t.mock.timers.tick(modelDiscoveryLimits.timeoutMs);
  await rejected;
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
});

test('an endless immediately supplied empty stream cannot evade the deadline by starving timers', async t => {
  let time = 0;
  t.mock.method(performance, 'now', () => { time += 1000; return time; });
  let cancelled = false;
  let chunks = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) { chunks++; controller.enqueue(new Uint8Array(0)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(discoverModels(connection(), { env, fetch: async () => new Response(body) }), /cancelled or timed out/u);
  assert.equal(cancelled, true);
  assert.ok(chunks <= 16);
  assert.equal(body.locked, false);
});


test('discovery rejects credential echoes in model identities, display names and pagination cursors', async () => {
  for (const payload of [{ data: [{ id: env.CUSTOM_KEY }] }, { data: [{ id: 'valid', name: `model ${env.CUSTOM_KEY}` }] }, { models: [{ slug: env.CUSTOM_KEY }] }]) {
    await assert.rejects(listed(payload), error => error instanceof Error && /invalid response/u.test(error.message) && !error.message.includes(env.CUSTOM_KEY));
  }
  let calls = 0;
  await assert.rejects(discoverModels(connection({ api: 'anthropic-messages' }), { env, fetch: async () => { calls++; return json({ data: [{ id: 'valid' }], has_more: true, last_id: env.CUSTOM_KEY }); } }), /invalid response/u);
  assert.equal(calls, 1);
});

test('discovery rejects a resolved credential in endpoint paths without sending or echoing it', async () => {
  for (const baseUrl of [`https://provider.example/${env.CUSTOM_KEY}`, `https://provider.example/%73${env.CUSTOM_KEY.slice(1)}`]) {
    await assert.rejects(discoverModels(connection({ baseUrl }), { env, fetch: neverFetch }), error => error instanceof Error && /must not contain the API key/u.test(error.message) && !error.message.includes(env.CUSTOM_KEY));
  }
});
