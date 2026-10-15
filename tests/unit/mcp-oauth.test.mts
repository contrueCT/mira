import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { test } from 'node:test';
import type { ExtensionCredentials } from '@mira/extension-sdk';
import { OAuthSession, safeOAuthFetch } from '../../packages/mcp-plugin/src/oauth.ts';
import { allowLocalTestHttp } from '../deny-model-network.mts';

// Resolve the plugin's installed SDK public entry point, not SDK internals.
const { auth, StreamableHTTPClientTransport } = createRequire(new URL('../../packages/mcp-plugin/package.json', import.meta.url))('@modelcontextprotocol/client');
const resource = 'https://mcp.example.invalid/mcp';
const issuerA = 'https://issuer-a.example.invalid';
const issuerB = 'https://issuer-b.example.invalid';
const freshSignal = () => new AbortController().signal;
type Provider = OAuthSession['provider'];

function storage() {
  const values = new Map<string, string>();
  const credentials: ExtensionCredentials = {
    get: async key => values.get(key) ?? null, has: async key => values.has(key),
    set: async (key, value) => { assert.match(key, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/); assert.ok(value.length <= 16384); values.set(key, value); },
    delete: async key => { values.delete(key); },
  };
  return { values, credentials };
}
function discovery(issuer = issuerA, requireIssuer = true) {
  return { authorizationServerUrl: issuer, resourceMetadata: { resource, authorization_servers: [issuer] },
    authorizationServerMetadata: { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: requireIssuer } };
}
async function redirect(provider: Provider, issuer = issuerA, requireIssuer = true): Promise<URL> {
  await provider.saveDiscoveryState!(discovery(issuer, requireIssuer));
  const state = await provider.state!();
  await provider.saveCodeVerifier('synthetic-sdk-verifier');
  const url = new URL(`${issuer}/authorize`);
  url.search = new URLSearchParams({ state, redirect_uri: String(provider.redirectUrl), code_challenge_method: 'S256', code_challenge: 'synthetic-challenge' }).toString();
  await provider.redirectToAuthorization(url);
  return url;
}
async function callback(provider: Provider, authorization: URL, additions: Record<string, string> = {}, options: RequestInit = {}) {
  const url = new URL(String(provider.redirectUrl));
  // For an existing HTTPS proxy fixture, exercise its loopback upstream directly.
  assert.equal(url.protocol, 'http:');
  url.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'synthetic-code', iss: issuerA, ...additions }).toString();
  const revoke = allowLocalTestHttp(url.origin);
  try { return await fetch(url, options); } finally { revoke(); }
}
async function assertClosed(url: string): Promise<void> {
  const target = new URL(url);
  const revoke = allowLocalTestHttp(target.origin);
  try { await assert.rejects(fetch(target), /fetch failed/); } finally { revoke(); }
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(Number(target.port), '127.0.0.1', resolve); });
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test('MCP OAuth uses official discovery, registration, PKCE and finishAuth; only opaque credentials survive', async () => {
  const store = storage();
  const published: Array<string | null> = [];
  const session = new OAuthSession(store.credentials, resource, { callbackPort: 0 }, url => published.push(url));
  let verifier = '';
  let refreshing = false;
  let registrations = 0;
  let registration: Record<string, unknown> | undefined;
  const fixtureFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/.well-known/oauth-protected-resource')) return Response.json(discovery().resourceMetadata);
    if (url.includes('/.well-known/oauth-authorization-server')) return Response.json(discovery().authorizationServerMetadata);
    if (url === `${issuerA}/register`) {
      registrations++;
      registration = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json({ ...registration, client_id: 'synthetic-client', client_secret: 'synthetic-client-secret' }, { status: 201 });
    }
    if (url === `${issuerA}/token`) {
      const params = new URLSearchParams(String(init?.body));
      assert.equal(params.get('grant_type'), refreshing ? 'refresh_token' : 'authorization_code');
      if (refreshing) {
        assert.equal(params.get('refresh_token'), 'synthetic-refresh');
        assert.equal(params.has('code_verifier'), false);
      } else {
        assert.equal(params.get('code'), 'synthetic-code');
        verifier = params.get('code_verifier')!;
      }
      return Response.json({ access_token: refreshing ? 'synthetic-renewed-access' : 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer', expires_in: 3600 });
    }
    throw new Error('Unexpected synthetic OAuth endpoint');
  };
  let callbackUrl = '';
  await session.run(freshSignal(), async (provider, wait, signal) => {
    const fetchFn = safeOAuthFetch(fixtureFetch, signal);
    assert.equal(await auth(provider, { serverUrl: resource, fetchFn }), 'REDIRECT');
    const authorization = new URL(published.at(-1)!);
    assert.equal(authorization.protocol, 'https:');
    assert.equal(authorization.searchParams.get('state')!.length, 43);
    assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(authorization.searchParams.has('client_secret'), false);
    callbackUrl = String(provider.redirectUrl);
    assert.deepEqual(registration?.['redirect_uris'], [callbackUrl]);
    const response = await callback(provider, authorization);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.doesNotMatch(await response.text(), /synthetic-code|synthetic-client-secret/);
    const params = await wait();
    assert.deepEqual([...params.keys()].sort(), ['code', 'iss']);
    const transport = new StreamableHTTPClientTransport(new URL(resource), { authProvider: provider, fetch: fetchFn });
    try { await transport.finishAuth(params); } finally { await transport.close(); }
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
    assert.equal((await provider.tokens())?.access_token, 'synthetic-access');
    await assert.rejects(wait(), /authorization failed/);
    assert.equal((await callback(provider, authorization)).status, 410);
  });
  assert.equal(published.at(-1), null);
  assert.throws(() => session.codeVerifier(), /explicit connect/);
  assert.throws(() => session.state(), /explicit connect/);
  assert.ok(!JSON.stringify([...store.values.values()]).includes(verifier));
  assert.ok(!JSON.stringify([...store.values.values()]).includes('synthetic-code'));
  const restored = new OAuthSession(store.credentials, resource, { redirectUrl: callbackUrl });
  assert.equal((await restored.tokens())?.refresh_token, 'synthetic-refresh');
  refreshing = true;
  await restored.run(freshSignal(), async (provider, _wait, signal) => {
    assert.equal(await auth(provider, { serverUrl: resource, fetchFn: safeOAuthFetch(fixtureFetch, signal) }), 'AUTHORIZED');
    assert.equal((await provider.tokens())?.access_token, 'synthetic-renewed-access');
  });
  assert.equal(registrations, 1, 'Restart refresh reuses only the original same-server, issuer, redirect registration');
  assert.equal(await new OAuthSession(storage().credentials, resource).tokens(), undefined);
  assert.equal(await new OAuthSession(store.credentials, `${resource}/different`).tokens(), undefined);
  await assertClosed(callbackUrl);
});

test('MCP OAuth scopes registration, tokens and invalidation to active issuer without confusing the bearer pointer', async () => {
  const store = storage();
  const session = new OAuthSession(store.credentials, resource, { callbackPort: 0 });
  await session.run(freshSignal(), async provider => {
    await provider.saveDiscoveryState!(discovery(issuerA));
    await provider.saveClientInformation!({ client_id: 'client-a', issuer: issuerA }, { issuer: issuerA });
    await provider.saveTokens({ access_token: 'access-a', refresh_token: 'refresh-a', token_type: 'Bearer', issuer: issuerA }, { issuer: issuerA });
    await provider.saveDiscoveryState!(discovery(issuerB));
    assert.equal(await provider.tokens({ issuer: issuerB }), undefined);
    assert.equal(await provider.clientInformation({ issuer: issuerB }), undefined);
    await assert.rejects(Promise.resolve().then(() => provider.tokens({ issuer: issuerA })), /authorization failed/);
    await assert.rejects(Promise.resolve().then(() => provider.saveTokens({ access_token: 'wrong', token_type: 'Bearer', issuer: issuerA }, { issuer: issuerB })), /authorization failed/);
    await provider.saveClientInformation!({ client_id: 'client-b', issuer: issuerB }, { issuer: issuerB });
    await provider.saveTokens({ access_token: 'access-b', refresh_token: 'refresh-b', token_type: 'Bearer', issuer: issuerB }, { issuer: issuerB });
    await provider.saveDiscoveryState!(discovery(issuerA));
    await provider.invalidateCredentials!('tokens');
    assert.equal(await provider.tokens({ issuer: issuerA }), undefined);
    assert.equal((await provider.tokens())?.access_token, 'access-b');
    await provider.saveDiscoveryState!(discovery(issuerB));
    assert.equal((await provider.tokens({ issuer: issuerB }))?.refresh_token, 'refresh-b');
    await provider.saveClientInformation!({ client_id: 'replaced-client-b', issuer: issuerB }, { issuer: issuerB });
    assert.equal(await provider.tokens({ issuer: issuerB }), undefined, 'A new registration must not receive the previous client refresh token');
  });
  await assert.rejects(session.saveTokens({ access_token: 'late', token_type: 'Bearer', issuer: issuerB }), /explicit connect/);
});

test('MCP OAuth rejects callback state, duplicate parameters, methods and paths before consuming a valid callback', async () => {
  const session = new OAuthSession(storage().credentials, resource, { callbackPort: 0 });
  await session.run(freshSignal(), async (provider, wait) => {
    const authorization = await redirect(provider);
    assert.equal((await callback(provider, authorization, { state: 'forged' })).status, 400);
    assert.equal((await callback(provider, authorization, {}, { method: 'POST' })).status, 400);
    const url = new URL(String(provider.redirectUrl));
    url.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'first', iss: issuerA }).toString();
    url.searchParams.append('code', 'second');
    const revoke = allowLocalTestHttp(url.origin);
    try {
      assert.equal((await fetch(url)).status, 400);
      url.pathname = '/different';
      assert.equal((await fetch(url)).status, 400);
    } finally { revoke(); }
    assert.equal((await callback(provider, authorization)).status, 200);
    assert.equal((await wait()).get('code'), 'synthetic-code');
  });
});

