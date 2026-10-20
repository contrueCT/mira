import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { createModelTransport, listBuiltinCatalog } from '@mira/server';
import type { ModelRequestFailure } from '../../apps/server/src/model-errors.ts';
import { boundedRetryAfter, defaultModelRetryPolicy, retryDelayMs, retryableTransportError, type ModelRetryStatus } from '../../apps/server/src/model-retry.ts';
import { MemoryWriter, effectTool, input, result, seed, assistant } from '../recovery/fixtures.mts';
import { fastRetryPolicy, retryTransport, retryResponse, retryFailure, brokenPartialResponse, syntheticRetryKey, retryConfiguration, retrySelection } from '../recovery/model-retry-fixtures.mts';
const context = normalizeContext({ messages: [{ role: 'user', content: 'Synthetic retry test', timestamp: 1 }] });

test('actual SDK retries only the buffered request and reports transient status without publishing failed attempts', async () => {
  let calls = 0; const bodies: string[] = []; const statuses: Array<ModelRetryStatus | null> = [];
  const failures: unknown[] = [];
  const transport = retryTransport(async (_url, init) => { calls++; bodies.push(String(init?.body)); return calls === 1 ? retryFailure(429) : retryResponse(); }, { onRetry: status => statuses.push(status), onFailure: failure => failures.push(failure) });
  const stream = await transport.streamFn(transport.model, context); const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(calls, 2); assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(events.map(event => event.type), ['done']); assert.equal((await stream.result()).stopReason, 'stop');
  assert.deepEqual(statuses, [null, { phase: 'waiting', attempt: 2, maxAttempts: 5, delayMs: 250, reason: 'rate-limit' }, { phase: 'requesting', attempt: 2, maxAttempts: 5, delayMs: 0, reason: 'rate-limit' }, null]);
  assert.deepEqual(failures, [null]);
});

test('transient HTTP exhaustion is bounded, preserves first and last sanitized reasons, and publishes one error', async () => {
  let calls = 0; const statuses: Array<ModelRetryStatus | null> = []; const failures: Array<ModelRequestFailure | null> = [];
  const transport = retryTransport(async () => retryFailure(++calls === 1 ? 503 : 502, `failure-${calls} ${syntheticRetryKey}`, `request-${calls}`), { onRetry: status => statuses.push(status), onFailure: failure => failures.push(failure) });
  const stream = await transport.streamFn(transport.model, context); const events = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.equal(calls, 5); assert.deepEqual(events.map(event => event.type), ['error']);
  assert.match(failures.at(-1)!.message, /after 5 attempts.*request-1.*failure-1.*request-5.*failure-5/);
  assert.match(message.errorMessage!, /request-5.*failure-5/); assert.doesNotMatch(message.errorMessage!, /failure-1/);
  assert.equal(failures.at(-1)!.terminalMessage, message.errorMessage);
  assert.doesNotMatch(message.errorMessage!, /synthetic-retry-key/); assert.ok(message.errorMessage!.length < 2_100);
  assert.equal(statuses.at(-1), null); assert.deepEqual(statuses.filter(status => status?.phase === 'waiting').map(status => status!.delayMs), [250, 500, 1_000, 2_000]);
});

test('authentication, validation, redirects, TLS, DNS and unknown errors are not guessed retryable', async () => {
  for (const status of [400, 401, 403, 404, 409, 422, 302]) {
    let calls = 0; const transport = retryTransport(async () => { calls++; return retryFailure(status); });
    assert.equal((await (await transport.streamFn(transport.model, context)).result()).stopReason, 'error'); assert.equal(calls, 1);
  }
  for (const code of ['CERT_HAS_EXPIRED', 'ENOTFOUND', undefined]) {
    let calls = 0; const transport = retryTransport(async () => { calls++; throw Object.assign(new Error('temporary server overload 503'), { code }); });
    assert.equal((await (await transport.streamFn(transport.model, context)).result()).stopReason, 'error'); assert.equal(calls, 1);
  }
  assert.equal(retryableTransportError(new TypeError('fetch failed')), undefined);
});

