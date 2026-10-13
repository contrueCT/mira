import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMiraClient, MiraClientError, MAX_EXTERNAL_RESPONSE_BYTES,
  type MiraClientOptions, type MiraCredentials, type MiraClientErrorCode, type MiraClientErrorOutcome,
  type ExternalEvent, type ExternalNotification, type ExternalReceipt, type ExternalWake,
} from '../../packages/external-sdk/src/index.ts';

const baseUrl = 'http://127.0.0.1:43127';
const token = 'A'.repeat(43);
const credentials = (): MiraCredentials => ({ senderId: 'synthetic-worker', token });
const event = (): ExternalEvent => ({ id: 'event-1', type: 'worker.finished', occurredAt: '2026-10-13T00:00:00.000Z', payload: { text: 'Synthetic event' } });
const wake = (): ExternalWake => ({ id: 'wake-1', reason: 'Synthetic attention request', event: event() });
const notification = (): ExternalNotification => ({ id: 'notification-1', occurredAt: '2026-10-13T00:00:00.000Z', text: 'Synthetic notification' });
function receipt(operation: ExternalReceipt['operation'] = 'event', status: 'inserted' | 'duplicate' = 'inserted'): ExternalReceipt {
  return operation === 'wake'
    ? { operation, id: 'wake-1', eventId: 'event-1', receipt: status, durability: 'persisted' }
    : { operation, id: `${operation}-1`, receipt: status, durability: 'persisted' };
}
const response = (operation: ExternalReceipt['operation'] = 'event', status: 'inserted' | 'duplicate' = 'inserted'): Response => Response.json(receipt(operation, status), { status: status === 'inserted' ? 201 : 200 });
const client = (fetch: typeof globalThis.fetch, extra: Partial<MiraClientOptions> = {}) => createMiraClient({ baseUrl, credentials, fetch, ...extra });
function expectedError(code: MiraClientErrorCode, outcome: MiraClientErrorOutcome, status?: number): (error: unknown) => boolean {
  return (error) => {
    assert(error instanceof MiraClientError);
    assert.equal(error.name, 'MiraClientError'); assert.equal(error.code, code); assert.equal(error.outcome, outcome); assert.equal(error.status, status);
    assert.equal(error.cause, undefined);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'name', 'outcome', 'status']);
    assert(!`${error.message} ${JSON.stringify(error)} ${error.stack}`.includes('SECRET'));
    assert(!JSON.stringify(error).includes(token));
    return true;
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// These are synthetic injected transports; real loopback HTTP is covered by the server suite.
test('external client sends the exact three POST routes and security headers with strict receipts', async () => {
  for (const trailing of ['', '/']) {
    const requests: { url: unknown; init: RequestInit | undefined }[] = [];
    const sdk = client(async (url, init) => {
      requests.push({ url, init });
      return response(requests.length === 1 ? 'event' : requests.length === 2 ? 'wake' : 'notification');
    }, { baseUrl: `${baseUrl}${trailing}` });
    assert.deepEqual(await sdk.emitEvent(event()), receipt());
    assert.deepEqual(await sdk.requestWake(wake()), receipt('wake'));
    assert.deepEqual(await sdk.sendNotification(notification()), receipt('notification'));
    assert.deepEqual(requests.map(value => value.url), ['/events', '/wake', '/notifications'].map(path => `${baseUrl}/api/external${path}`));
    for (const [index, request] of requests.entries()) {
      const init = request.init!;
      assert.equal(init.method, 'POST'); assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit');
      assert.equal(init.cache, 'no-store'); assert.equal(init.referrerPolicy, 'no-referrer'); assert(init.signal instanceof AbortSignal);
      assert.deepEqual(Object.fromEntries(new Headers(init.headers)), {
        authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-mira-client': 'external', 'x-mira-sender': 'synthetic-worker',
      });
      assert.deepEqual(JSON.parse(init.body as string), [event(), wake(), notification()][index]);
    }
  }
  assert.deepEqual(await client(async () => response('event', 'duplicate')).emitEvent(event()), receipt('event', 'duplicate'));
});