test('MCP OAuth validates supplied and required issuers on success and error callbacks without leaking descriptions', async () => {
  for (const additions of [{ iss: issuerB }, { iss: '' }, { error: 'access_denied', error_description: 'SYNTHETIC_SECRET' }]) {
    const session = new OAuthSession(storage().credentials, resource, { callbackPort: 0 });
    await session.run(freshSignal(), async (provider, wait) => {
      const authorization = await redirect(provider);
      const response = await callback(provider, authorization, additions);
      assert.equal(response.status, 400);
      assert.doesNotMatch(await response.text(), /SYNTHETIC_SECRET|synthetic-code|issuer-b/);
      await assert.rejects(wait(), /authorization failed/);
      assert.equal((await callback(provider, authorization)).status, 410);
    });
  }
  const session = new OAuthSession(storage().credentials, resource, { callbackPort: 0 });
  await session.run(freshSignal(), async (provider, wait) => {
    const authorization = await redirect(provider, issuerA, false);
    const url = new URL(String(provider.redirectUrl));
    url.search = new URLSearchParams({ code: 'no-issuer-code', state: authorization.searchParams.get('state')! }).toString();
    const revoke = allowLocalTestHttp(url.origin);
    try { assert.equal((await fetch(url)).status, 200); } finally { revoke(); }
    assert.equal((await wait()).has('iss'), false);
  });
});