test('known network failure codes retry through the actual SDK while retry-after remains bounded', async () => {
  let calls = 0; const transport = retryTransport(async () => {
    if (++calls === 1) throw new TypeError('fetch failed', { cause: Object.assign(new Error('synthetic timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    return retryResponse();
  });
  assert.equal((await (await transport.streamFn(transport.model, context)).result()).stopReason, 'stop'); assert.equal(calls, 2);
  assert.equal(boundedRetryAfter('900'), 60_000); assert.equal(boundedRetryAfter('30'), 30_000); assert.equal(boundedRetryAfter('0.5'), 500);
  assert.equal(boundedRetryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 1_000), 2_000);
  assert.equal(boundedRetryAfter('garbage'), undefined); assert.equal(boundedRetryAfter('-1'), undefined);
});

test('partial SSE text and tool calls stay uncommitted; retry delivers one complete intent and effect', async () => {
  const writer = new MemoryWriter(); let calls = 0; let effects = 0;
  const transport = retryTransport(async () => ++calls === 1 ? brokenPartialResponse() : calls === 2 ? retryResponse('', 'complete-call') : retryResponse('After effect'));
  const runtime = new PiDurableRuntime({ writer, ...transport, autoCompaction: { enabled: false }, tools: [effectTool(async () => { effects++; return result; })] });
  await runtime.run(input());
  assert.equal(calls, 3); assert.equal(effects, 1); assert.equal(writer.state.executions.length, 1);
  assert.equal(writer.state.executions[0]!.intent.callId, 'complete-call');
  assert.doesNotMatch(JSON.stringify(writer.state), /UNCOMMITTED_PARTIAL|partial-call|connection reset/);
});

test('retry after an unknown tool outcome never repeats the tool and restart keeps the recovery evidence', async () => {
  const writer = new MemoryWriter(); let calls = 0; let effects = 0;
  const transport = retryTransport(async () => ++calls === 1 ? retryResponse('', 'unknown-call') : calls === 2 ? retryFailure(503) : retryResponse('Unknown effect acknowledged'));
  const tools = [effectTool(async () => { effects++; throw Error('Remote effect may have happened'); })];
  await new PiDurableRuntime({ writer, ...transport, tools }).run(input());
  assert.equal(calls, 3); assert.equal(effects, 1);
  assert.match(JSON.stringify(writer.state), /unknown/); assert.equal(writer.state.executions[0]!.outcome, null);
  await new PiDurableRuntime({ writer, ...transport, tools }).run(input('Continue after restart'));
  assert.equal(calls, 4); assert.equal(effects, 1);
});

test('assistant persistence failures are outside transport retries and effects never start', async () => {
  const writer = new MemoryWriter(); let calls = 0; let effects = 0;
  writer.beforeAppend = async record => { if (JSON.stringify(record.payload).includes('toolUse')) throw Error('assistant append failed'); };
  const transport = retryTransport(async () => { calls++; return retryResponse('', 'blocked-call'); });
  await assert.rejects(new PiDurableRuntime({ writer, ...transport, tools: [effectTool(async () => { effects++; return result; })] }).run(input()), /assistant append failed/);
  assert.equal(calls, 1); assert.equal(effects, 0);
});

test('cancel during backoff promptly settles without another HTTP call or stale retry/error state', async () => {
  const controller = new AbortController(); let calls = 0; const statuses: Array<ModelRetryStatus | null> = []; const failures: unknown[] = [];
  const transport = retryTransport(async () => { calls++; return retryFailure(503); }, {
    onRetry: status => { statuses.push(status); if (status?.phase === 'waiting') controller.abort(); }, onFailure: failure => failures.push(failure),
  });
  const start = Date.now(); const message = await (await transport.streamFn(transport.model, context, { signal: controller.signal })).result();
  assert.equal(message.stopReason, 'aborted'); assert.deepEqual(message.content, []); assert.equal(calls, 1);
  assert.ok(Date.now() - start < 1_000); assert.equal(statuses.at(-1), null); assert.deepEqual(failures, [null]);
});

test('late completed content after cancellation is withheld and does not retry', async () => {
  const controller = new AbortController(); let calls = 0;
  const transport = retryTransport(async () => { calls++; controller.abort(); return retryResponse('LATE_CONTENT'); });
  const message = await (await transport.streamFn(transport.model, context, { signal: controller.signal })).result();
  assert.equal(message.stopReason, 'aborted'); assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(message), /LATE_CONTENT/);
});

test('exhausted partial SSE never persists text or creates a tool intent', async () => {
  const writer = new MemoryWriter(); let calls = 0; let effects = 0;
  const transport = retryTransport(async () => { calls++; return brokenPartialResponse(); });
  await assert.rejects(new PiDurableRuntime({ writer, ...transport, tools: [effectTool(async () => { effects++; return result; })] }).run(input()), /connection reset/);
  assert.equal(calls, 5); assert.equal(effects, 0); assert.equal(writer.state.executions.length, 0);
  assert.doesNotMatch(JSON.stringify(writer.state), /UNCOMMITTED_PARTIAL|partial-call/);
});

test('retries freeze request content and output settings even if the original caller objects change', async () => {
  const requestContext = normalizeContext({ messages: [{ role: 'user', content: 'Original request', timestamp: 1 }] });
  const requestOptions = { maxTokens: 100, temperature: 0.2 }; const bodies: string[] = [];
  const transport = retryTransport(async (_url, init) => { bodies.push(String(init?.body)); return bodies.length === 1 ? retryFailure(503) : retryResponse(); }, {
    onRetry: status => { if (status?.phase === 'waiting') { requestContext.messages.push({ role: 'user', content: 'Changed later', timestamp: 2 }); requestOptions.maxTokens = 200; requestOptions.temperature = 0.8; } },
  });
  assert.equal((await (await transport.streamFn(transport.model, requestContext, requestOptions)).result()).stopReason, 'stop');
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.doesNotMatch(bodies[1]!, /Changed later/);
});


for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) test(`retry rechecks ${api} SDK logging before a fresh attempt`, async t => {
  const variable = api === 'anthropic-messages' ? 'ANTHROPIC_LOG' : 'OPENAI_LOG';
  const previous = process.env[variable]; delete process.env[variable];
  const logs: unknown[][] = []; let calls = 0;
  for (const method of ['log', 'debug', 'info', 'warn', 'error'] as const) t.mock.method(console, method, (...args: unknown[]) => { logs.push(args); });
  try {
    const configuration = { ...retryConfiguration, customConnections: retryConfiguration.customConnections.map(connection => ({ ...connection, api })) };
    const transport = createModelTransport(configuration, retrySelection, { env: () => syntheticRetryKey,
      fetch: async () => { calls++; const response = retryFailure(503); response.headers.set('x-debug-key', syntheticRetryKey); return response; },
      onRetry: status => { if (status?.phase === 'waiting') process.env[variable] = 'debug'; },
    });
    const message = await (await transport.streamFn(transport.model, context)).result();
    assert.equal(message.stopReason, 'error');
    assert.equal(calls, 1, 'a newly unsafe SDK environment must stop before another fetch');
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(syntheticRetryKey));
    assert.doesNotMatch(message.errorMessage ?? '', new RegExp(syntheticRetryKey));
  } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
});


