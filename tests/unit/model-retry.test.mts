import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { boundedRetryAfter, retryableTransportError, type ModelRetryStatus } from '../../apps/server/src/model-retry.ts';
import { MemoryWriter, effectTool, input, result } from '../recovery/fixtures.mts';
import { retryTransport, retryResponse, retryFailure, brokenPartialResponse, syntheticRetryKey } from '../recovery/model-retry-fixtures.mts';
const context = normalizeContext({ messages: [{ role: 'user', content: 'Synthetic retry test', timestamp: 1 }] });

test('actual SDK retries only the buffered request and reports transient status without publishing failed attempts', async () => {
  let calls = 0; const bodies: string[] = []; const statuses: Array<ModelRetryStatus | null> = [];
  const failures: unknown[] = [];
  const transport = retryTransport(async (_url, init) => { calls++; bodies.push(String(init?.body)); return calls === 1 ? retryFailure(429) : retryResponse(); }, { onRetry: status => statuses.push(status), onFailure: failure => failures.push(failure) });
  const stream = await transport.streamFn(transport.model, context); const events = [];
  for await (const event of stream) events.push(event);
  assert.equal(calls, 2); assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(events.map(event => event.type), ['done']); assert.equal((await stream.result()).stopReason, 'stop');
  assert.deepEqual(statuses, [null, { phase: 'waiting', attempt: 2, maxAttempts: 3, delayMs: 250, reason: 'rate-limit' }, { phase: 'requesting', attempt: 2, maxAttempts: 3, delayMs: 0, reason: 'rate-limit' }, null]);
  assert.deepEqual(failures, [null]);
});

test('transient HTTP exhaustion is bounded, preserves first and last sanitized reasons, and publishes one error', async () => {
  let calls = 0; const statuses: Array<ModelRetryStatus | null> = [];
  const transport = retryTransport(async () => retryFailure(++calls === 1 ? 503 : 502, `failure-${calls} ${syntheticRetryKey}`, `request-${calls}`), { onRetry: status => statuses.push(status) });
  const stream = await transport.streamFn(transport.model, context); const events = [];
  for await (const event of stream) events.push(event);
  const message = await stream.result();
  assert.equal(calls, 3); assert.deepEqual(events.map(event => event.type), ['error']);
  assert.match(message.errorMessage!, /after 3 attempts.*request-1.*failure-1.*request-3.*failure-3/);
  assert.doesNotMatch(message.errorMessage!, /synthetic-retry-key/); assert.ok(message.errorMessage!.length < 2_100);
  assert.equal(statuses.at(-1), null); assert.deepEqual(statuses.filter(status => status?.phase === 'waiting').map(status => status!.delayMs), [250, 1_000]);
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
  assert.equal(boundedRetryAfter('900'), 10_000); assert.equal(boundedRetryAfter('0.5'), 500);
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
  await assert.rejects(new PiDurableRuntime({ writer, ...transport, tools: [effectTool(async () => { effects++; return result; })] }).run(input()), /after 3 attempts/);
  assert.equal(calls, 3); assert.equal(effects, 0); assert.equal(writer.state.executions.length, 0);
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