test('MCP OAuth cancellation and expiry join listener cleanup; a restart cannot resume the old state', async () => {
  const store = storage();
  let callbackUrl = '';
  let oldState = '';
  const session = new OAuthSession(store.credentials, resource, { callbackPort: 0 });
  const controller = new AbortController();
  await assert.rejects(session.run(controller.signal, async (provider, wait) => {
    oldState = (await redirect(provider)).searchParams.get('state')!;
    callbackUrl = String(provider.redirectUrl);
    controller.abort();
    await wait();
  }), { name: 'AbortError' });
  await assertClosed(callbackUrl);
  const restarted = new OAuthSession(store.credentials, resource, { redirectUrl: callbackUrl });
  await restarted.run(freshSignal(), async (provider, wait) => {
    const next = await redirect(provider);
    assert.notEqual(next.searchParams.get('state'), oldState);
    assert.equal((await callback(provider, next, { state: oldState })).status, 400);
    assert.equal((await callback(provider, next)).status, 200);
    await wait();
  });
  const expiring = new OAuthSession(store.credentials, resource, { callbackPort: 0, timeoutMs: 30 });
  await assert.rejects(expiring.run(freshSignal(), async (provider, wait, signal) => {
    await redirect(provider); callbackUrl = String(provider.redirectUrl);
    try { await wait(); } finally { assert.equal(signal.aborted, true); }
  }), { name: 'AbortError' });
  await assertClosed(callbackUrl);
  const swallowed = new AbortController();
  await assert.rejects(session.run(swallowed.signal, async () => { swallowed.abort(); return 'must not succeed'; }), { name: 'AbortError' });
  const startupAbort = new AbortController();
  const starting = session.run(startupAbort.signal, async () => { assert.fail('Cancelled startup cannot call the operation'); });
  startupAbort.abort();
  await assert.rejects(starting, { name: 'AbortError' });
});