test('external client accepts only explicit fixed loopback origins and bounded timeout configuration', () => {
  for (const value of ['http://127.0.0.1:1024', 'http://127.0.0.1:3210', 'http://127.0.0.1:65535/']) {
    assert(createMiraClient({ baseUrl: value, credentials }));
  }
  for (const value of ['', 'http://127.0.0.1:1', 'http://127.0.0.1:80', 'http://127.0.0.1:1023', 'http://localhost:43127', 'http://[::1]:43127', 'https://127.0.0.1:43127', 'http://127.0.0.1',
    'http://127.0.0.1:0', 'http://127.0.0.1:65536', 'http://127.0.0.1:043127', 'http://127.0.0.1:43127//',
    `${baseUrl}/api`, `${baseUrl}/../`, `${baseUrl}?SECRET=x`, `${baseUrl}#SECRET`, 'http://SECRET@127.0.0.1:43127',
    'http://127.0.0.1:43127@evil.invalid', 'http://2130706433:43127', 'http://127.0.0.1.evil.invalid:43127', `${baseUrl}\n`]) {
    assert.throws(() => createMiraClient({ baseUrl: value, credentials }), expectedError('invalid_configuration', 'not_sent'));
  }
  for (const timeoutMs of [0, -1, 60001, 1.5, Infinity, NaN]) {
    assert.throws(() => createMiraClient({ baseUrl, credentials, timeoutMs }), expectedError('invalid_configuration', 'not_sent'));
  }
  for (const timeoutMs of [1, 60000]) assert(createMiraClient({ baseUrl, credentials, timeoutMs }));
  for (const options of [null, {}, { baseUrl, credentials: token }, { baseUrl, credentials, fetch: null }, { baseUrl, credentials, timeoutMs: null },
    { get baseUrl() { throw Error('SECRET config'); } }]) {
    assert.throws(() => createMiraClient(options as unknown as MiraClientOptions), expectedError('invalid_configuration', 'not_sent'));
  }
});

test('external client snapshots configuration once and reloads only explicit credentials on every request', async () => {
  let loads = 0;
  let urlReads = 0;
  const authorizations: string[] = [];
  const sdk = createMiraClient({
    get baseUrl() { urlReads++; return urlReads === 1 ? baseUrl : 'https://evil.invalid'; },
    credentials: async () => ({ senderId: `worker-${++loads}`, token: loads === 1 ? token : 'B'.repeat(43) }),
    fetch: async (url, init) => {
      assert.equal(url, `${baseUrl}/api/external/events`);
      const headers = new Headers(init?.headers);
      authorizations.push(headers.get('authorization')!);
      assert.equal(headers.get('x-mira-sender'), `worker-${loads}`);
      return response();
    },
  });
  assert.equal(loads, 0); // No credential access at module load or client creation.
  await sdk.emitEvent(event()); await sdk.emitEvent(event());
  assert.equal(urlReads, 1); assert.equal(loads, 2);
  assert.deepEqual(authorizations, [`Bearer ${token}`, `Bearer ${'B'.repeat(43)}`]);
});