for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
  for (const scope of ['custom', 'builtin']) for (const scenario of ['auth', 'lazy']) test(`${api} ${scope} closes the ${scenario} SDK logging window`, () => {
    const child = spawnSync(process.execPath, ['tests/recovery/model-sdk-guard-worker.mts', api, scenario, scope], { encoding: 'utf8', timeout: 15_000,
      env: { PATH: process.env['PATH'], HOME: '/tmp', NODE_OPTIONS: `--import=${path.resolve('tests/deny-model-network.mts')}` } });
    assert.equal(child.status, 0, child.stderr); assert.doesNotMatch(child.stdout + child.stderr, /sk-synthetic-sdk-guard-probe/);
    const line = child.stdout.split('\n').find(line => line.startsWith('GUARD_RESULT=')); assert.ok(line, child.stdout);
    const result = JSON.parse(line.slice('GUARD_RESULT='.length));
    assert.equal(result.reads, 2);
    assert.equal(result.calls, scenario === 'auth' ? 1 : 2);
    assert.equal(result.stopReason, scenario === 'auth' ? 'error' : 'stop');
    assert.equal(result.lazyLoads, 0, 'no lazy adapter load may remain after async auth');
  });
}

test('permanent HTTP errors veto transient error-body failures across the three real SDK adapters', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) for (const status of [400, 401, 403, 422]) {
    let calls = 0;
    const configuration = { ...retryConfiguration, customConnections: retryConfiguration.customConnections.map(connection => ({ ...connection, api })) };
    const transport = createModelTransport(configuration, retrySelection, { env: () => syntheticRetryKey, fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('Body reset'), { code: 'ECONNRESET' })); } }), { status });
    } });
    const message = await (await transport.streamFn(transport.model, context)).result();
    assert.equal(message.stopReason, 'error'); assert.equal(calls, 1, `${api} HTTP ${status}`);
    assert.match(message.errorMessage!, new RegExp(`HTTP ${status}`));
  }
});