test('MCP OAuth never silently changes a configured occupied callback port', async () => {
  const reserve = createServer();
  await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const address = reserve.address(); assert.ok(address && typeof address !== 'string');
  try {
    const session = new OAuthSession(storage().credentials, resource, { callbackPort: address.port });
    await assert.rejects(session.run(freshSignal(), async () => { assert.fail('Occupied port must prevent auth'); }), /callback listener could not start/);
  } finally { await new Promise<void>(resolve => reserve.close(() => resolve())); }
});

test('MCP OAuth only accepts loopback or explicitly configured HTTPS callbacks and never exposes insecure authorization URLs', async () => {
  for (const config of [ { redirectUrl: 'http://remote.example.invalid/callback' }, { redirectUrl: 'https://user:secret@example.invalid/callback' },
    { redirectUrl: 'https://example.invalid/callback?secret=value' }, { redirectUrl: 'https://example.invalid/callback', callbackPort: 0 },
    { redirectUrl: 'http://127.0.0.1:1234/callback', callbackPort: 1235 } ]) {
    assert.throws(() => new OAuthSession(storage().credentials, resource, config), /authorization failed/);
  }
  const session = new OAuthSession(storage().credentials, resource, { callbackPort: 0 });
  await session.run(freshSignal(), async provider => {
    await provider.saveDiscoveryState!(discovery());
    const state = await provider.state!(); await provider.saveCodeVerifier('synthetic-verifier');
    const url = new URL('http://127.0.0.1/authorize');
    url.search = new URLSearchParams({ state, redirect_uri: String(provider.redirectUrl), code_challenge_method: 'S256', code_challenge: 'challenge' }).toString();
    await assert.rejects(Promise.resolve().then(() => provider.redirectToAuthorization(url)), /authorization failed/);
  });
  const reserve = createServer();
  await new Promise<void>((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const address = reserve.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<void>(resolve => reserve.close(() => resolve()));
  const remote = new OAuthSession(storage().credentials, resource, { redirectUrl: 'https://mira.example.invalid/mcp/callback', callbackPort: port });
  await remote.run(freshSignal(), async (provider, wait) => {
    const authorization = await redirect(provider);
    assert.equal(String(provider.redirectUrl), 'https://mira.example.invalid/mcp/callback');
    const url = new URL(`http://127.0.0.1:${port}/mcp/callback`);
    url.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'proxy-code', iss: issuerA }).toString();
    const revoke = allowLocalTestHttp(url.origin);
    try { assert.equal((await fetch(url)).status, 200); } finally { revoke(); }
    assert.equal((await wait()).get('code'), 'proxy-code');
  });
});

