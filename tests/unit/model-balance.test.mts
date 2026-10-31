import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContext } from '@earendil-works/pi-ai';
import { PI_USAGE_PROJECTION, encodeEntry, messageEntry } from '@mira/runtime-pi';
import { balanceErrorCodes, insufficientBalance, type ModelRequestFailure } from '../../apps/server/src/model-errors.ts';
import { validTimeZone } from '../../apps/server/src/usage-http.ts';
import { balanceNoticeText } from '../../apps/server/src/web-service.ts';
import { retryTransport, retryResponse, syntheticRetryKey } from '../recovery/model-retry-fixtures.mts';
import { assistant } from '../recovery/fixtures.mts';
const context = normalizeContext({ messages: [{ role: 'user', content: 'Synthetic balance test', timestamp: 1 }] });
const body = (status: number, error: Record<string, unknown>, requestId = 'balance-1') => new Response(JSON.stringify({ error }), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });

async function run(response: () => Response) {
  let calls = 0; const failures: Array<ModelRequestFailure | null> = [];
  const transport = retryTransport(async () => { calls++; return response(); }, { onFailure: failure => failures.push(failure) });
  const stream = await transport.streamFn(transport.model, context);
  for await (const _event of stream) { /* drain */ }
  return { calls, failure: failures.at(-1) ?? null, message: await stream.result() };
}

test('balance classification uses HTTP 402 or whitelisted structured codes only, never message text', () => {
  assert.ok(insufficientBalance(402));
  for (const code of balanceErrorCodes) { assert.ok(insufficientBalance(429, code)); assert.ok(insufficientBalance(400, undefined, code)); }
  assert.ok(!insufficientBalance(429)); assert.ok(!insufficientBalance(429, 'rate_limit_exceeded', 'requests'));
  assert.ok(!insufficientBalance(500, 'server_error')); assert.ok(!insufficientBalance(undefined));
  assert.ok(!insufficientBalance(400, 'Insufficient Balance'));
});

test('DeepSeek 402 is terminal after one request and carries a sanitized request ID', async () => {
  const { calls, failure, message } = await run(() => body(402, { message: `Insufficient Balance ${syntheticRetryKey}`, type: 'unknown_error', code: 'invalid_request_error' }));
  assert.equal(calls, 1); assert.equal(message.stopReason, 'error');
  assert.equal(failure?.balance, true); assert.equal(failure?.httpStatus, 402); assert.equal(failure?.requestId, 'balance-1');
  assert.doesNotMatch(failure!.message, /synthetic-retry-key/);
});

test('OpenAI 429 insufficient_quota is no longer retried; an ordinary 429 still is', async () => {
  const quota = await run(() => body(429, { message: 'You exceeded your current quota', type: 'insufficient_quota', code: 'insufficient_quota' }));
  assert.equal(quota.calls, 1); assert.equal(quota.failure?.balance, true); assert.equal(quota.failure?.httpStatus, 429);
  let calls = 0;
  const transport = retryTransport(async () => ++calls === 1 ? body(429, { message: 'slow down', code: 'rate_limit_exceeded' }) : retryResponse('ok'));
  const stream = await transport.streamFn(transport.model, context); for await (const _event of stream) { /* drain */ }
  assert.equal((await stream.result()).stopReason, 'stop'); assert.equal(calls, 2);
});

test('a 400 whose message mentions balance is not classified', async () => {
  const { calls, failure } = await run(() => body(400, { message: 'insufficient balance in parameter', code: 'invalid_request_error' }));
  assert.equal(calls, 1); assert.equal(failure?.balance, false);
});

test('balance notice wording: all actions stopped, one message resumes, no internal tool state', () => {
  for (const provider of ['deepseek', 'custom-proxy', null]) {
    const text = balanceNoticeText(provider);
    assert.match(text, /所有动作都已停下/); assert.match(text, /发一条消息/);
    assert.doesNotMatch(text, /工具|结果未知|子任务|后台|超时/);
  }
  assert.match(balanceNoticeText('deepseek'), /^DeepSeek 因/u); assert.match(balanceNoticeText(null), /^模型服务商因/u);
});

test('Pi usage projection paths match encoded Pi records', () => {
  const record = encodeEntry(messageEntry(assistant('x'), null));
  const at = (path: string[]) => path.reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], record);
  assert.equal(record.kind, PI_USAGE_PROJECTION.message.kind);
  assert.equal(at(PI_USAGE_PROJECTION.message.role), PI_USAGE_PROJECTION.message.roleValue);
  assert.deepEqual(Object.keys(at(PI_USAGE_PROJECTION.message.usage) as object).filter(key => Object.values(PI_USAGE_PROJECTION.fields).includes(key)).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
  assert.equal(at(PI_USAGE_PROJECTION.message.provider), 'offline'); assert.equal(at(PI_USAGE_PROJECTION.message.stopReason), 'stop');
  assert.ok(Object.isFrozen(PI_USAGE_PROJECTION));
});

test('usage time zones are validated by Intl', () => {
  for (const zone of ['UTC', 'Asia/Shanghai', 'America/Los_Angeles', 'Etc/GMT+8']) assert.ok(validTimeZone(zone), zone);
  for (const zone of ['', 'Not/A_Zone', "UTC'; DROP", '../etc', 'a'.repeat(80)]) assert.ok(!validTimeZone(zone), zone);
});