test('a transient failure followed by overflow keeps final classification and retries only the summary request', async () => {
  const writer = new MemoryWriter(); await seed(writer, [input('Older question '.repeat(500)), assistant('Older answer '.repeat(500))]);
  let calls = 0, effects = 0, summaries = 0; const diagnosticMessages: string[] = [];
  const transport = retryTransport(async (_url, init) => {
    calls++;
    if (String(init?.body).includes('你负责压缩 Mira')) {
      summaries++;
      return summaries === 1 ? retryFailure(503, 'Summary temporarily unavailable') : retryResponse('Recovered concise summary');
    }
    if (calls === 1) return retryResponse('', 'before-overflow');
    if (calls === 2) return retryFailure(429, 'Rate limit exceeded');
    if (calls === 3) return retryFailure(400, 'Your input exceeds the context window of this model');
    return retryResponse('Completed after overflow recovery');
  }, { onFailure: failure => { if (failure) diagnosticMessages.push(failure.message); } });
  const state = await new PiDurableRuntime({ writer, ...transport, autoCompaction: { threshold: 1, keepRecentTokens: 1 }, tools: [effectTool(async () => { effects++; return result; })] }).run(input('Recover the current request'));
  assert.equal(calls, 6); assert.equal(effects, 1); assert.equal(summaries, 2);
  assert.equal(state.entries.filter(entry => entry.type === 'compaction').length, 1);
  assert.equal(state.snapshot.executions.length, 1);
  assert.ok(diagnosticMessages.some(message => /Rate limit exceeded/.test(message) && /context window/.test(message)));
});


test('retryable HTTP error-body resets retain the HTTP category while 2xx stream resets still recover', async () => {
  for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages'] as const) {
    let calls = 0; const statuses: Array<ModelRetryStatus | null> = [];
    const configuration = { ...retryConfiguration, customConnections: retryConfiguration.customConnections.map(connection => ({ ...connection, api })) };
    const transport = createModelTransport(configuration, retrySelection, { env: () => syntheticRetryKey, retryPolicy: fastRetryPolicy, onRetry: status => statuses.push(status), fetch: async () => {
      calls++;
      return new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error('Body reset'), { code: 'ECONNRESET' })); } }), { status: 503 });
    } });
    const message = await (await transport.streamFn(transport.model, context)).result();
    assert.equal(calls, 5); assert.match(message.errorMessage!, /HTTP 503/);
    assert.deepEqual(statuses.filter(status => status?.phase === 'waiting').map(status => status!.reason), ['server', 'server', 'server', 'server']);
  }
  let calls = 0; const transport = retryTransport(async () => ++calls === 1 ? brokenPartialResponse() : retryResponse());
  assert.equal((await (await transport.streamFn(transport.model, context)).result()).stopReason, 'stop'); assert.equal(calls, 2);
});

test('setup failures have one terminal diagnostic and no retry; setup failure after backoff retains separate first diagnostics', async () => {
  let calls = 0; const failures: Array<ModelRequestFailure | null> = [];
  const initial = retryTransport(async () => { calls++; return retryResponse(); }, { resolveApiKey: async () => { throw Error(syntheticRetryKey); }, onFailure: value => failures.push(value) });
  const first = await (await initial.streamFn(initial.model, context)).result();
  assert.equal(calls, 0); assert.equal(first.stopReason, 'error'); assert.equal(failures.at(-1)!.terminalMessage, first.errorMessage);
  assert.doesNotMatch(JSON.stringify(failures), new RegExp(syntheticRetryKey));
  const previous = process.env['OPENAI_LOG']; delete process.env['OPENAI_LOG'];
  try {
    const transport = retryTransport(async () => { calls++; return retryFailure(503, 'First request unavailable'); }, {
      onFailure: value => failures.push(value), onRetry: status => { if (status?.phase === 'waiting') process.env['OPENAI_LOG'] = 'debug'; },
    });
    const terminal = await (await transport.streamFn(transport.model, context)).result();
    assert.equal(calls, 1); assert.match(failures.at(-1)!.message, /after 2 attempts.*First request unavailable/);
    assert.equal(failures.at(-1)!.terminalMessage, terminal.errorMessage); assert.doesNotMatch(terminal.errorMessage!, /First request unavailable/);
  } finally { if (previous === undefined) delete process.env['OPENAI_LOG']; else process.env['OPENAI_LOG'] = previous; }
});