test('safeOAuthFetch preserves success and challenge headers while scrubbing provider and network errors', async () => {
  const success = Response.json({ access_token: 'synthetic-token', custom: { preserved: true } });
  assert.equal(await safeOAuthFetch(async () => success)(`${issuerA}/token`), success);
  const failed = await safeOAuthFetch(async (_input, init) => {
    assert.equal(init?.redirect, 'error');
    return Response.json({ error: 'invalid_grant', error_description: 'SYNTHETIC_SECRET', error_uri: 'https://private.invalid/secret' },
      { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.example.invalid/.well-known/oauth-protected-resource"' } });
  })(`${issuerA}/token`);
  assert.equal(failed.status, 401);
  assert.ok(failed.headers.get('www-authenticate'));
  assert.deepEqual(await failed.json(), { error: 'invalid_grant', error_description: 'OAuth request failed' });
  const malformed = await safeOAuthFetch(async () => new Response('SYNTHETIC_SECRET', { status: 500 }))(`${issuerA}/token`);
  assert.doesNotMatch(await malformed.text(), /SYNTHETIC_SECRET/);
  const tokenRequest = { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'synthetic-refresh' }) };
  await assert.rejects(safeOAuthFetch(async () => new Response('SYNTHETIC_SECRET'))(`${issuerA}/token`, tokenRequest), /^Error: MCP authorization network request failed$/);
  const successError = await safeOAuthFetch(async () => Response.json({ error: 'invalid_grant', error_description: 'SYNTHETIC_SECRET' }))(`${issuerA}/token`, tokenRequest);
  assert.deepEqual(await successError.json(), { error: 'invalid_grant', error_description: 'OAuth request failed' });
  await assert.rejects(safeOAuthFetch(async () => { throw new Error('SYNTHETIC_SECRET'); })(`${issuerA}/token`), /^Error: MCP authorization network request failed$/);
  await assert.rejects(safeOAuthFetch(async () => Response.redirect('https://other.invalid/', 302))(`${issuerA}/token`), /network request failed/);
  await assert.rejects(safeOAuthFetch(async () => success)('http://remote.invalid/token'), /network request failed/);
});

async function saveSyntheticAuthorization(session: OAuthSession, issuers = [issuerA]) {
  await session.run(freshSignal(), async provider => {
    for (const issuer of issuers) {
      await provider.saveDiscoveryState!(discovery(issuer));
      await provider.saveClientInformation!({ client_id: `synthetic-client-${issuer}`, issuer }, { issuer });
      await provider.saveTokens({ access_token: `synthetic-access-${issuer}`, refresh_token: `synthetic-refresh-${issuer}`, token_type: 'Bearer', issuer }, { issuer });
    }
  });
}

test('MCP OAuth explicit forget clears every known issuer, is repeatable and preserves other server/install credentials', async () => {
  const store = storage(); const otherInstall = storage();
  const published: Array<string | null> = [];
  const session = new OAuthSession(store.credentials, resource, { callbackPort: 0 }, url => published.push(url));
  const otherServer = new OAuthSession(store.credentials, `${resource}/other`, { callbackPort: 0 });
  const independent = new OAuthSession(otherInstall.credentials, resource, { callbackPort: 0 });
  await saveSyntheticAuthorization(session, [issuerA, issuerB]);
  await saveSyntheticAuthorization(otherServer);
  await saveSyntheticAuthorization(independent);
  store.values.set('unrelatedPluginSetting', 'preserved');
  const preserved = new Map([...store.values].filter(([, raw]) => raw === 'preserved' || JSON.parse(raw).server !== resource));
  const independentBefore = new Map(otherInstall.values);
  await session.forget();
  assert.deepEqual(store.values, preserved);
  assert.deepEqual(otherInstall.values, independentBefore);
  assert.equal(await session.tokens(), undefined);
  assert.ok(await otherServer.tokens());
  assert.ok(await independent.tokens());
  assert.equal(published.at(-1), null);
  await session.forget();
  assert.deepEqual(store.values, preserved);
  await saveSyntheticAuthorization(session);
  assert.ok(await session.tokens(), 'A fresh explicit authorization still works after reset');
  await session.forget();
});

