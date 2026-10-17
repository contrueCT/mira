import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSettingsStore } from '@mira/server';
import { normalizeContext } from '@earendil-works/pi-ai';

const key = 'synthetic-probe-private-key';
const completion = () => new Response('data: {"id":"probe","choices":[{"index":0,"delta":{"role":"assistant","content":"OK"},"finish_reason":null}]}\n\ndata: {"id":"probe","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const rejected = (status: number, message: string) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json' } });
async function fixture(t: test.TestContext) {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-probe-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, 'source'));
  const store = new WebSettingsStore(path.join(directory, 'private', 'models.json'), path.join(directory, 'source'));
  const saved = await store.save({ ...await store.get(), selection: { kind: 'custom', connection: 'fixture', model: 'gpt-6-luna' }, configuration: { defaultThinkingLevel: 'high', builtinCredentials: {}, customConnections: [{ id: 'fixture', api: 'openai-completions', baseUrl: 'https://synthetic.example/v1', apiKey: key, models: [{ id: 'gpt-6-luna', contextWindow: 32000, maxTokens: 4096, reasoning: true, input: ['text'] }] }] } });
  return { store, saved };
}

test('probe switches only after explicit rejection, preserves effort, redacts and saves the accepted format', async t => {
  const { store, saved } = await fixture(t);
  const bodies: Record<string, unknown>[] = [];
  const result = await store.probe(saved, { fetch: async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${key}`);
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? rejected(400, `litellm.UnsupportedParamsError: openai does not support parameters: ['reasoning_effort']; ${key}`) : completion();
  } });
  assert.equal(result.status, 'supported'); if (result.status !== 'supported') return;
  assert.equal(result.format, 'openrouter');
  assert.equal(bodies[0]!['reasoning_effort'], 'high');
  assert.deepEqual(bodies[1]!['reasoning'], { effort: 'high' });
  assert.equal(bodies[1]!['reasoning_effort'], undefined);
  assert.equal(bodies[0]!['max_completion_tokens'], 1024);
  assert.equal(bodies[0]!['tools'], undefined);
  assert.ok(!JSON.stringify(result).includes(key));
  assert.deepEqual(await store.get(), saved, 'probing alone never saves');
  saved.configuration.customConnections[0]!.models[0]!.reasoningFormat = result.format;
  await store.save(saved);
  const restarted = new WebSettingsStore(store.file, store.sourceDirectory);
  const transport = restarted.transport(await restarted.get(), { fetch: async (_url, init) => { assert.deepEqual(JSON.parse(String(init?.body)).reasoning, { effort: 'high' }); return completion(); } });
  const stream = await transport.streamFn(transport.model, normalizeContext({ messages: [{ role: 'user', content: 'Fixture', timestamp: 0 }] }), { ...(transport.thinkingLevel === 'off' ? {} : { reasoning: transport.thinkingLevel }) });
  assert.equal((await stream.result()).stopReason, 'stop');
});

for (const [status, message] of [[401, 'invalid key'], [429, 'rate limited'], [503, 'temporarily unavailable'], [400, 'invalid model'], [400, 'Invalid value for reasoning_effort: high'], [400, "Value 'high' for parameter 'reasoning_effort' is not supported"], [400, 'Unsupported parameter: temperature'], [400, 'Unknown parameter: stream_options (accepted parameters: reasoning_effort)']] as const) {
  test(`probe does not retry or switch on ${status} ${message}`, async t => {
    const { store, saved } = await fixture(t); let calls = 0;
    const result = await store.probe(saved, { fetch: async () => { calls++; return rejected(status, message); } });
    assert.equal(result.status, 'failed'); assert.equal(calls, 1);
    assert.deepEqual(await store.get(), saved);
  });
}

test('all unsupported formats report both errors without saving or stripping parameters', async t => {
  const { store, saved } = await fixture(t); let calls = 0;
  const result = await store.probe(saved, { fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); calls++;
    assert.ok(body.reasoning_effort || body.reasoning);
    return rejected(400, `Unknown parameter: ${calls === 1 ? 'reasoning_effort' : 'reasoning'}`);
  } });
  assert.equal(result.status, 'failed'); assert.equal(calls, 2); assert.equal(result.attempts.length, 2);
  assert.deepEqual(await store.get(), saved);
});

test('off preference still probes a real effort field and preserves preference', async t => {
  const { store, saved } = await fixture(t); saved.configuration.defaultThinkingLevel = 'off';
  await store.probe(saved, { fetch: async (_url, init) => { assert.equal(JSON.parse(String(init?.body)).reasoning_effort, 'low'); return completion(); } });
  assert.equal(saved.configuration.defaultThinkingLevel, 'off');
});

test('probe rejects stale revisions and refuses saved credentials at a changed endpoint', async t => {
  const { store, saved } = await fixture(t); let calls = 0;
  const fetch = async () => { calls++; return completion(); };
  const changed = structuredClone(saved); changed.configuration.customConnections[0]!.baseUrl = 'https://different.example/v1';
  await assert.rejects(store.probe(changed, { fetch }));
  await store.save(saved);
  await assert.rejects(store.probe(saved, { fetch }), /Settings changed/);
  assert.equal(calls, 0);
});

test('cancellation prevents fallback and leaves saved settings intact', async t => {
  const { store, saved } = await fixture(t); const controller = new AbortController(); let calls = 0;
  await assert.rejects(store.probe(saved, { signal: controller.signal, fetch: async () => { calls++; controller.abort(); throw controller.signal.reason; } }));
  assert.equal(calls, 1); assert.deepEqual(await store.get(), saved);
});


test('a request ID cannot trigger a format switch', async t => {
  const { store, saved } = await fixture(t); let calls = 0;
  const result = await store.probe(saved, { fetch: async () => { calls++; return new Response(JSON.stringify({ error: { message: 'Invalid model' } }), { status: 400, headers: { 'content-type': 'application/json', 'x-request-id': 'Unknown parameter: reasoning_effort' } }); } });
  assert.equal(calls, 1); assert.equal(result.status, 'failed');
});


test('field-first parameter rejection switches format, network errors stop immediately', async t => {
  const { store, saved } = await fixture(t); let calls = 0;
  const result = await store.probe(saved, { fetch: async () => ++calls === 1 ? rejected(400, "Parameter 'reasoning_effort' is not supported by this model") : completion() });
  assert.equal(result.status, 'supported'); assert.equal(calls, 2);
  calls = 0;
  const failed = await store.probe(saved, { fetch: async () => { calls++; throw Object.assign(new Error('Synthetic timeout'), { code: 'ETIMEDOUT' }); } });
  assert.equal(failed.status, 'failed'); assert.equal(calls, 1);
});