test('supported builtin catalogs retain model/protocol setup without resolving credentials or changing unrelated APIs', () => {
  let reads = 0; let checked = 0;
  for (const provider of listBuiltinCatalog().providers.filter(provider => provider.apiKeySupport.supported)) {
    const apis = new Set<string>();
    for (const model of provider.models) {
      if (apis.has(model.protocol.id)) continue; apis.add(model.protocol.id);
      const transport = createModelTransport({ builtinCredentials: { [provider.id]: { apiKeyEnv: 'SYNTHETIC_SETUP_KEY' } }, customConnections: [] }, { kind: 'builtin', provider: provider.id, model: model.id }, { env: () => { reads++; return syntheticRetryKey; } });
      assert.equal(transport.model.provider, provider.id); assert.equal(transport.model.api, model.protocol.id); assert.equal(transport.model.id, model.id);
      checked++;
    }
  }
  assert.ok(checked > 20); assert.equal(reads, 0);
});

test('Google cloud mode changed during async credential resolution is rejected before SDK construction', async () => {
  const model = listBuiltinCatalog('google').providers[0]!.models[0]!;
  for (const variable of ['GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GENAI_USE_ENTERPRISE']) {
    const previous = process.env[variable]; delete process.env[variable];
    try {
      const transport = createModelTransport({ builtinCredentials: { google: { apiKeyEnv: 'SYNTHETIC_GOOGLE_KEY' } }, customConnections: [] }, { kind: 'builtin', provider: 'google', model: model.id }, {
        resolveApiKey: async () => { process.env[variable] = 'true'; return syntheticRetryKey; },
      });
      const message = await (await transport.streamFn(transport.model, context)).result();
      assert.equal(message.stopReason, 'error'); assert.match(message.errorMessage!, /Unset GOOGLE_GENAI/);
      assert.doesNotMatch(JSON.stringify(message), new RegExp(syntheticRetryKey));
    } finally { if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous; }
  }
});

test('default retry policy: five attempts, exponential backoff with ±10% jitter, a 60s cap and Retry-After within it', () => {
  assert.equal(defaultModelRetryPolicy.maxAttempts, 5);
  const fixed = (random: number) => ({ ...defaultModelRetryPolicy, random: () => random });
  assert.deepEqual([1, 2, 3, 4].map(attempt => retryDelayMs(attempt, fixed(0.5))), [1_000, 2_000, 4_000, 8_000]);
  assert.equal(retryDelayMs(1, fixed(0)), 900); assert.equal(retryDelayMs(1, fixed(0.999_999)), 1_100);
  for (let attempt = 1; attempt <= 4; attempt++) for (let sample = 0; sample < 50; sample++) {
    const delay = retryDelayMs(attempt); const base = 1_000 * 2 ** (attempt - 1);
    assert.ok(delay >= base * 0.9 && delay <= base * 1.1, `${attempt}: ${delay}`);
  }
  assert.equal(retryDelayMs(10, fixed(0.5)), 60_000, 'backoff never exceeds one minute');
  assert.equal(retryDelayMs(1, fixed(0.5), 30_000), 30_000, 'Retry-After longer than backoff is honored');
  assert.equal(retryDelayMs(1, fixed(0.5), 600_000), 60_000, 'Retry-After is capped');
  assert.equal(retryDelayMs(3, fixed(0.5), 100), 4_000, 'a shorter Retry-After does not shorten backoff');
});

test('an idle response stream is aborted with a retryable timeout and the buffered request is retried once data stops', async () => {
  let calls = 0; const statuses: Array<ModelRetryStatus | null> = [];
  const transport = retryTransport(async () => {
    if (++calls > 1) return retryResponse('Recovered after idle stream');
    // Headers arrive, then one partial chunk, then silence.
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"id":"idle","choices":[{"index":0,"delta":{"role":"assistant","content":"PARTIAL_IDLE"},"finish_reason":null}]}\n\n')); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }, { streamIdleTimeoutMs: 200, onRetry: status => statuses.push(status) });
  const started = Date.now();
  const message = await (await transport.streamFn(transport.model, context)).result();
  assert.equal(message.stopReason, 'stop'); assert.equal(calls, 2); assert.ok(Date.now() - started < 5_000);
  assert.doesNotMatch(JSON.stringify(message), /PARTIAL_IDLE/);
  assert.equal(statuses.find(status => status?.phase === 'waiting')?.reason, 'timeout');
  const exhausted = retryTransport(async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } }), { streamIdleTimeoutMs: 50, retryPolicy: { ...fastRetryPolicy, maxAttempts: 2, initialDelayMs: 10 } });
  const failed = await (await exhausted.streamFn(exhausted.model, context)).result();
  assert.equal(failed.stopReason, 'error'); assert.match(failed.errorMessage!, /no data for 0 seconds|MIRA_STREAM_IDLE_TIMEOUT/);
});