test('external client snapshots finite JSON before credential loading and preserves prototype-like payload data', async () => {
  const loaded = deferred<MiraCredentials>();
  const input = event();
  input.payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":"data"},"nested":[{"text":"original"}]}');
  const expected = JSON.parse(JSON.stringify(input));
  let sent: unknown;
  const sdk = client(async (_url, init) => { sent = JSON.parse(init?.body as string); return response(); }, { credentials: () => loaded.promise });
  const pending = sdk.emitEvent(input);
  input.id = 'changed'; (input.payload as { nested: { text: string }[] }).nested[0]!.text = 'changed';
  loaded.resolve(credentials());
  await pending;
  assert.deepEqual(sent, expected); assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
  assert.equal(Object.hasOwn((sent as ExternalEvent).payload as object, '__proto__'), true);
  let calls = 0;
  const noFetch = client(async () => { calls++; return response(); });
  const cyclic: unknown[] = []; cyclic.push(cyclic);
  let getterReads = 0;
  for (const payload of [NaN, Infinity, undefined, 1n, cyclic, { nested: NaN }, new Date(),
    Object.defineProperty({}, 'value', { enumerable: true, get() { getterReads++; throw Error('SECRET getter'); } })]) {
    await assert.rejects(noFetch.emitEvent({ ...event(), payload } as ExternalEvent), expectedError('invalid_input', 'not_sent'));
  }
  await assert.rejects(noFetch.sendNotification({ ...notification(), text: ' ' }), expectedError('invalid_input', 'not_sent'));
  await assert.rejects(noFetch.requestWake({ ...wake(), reason: '' }), expectedError('invalid_input', 'not_sent'));
  assert.equal(calls, 0); assert.equal(getterReads, 0);
});

test('external client rejects unsafe credential snapshots and redacts all loader failures before dispatch', async () => {
  let calls = 0;
  let getterReads = 0;
  const inputValues = [null, {}, { ...credentials(), token: 'short' }, { ...credentials(), token: `${token}\n` },
    { ...credentials(), senderId: '../SECRET' }, { ...credentials(), extra: 'SECRET' }, Object.create(credentials()),
    Object.defineProperty(credentials(), 'token', { enumerable: true, get() { getterReads++; throw Error('SECRET getter'); } })];
  for (const value of inputValues) {
    const sdk = client(async () => { calls++; return response(); }, { credentials: () => value as MiraCredentials });
    await assert.rejects(sdk.emitEvent(event()), expectedError('credentials_unavailable', 'not_sent'));
  }
  for (const loader of [() => { throw Error(`SECRET ${token}`); }, async () => { throw { message: `SECRET ${token}` }; }]) {
    await assert.rejects(client(async () => { calls++; return response(); }, { credentials: loader }).emitEvent(event()), expectedError('credentials_unavailable', 'not_sent'));
  }
  assert.equal(calls, 0); assert.equal(getterReads, 0);
});

test('external cancellation before dispatch remains not_sent, including a pending credential loader', async () => {
  let calls = 0;
  let loads = 0;
  const controller = new AbortController(); controller.abort(Error('SECRET abort reason'));
  const sdk = client(async () => { calls++; return response(); }, { credentials: () => { loads++; return credentials(); } });
  await assert.rejects(sdk.emitEvent(event(), { signal: controller.signal }), expectedError('cancelled', 'not_sent'));
  assert.equal(loads, 0);
  const loading = deferred<void>(); const loaded = deferred<MiraCredentials>();
  const during = new AbortController();
  const pending = client(async () => { calls++; return response(); }, { credentials: () => { loading.resolve(); return loaded.promise; } })
    .emitEvent(event(), { signal: during.signal });
  await loading.promise; during.abort(Error('SECRET abort reason'));
  await assert.rejects(pending, expectedError('cancelled', 'not_sent'));
  loaded.resolve(credentials()); await Promise.resolve();
  assert.equal(calls, 0);
  await assert.rejects(client(async () => { calls++; return response(); }, { credentials: () => new Promise(() => undefined), timeoutMs: 10 }).emitEvent(event()), expectedError('timeout', 'not_sent'));
  assert.equal(calls, 0);
});

test('external cancellation and timeout after dispatch abort transport and remain unknown without retrying', async () => {
  for (const mode of ['cancelled', 'timeout'] as const) {
    const started = deferred<void>(); const controller = new AbortController();
    let calls = 0; let requestSignal: AbortSignal | null | undefined;
    const sdk = client(async (_url, init) => { calls++; requestSignal = init?.signal; started.resolve(); return new Promise(() => undefined); }, { timeoutMs: mode === 'timeout' ? 15 : 1000 });
    const pending = sdk.emitEvent(event(), { signal: controller.signal });
    await started.promise;
    if (mode === 'cancelled') controller.abort(Error('SECRET abort reason'));
    await assert.rejects(pending, expectedError(mode, 'unknown'));
    assert.equal(requestSignal?.aborted, true); assert.equal(calls, 1);
  }
});