test('MCP OAuth interrupted reset can resume after every deletion boundary', async () => {
  for (let failAt = 1; failAt <= 6; failAt++) {
    const store = storage();
    await saveSyntheticAuthorization(new OAuthSession(store.credentials, resource, { callbackPort: 0 }), [issuerA, issuerB]);
    let deletions = 0;
    const interrupted: ExtensionCredentials = { ...store.credentials, delete: async key => {
      await store.credentials.delete(key);
      if (++deletions === failAt) throw new Error('Synthetic interrupted reset');
    } };
    await assert.rejects(new OAuthSession(interrupted, resource).forget(), /Synthetic interrupted reset/);
    await new OAuthSession(store.credentials, resource).forget();
    assert.equal(store.values.size, 0, `All credentials removed after interruption ${failAt}`);
  }
});

test('MCP OAuth write-ahead issuer index recovers incomplete token writes and latest-pointer-only state', async () => {
  const store = storage();
  const interrupted: ExtensionCredentials = { ...store.credentials, set: async (key, raw) => {
    await store.credentials.set(key, raw);
    if (JSON.parse(raw).value?.access_token) throw new Error('Synthetic interrupted token write');
  } };
  await assert.rejects(saveSyntheticAuthorization(new OAuthSession(interrupted, resource, { callbackPort: 0 })), /Synthetic interrupted token write/);
  assert.equal([...store.values.values()].some(raw => { const value = JSON.parse(raw); return value.issuer && !value.value; }), false, 'Latest pointer was not written');
  await new OAuthSession(store.credentials, resource).forget();
  assert.equal(store.values.size, 0);

  await saveSyntheticAuthorization(new OAuthSession(store.credentials, resource, { callbackPort: 0 }));
  for (const [key, raw] of store.values) if (Array.isArray(JSON.parse(raw).issuers)) store.values.delete(key);
  await new OAuthSession(store.credentials, resource).forget();
  assert.equal(store.values.size, 0, 'Latest pointer alone provides safe reset recovery');
});

test('MCP OAuth reset rejects active runs, joins repeated resets and blocks authorization until deletion finishes', async () => {
  const store = storage();
  const deleting = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
  let deletionCalls = 0;
  const blocked: ExtensionCredentials = { ...store.credentials, delete: async key => {
    deletionCalls++;
    deleting.resolve(); await release.promise; await store.credentials.delete(key);
  } };
  const session = new OAuthSession(blocked, resource, { callbackPort: 0 });
  await session.run(freshSignal(), async provider => {
    await redirect(provider);
    await assert.rejects(session.forget(), /still running/);
  });
  await saveSyntheticAuthorization(session);
  const first = session.forget();
  await deleting.promise;
  const second = session.forget();
  await assert.rejects(session.run(freshSignal(), async () => assert.fail('Reset must block a concurrent run')), /being reset/);
  await assert.rejects(session.tokens(), /being reset/);
  release.resolve();
  await Promise.all([first, second]);
  assert.equal(deletionCalls, 4, 'Concurrent resets share one deletion pass');
  assert.equal(store.values.size, 0);
});

test('MCP OAuth persistent issuer index is bounded before new credentials are written', async () => {
  const store = storage();
  const session = new OAuthSession(store.credentials, resource, { callbackPort: 0 });
  await session.run(freshSignal(), async provider => {
    for (let index = 0; index < 32; index++) {
      const issuer = `https://issuer-${index}.example.invalid`;
      await provider.saveDiscoveryState!(discovery(issuer));
      await provider.saveClientInformation!({ client_id: 'synthetic-client', issuer }, { issuer });
    }
    const extra = 'https://extra-issuer.example.invalid';
    await provider.saveDiscoveryState!(discovery(extra));
    await assert.rejects(Promise.resolve().then(() => provider.saveClientInformation!({ client_id: 'not-stored', issuer: extra }, { issuer: extra })), /authorization failed/);
    assert.equal(await provider.clientInformation({ issuer: extra }), undefined);
  });
  assert.equal(store.values.size, 33);
  await session.forget();
  assert.equal(store.values.size, 0);
});