test('external client actually cancels a stalled response reader on timeout or caller cancellation', async () => {
  for (const mode of ['cancelled', 'timeout'] as const) {
    let cancelled = 0;
    const reading = deferred<void>(); const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({ pull() { reading.resolve(); return new Promise(() => undefined); }, cancel() { cancelled++; } });
    const pending = client(async () => new Response(stream, { status: 201 }), { timeoutMs: mode === 'timeout' ? 15 : 1000 })
      .emitEvent(event(), { signal: controller.signal });
    await reading.promise;
    // pull can begin when the Response is created; let fetch install its reader.
    await new Promise(resolve => setTimeout(resolve, 0));
    if (mode === 'cancelled') controller.abort();
    await assert.rejects(pending, expectedError(mode, 'unknown', 201));
    assert.equal(cancelled, 1); assert.equal(stream.locked, false);
  }
});

test('late transport responses are cancelled after the caller has timed out', async () => {
  const late = deferred<Response>(); let cancelled = 0;
  const pending = client(() => late.promise, { timeoutMs: 10 }).emitEvent(event());
  await assert.rejects(pending, expectedError('timeout', 'unknown'));
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  late.resolve(new Response(stream, { status: 201 }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, 1);
});

test('external response byte limit is enforced on consumed bytes and cancels excess streams', async () => {
  const data = JSON.stringify(receipt());
  const exactly = data + ' '.repeat(MAX_EXTERNAL_RESPONSE_BYTES - new TextEncoder().encode(data).byteLength);
  assert.deepEqual(await client(async () => new Response(exactly, { status: 201 })).emitEvent(event()), receipt());
  for (const chunks of [new TextEncoder().encode(`${exactly} `), new TextEncoder().encode('你'.repeat(3000))]) {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(chunks); }, cancel() { cancelled++; } });
    await assert.rejects(client(async () => new Response(stream, { status: 201, headers: { 'content-length': '1' } })).emitEvent(event()), expectedError('response_too_large', 'unknown', 201));
    assert.equal(cancelled, 1); assert.equal(stream.locked, false);
  }
  let index = 0; let cancelled = 0;
  const streamed = new ReadableStream<Uint8Array>({ pull(controller) { index++; controller.enqueue(new Uint8Array(4097)); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  await assert.rejects(client(async () => new Response(streamed, { status: 201 })).emitEvent(event()), expectedError('response_too_large', 'unknown', 201));
  assert.equal(index, 2); assert.equal(cancelled, 1);
});

test('external client rejects malformed, mismatched and nonpersisted receipts without accepting HTTP alone', async () => {
  const wrong = [null, [], {}, { ...receipt(), ignored: 'SECRET response' }, { ...receipt(), id: 'event-other' },
    { ...receipt(), receipt: 'duplicate' }, { ...receipt(), durability: 'queued' }, { ...receipt(), operation: 'notification' },
    { ...receipt(), eventId: 'event-1' }, { ...receipt(), id: 1 }];
  for (const value of wrong) await assert.rejects(client(async () => Response.json(value, { status: 201 })).emitEvent(event()), expectedError('invalid_response', 'unknown', 201));
  for (const value of ['', 'SECRET malformed JSON', JSON.stringify(receipt()).slice(0, -1)]) {
    await assert.rejects(client(async () => new Response(value, { status: 201 })).emitEvent(event()), expectedError('invalid_response', 'unknown', 201));
  }
  await assert.rejects(client(async () => Response.json(receipt(), { status: 200 })).emitEvent(event()), expectedError('invalid_response', 'unknown', 200));
  await assert.rejects(client(async () => Response.json({ ...receipt('wake'), eventId: 'wrong-event' }, { status: 201 })).requestWake(wake()), expectedError('invalid_response', 'unknown', 201));
  await assert.rejects(client(async () => response()).sendNotification(notification()), expectedError('invalid_response', 'unknown', 201));
  await assert.rejects(client(async () => new Response(new Uint8Array([0xff, 0xfe]), { status: 201 })).emitEvent(event()), expectedError('invalid_response', 'unknown', 201));
  await assert.rejects(client(async () => new Response(null, { status: 201 })).emitEvent(event()), expectedError('invalid_response', 'unknown', 201));
});

test('external HTTP failures classify 4xx rejection versus unknown timeout, redirect, 5xx and unexpected success', async () => {
  for (const status of [400, 401, 403, 404, 409, 413, 422, 429, 408, 500, 503, 301, 307, 202, 204]) {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
    const body = status === 204 ? null : stream;
    await assert.rejects(client(async () => new Response(body, { status, headers: { location: 'https://evil.invalid/SECRET' } })).emitEvent(event()),
      expectedError('http_error', status >= 400 && status < 500 && status !== 408 ? 'rejected' : 'unknown', status));
    assert.equal(cancelled, status === 204 ? 0 : 1);
  }
});

test('external errors redact transport exceptions and untrusted response accessors', async () => {
  for (const transport of [() => { throw Error(`SECRET ${token}`); }, async () => { throw new MiraClientError('http_error', 'rejected', 401); }]) {
    await assert.rejects(client(transport as typeof globalThis.fetch).emitEvent(event()), expectedError('network_error', 'unknown'));
  }
  const malicious = { get status() { throw Error(`SECRET ${token}`); } } as unknown as Response;
  await assert.rejects(client(async () => malicious).emitEvent(event()), expectedError('invalid_response', 'unknown'));
  const stream = new ReadableStream<Uint8Array>({ pull() { throw Error(`SECRET ${token}`); } });
  await assert.rejects(client(async () => new Response(stream, { status: 201 })).emitEvent(event()), expectedError('network_error', 'unknown', 201));
  const redirected = response(); Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(client(async () => redirected).emitEvent(event()), expectedError('invalid_response', 'unknown'));
});

test('external SDK performs no automatic retry and caller retry preserves the complete original IDs, time and body', async () => {
  const bodies: string[] = [];
  const sdk = client(async (_url, init) => {
    bodies.push(init?.body as string);
    if (bodies.length === 1) throw Error('SECRET network error after commit');
    return response('wake', 'duplicate');
  });
  const original = wake();
  await assert.rejects(sdk.requestWake(original), expectedError('network_error', 'unknown'));
  assert.equal(bodies.length, 1);
  assert.deepEqual(await sdk.requestWake(original), receipt('wake', 'duplicate'));
  assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.deepEqual(JSON.parse(bodies[1]!), original);
});

test('external request options cannot expose accessor errors or override native cancellation checks', async () => {
  let calls = 0;
  const sdk = client(async () => { calls++; return response(); });
  for (const options of [{ signal: {} }, { get signal() { throw Error('SECRET signal'); } }]) {
    await assert.rejects(sdk.emitEvent(event(), options as { signal: AbortSignal }), expectedError('invalid_configuration', 'not_sent'));
  }
  const controller = new AbortController(); controller.abort();
  Object.defineProperty(controller.signal, 'aborted', { get() { throw Error('SECRET overridden getter'); } });
  await assert.rejects(sdk.emitEvent(event(), { signal: controller.signal }), expectedError('cancelled', 'not_sent'));
  assert.equal(calls, 0);
});

test('malformed response metadata also closes the response body', async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled++; } });
  const redirected = new Response(stream, { status: 201 });
  Object.defineProperty(redirected, 'redirected', { value: true });
  await assert.rejects(client(async () => redirected).emitEvent(event()), expectedError('invalid_response', 'unknown'));
  assert.equal(cancelled, 1);
});
