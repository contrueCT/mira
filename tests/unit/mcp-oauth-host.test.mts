import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ExtensionHost } from '@mira/extension-host';
import { extensionTools } from '@mira/server';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toolName } from '../../packages/mcp-plugin/src/client.ts';
import { allowLocalTestHttp } from '../deny-model-network.mts';

const issuer = 'https://synthetic-oauth-host.invalid';
const access = 'SYNTHETIC_ACCESS_SECRET_5349';
const refresh = 'SYNTHETIC_REFRESH_SECRET_6431';
const clientSecret = 'SYNTHETIC_CLIENT_SECRET_4329';
const diagnostic = 'SYNTHETIC_PROVIDER_PRIVATE_DIAGNOSTIC_2912';
const unknownOutcome = 'Extension execution did not return a known outcome. Verify external effects before retrying. Raw diagnostics are hidden.';

async function waitFor<T>(read: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for synthetic OAuth settings action');
}

async function freeCallbackPort(): Promise<number> {
  // Plugin configuration requires a nonzero port. Discover a free one rather
  // than depending on a shared fixed port; keep it stable for refresh binding.
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = reservation.address();
    assert.ok(address && typeof address !== 'string');
    return address.port;
  } finally {
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  }
}

for (const protection of ['handshake', 'tools/list'] as const)
test(`Host OAuth protects ${protection}: official SDK PKCE, explicit scope upgrade, effect isolation and cancellation`, { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-oauth-host-')));
  const originalFetch = globalThis.fetch;
  const logs: Array<{ method: string; text: string }> = [];
  const visible: unknown[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      logs.push({ method, text: args.map(value => value instanceof Error ? value.stack : String(value)).join(' ') });
    });
  }
  let origin = '';
  let effectMode: 'ok' | 'error' | 'scope' | 'unauthorized' = 'ok';
  let requiredScope = 'read';
  let grantedScope = 'read';
  let listChallenges = 0;
  let rejectRefresh = false;
  let forceUnauthorized = false;
  let effectCalls = 0;
  let tokenExchanges = 0;
  let rejectedRefreshes = 0;
  let verifier = '';
  let registration: Record<string, unknown> | undefined;
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'synthetic-oauth-host', version: '1.0.0' });
    server.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'Safe known content' }] }));
    return server;
  }, { legacy: 'stateless' });
  const listener = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const message: unknown = body ? JSON.parse(body) : null;
      const method = message && typeof message === 'object' && 'method' in message ? message.method : undefined;
      if (method === 'tools/call') effectCalls++;
      const protectedRequest = protection === 'handshake' || method === 'tools/list' || method === 'tools/call';
      if (protectedRequest && (req.headers.authorization !== `Bearer ${access}` || forceUnauthorized)) {
        if (method === 'tools/list') listChallenges++;
        res.writeHead(401, { 'WWW-Authenticate': `Bearer resource_metadata="${issuer}/resource", error_description="${diagnostic}"` });
        res.end(diagnostic);
        return;
      }
      if (method === 'tools/list' && grantedScope !== requiredScope) {
        listChallenges++;
        res.writeHead(403, { 'WWW-Authenticate': `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${issuer}/resource"` });
        res.end(diagnostic);
        return;
      }
      if (method === 'tools/call') {
        if (effectMode !== 'ok') {
          res.writeHead(effectMode === 'error' ? 500 : effectMode === 'scope' ? 403 : 401, effectMode === 'error'
            ? { 'Content-Type': 'text/plain' }
            : { 'WWW-Authenticate': `Bearer error="${effectMode === 'scope' ? 'insufficient_scope' : 'invalid_token'}", scope="${effectMode === 'unauthorized' ? grantedScope : 'read write admin'}", resource_metadata="${issuer}/resource", error_description="${diagnostic}"` });
          res.end(`${access} ${refresh} ${clientSecret} ${diagnostic}`);
          return;
        }
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const response = await handler.fetch(new Request(origin + req.url, {
        method: req.method!, headers, signal: controller.signal, ...(body ? { body } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
      if (response.body) for await (const chunk of response.body) { if (res.destroyed) break; res.write(chunk); }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  let revoke = () => {};
  let host: ExtensionHost | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/mcp`;
    revoke = allowLocalTestHttp(origin);
    const fixtureFetch: typeof fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== issuer) return originalFetch(input, init);
      if (target.pathname === '/resource') return Response.json({ resource: url, authorization_servers: [issuer], scopes_supported: ['read'] });
      if (target.pathname.includes('.well-known')) return Response.json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`, response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
      if (target.pathname === '/register') {
        registration = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json({ ...registration, client_id: 'synthetic-client', client_secret: clientSecret }, { status: 201 });
      }
      if (target.pathname === '/token') {
        tokenExchanges++;
        const params = new URLSearchParams(String(init?.body));
        if (rejectRefresh) {
          assert.equal(params.get('grant_type'), 'refresh_token');
          assert.equal(params.get('refresh_token'), refresh);
          rejectedRefreshes++;
          return Response.json({ error: 'invalid_grant', error_description: diagnostic }, { status: 400 });
        }
        if (params.get('grant_type') === 'refresh_token') {
          assert.equal(params.get('refresh_token'), refresh);
          return Response.json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', scope: grantedScope, expires_in: 3600 });
        }
        assert.equal(params.get('grant_type'), 'authorization_code');
        assert.equal(params.get('code'), 'SYNTHETIC_CODE');
        verifier = params.get('code_verifier') ?? '';
        grantedScope = requiredScope;
        return Response.json({ access_token: access, refresh_token: refresh, token_type: 'Bearer', scope: grantedScope, expires_in: 3600 });
      }
      throw new Error('Unexpected synthetic OAuth endpoint');
    };
    t.mock.method(globalThis, 'fetch', fixtureFetch);
    const configurationFile = path.join(root, 'extensions.json');
    const entries = [{ id: 'remote', path: path.resolve('packages/mcp-plugin/src/index.ts'), config: {
      transport: 'http', protocol: '2026-07-28', auth: 'oauth', url, callbackPort: String(await freeCallbackPort()),
    } }];
    await writeFile(configurationFile, JSON.stringify({ entries }));
    host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
    const activeHost = host;
    const settings = async () => {
      const view = await activeHost.extensionSettings('remote');
      assert.ok(view);
      visible.push(view);
      return view;
    };
    const completed = () => waitFor(async () => {
      const view = await settings();
      return view.operation && view.operation.state !== 'pending' ? view : null;
    });
    const authorization = () => waitFor(async () => {
      const view = await settings();
      return view.status.authorization ? view : null;
    });
    await host.start();
    let view = await settings();
    assert.equal(view.status.code, 'authentication');
    await host.startSettingsAction('remote', 'authorize', view.revision);
    view = await authorization();
    const authUrl = new URL(view.status.authorization!.url);
    assert.equal(authUrl.origin, issuer);
    assert.equal(authUrl.searchParams.get('state')?.length, 43);
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
    const callback = new URL(authUrl.searchParams.get('redirect_uri')!);
    assert.deepEqual(registration?.['redirect_uris'], [callback.href]);
    callback.search = new URLSearchParams({ state: 'forged-state', code: 'SYNTHETIC_CODE', iss: issuer }).toString();
    const revokeCallback = allowLocalTestHttp(callback.origin);
    try {
      assert.equal((await originalFetch(callback)).status, 400);
      assert.equal(tokenExchanges, 0, 'Wrong state must not trigger a token exchange');
      callback.searchParams.set('state', authUrl.searchParams.get('state')!);
      const response = await originalFetch(callback);
      assert.equal(response.status, 200);
      visible.push(await response.text());
    } finally { revokeCallback(); }
    view = await completed();
    assert.equal(view.operation?.state, 'succeeded');
    assert.equal(view.status.state, 'connected');
    assert.ok(verifier);
    assert.equal(createHash('sha256').update(verifier).digest('base64url'), authUrl.searchParams.get('code_challenge'));
    assert.equal(tokenExchanges, 1);

    if (protection === 'tools/list') {
      assert.ok(listChallenges >= 1, 'Startup must reach the protected list after public discovery; explicit authorization can consume its captured challenge');
      view = await settings();
      await host.startSettingsAction('remote', 'disconnect', view.revision);
      assert.equal((await completed()).operation?.state, 'succeeded');
      requiredScope = 'read write';
      const beforeChallenges = listChallenges;
      view = await settings();
      await host.startSettingsAction('remote', 'authorize', view.revision);
      view = await authorization();
      assert.ok(listChallenges > beforeChallenges, 'Cached read token must encounter the list scope challenge');
      const stepUp = new URL(view.status.authorization!.url);
      assert.deepEqual(new Set(stepUp.searchParams.get('scope')?.split(' ')), new Set(['read', 'write']));
      const stepUpCallback = new URL(stepUp.searchParams.get('redirect_uri')!);
      stepUpCallback.search = new URLSearchParams({ state: stepUp.searchParams.get('state')!, code: 'SYNTHETIC_CODE', iss: issuer }).toString();
      const revokeStepUp = allowLocalTestHttp(stepUpCallback.origin);
      try { assert.equal((await originalFetch(stepUpCallback)).status, 200); } finally { revokeStepUp(); }
      view = await completed();
      assert.equal(view.operation?.state, 'succeeded');
      assert.equal(view.status.state, 'connected');
      assert.equal(grantedScope, 'read write');
    }

    const echo = extensionTools(await host.prepare()).find(tool => tool.name === toolName('remote', 'echo'));
    assert.ok(echo);
    assert.match(JSON.stringify(await echo.execute('known-success', {}, new AbortController().signal)), /Safe known content/);
    const exchangesBeforeEffects = tokenExchanges;
    for (const mode of ['error', 'scope', 'unauthorized'] as const) {
      effectMode = mode;
      const before = effectCalls;
      await assert.rejects(echo.execute(`effect-${mode}`, {}, new AbortController().signal), { message: unknownOutcome });
      assert.equal(effectCalls, before + 1, `${mode} must not replay an uncertain effect`);
      assert.equal(tokenExchanges, exchangesBeforeEffects, 'Effect failures must not initiate OAuth');
      assert.equal((await settings()).status.authorization, undefined, 'Effect failures must not open an authorization flow');
    }
    effectMode = 'ok';
    view = await settings();
    await host.startSettingsAction('remote', 'disconnect', view.revision);
    assert.equal((await completed()).operation?.state, 'succeeded');
    forceUnauthorized = true;
    rejectRefresh = true;
    view = await settings();
    await host.startSettingsAction('remote', 'authorize', view.revision);
    view = await authorization();
    assert.equal(rejectedRefreshes, 1, 'The real SDK must exercise invalid_grant refresh recovery');
    assert.ok(logs.some(log => log.method === 'warn'), 'Exercise the SDK recoverable-auth warning path');
    assert.equal(view.operation?.state, 'pending');
    assert.ok(view.operation);
    const pendingCallback = new URL(new URL(view.status.authorization!.url).searchParams.get('redirect_uri')!);
    await host.cancelSettingsAction('remote', view.operation.id);
    view = await completed();
    assert.equal(view.operation?.state, 'cancelled');
    assert.equal(view.status.authorization, undefined);
    const revokeCancelled = allowLocalTestHttp(pendingCallback.origin);
    try { await assert.rejects(originalFetch(pendingCallback), /fetch failed/); } finally { revokeCancelled(); }
    assert.equal(effectCalls, 4);
    const publicOutput = JSON.stringify({ visible, inspect: host.inspect(), diagnostics: host.diagnosticsLog(),
      config: await readFile(configurationFile, 'utf8'), logs });
    for (const secret of [access, refresh, clientSecret, diagnostic, verifier, 'SYNTHETIC_CODE']) {
      assert.ok(!publicOutput.includes(secret), 'Public settings, diagnostics, configuration and console must redact synthetic secrets');
    }
  } finally {
    try { await host?.close(); } finally {
      try { await handler.close(); } finally {
        listener.closeAllConnections();
        await new Promise<void>(resolve => listener.close(() => resolve()));
        revoke();
        t.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

test('Host OAuth recovers effect-only 401/403 through explicit authorization without replay or private challenge disclosure', { timeout: 20_000 }, async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-effect-oauth-host-')));
  const originalFetch = globalThis.fetch;
  const metadataPath = '/private-effect-resource-5376';
  const readAccess = 'SYNTHETIC_READ_ACCESS_SECRET_4276';
  const writeAccess = 'SYNTHETIC_WRITE_ACCESS_SECRET_8293';
  const cancelledAccess = 'SYNTHETIC_CANCELLED_ACCESS_SECRET_7264';
  const logs: string[] = [];
  const visible: unknown[] = [];
  const modelOutput: unknown[] = [];
  const oauthRequests: string[] = [];
  const tokenGrants: string[] = [];
  const verifiers: string[] = [];
  const effectHeaders: Array<string | undefined> = [];
  const challenges: number[] = [];
  const exchangeStarted = Promise.withResolvers<AbortSignal>();
  const releaseExchange = Promise.withResolvers<void>();
  let origin = '';
  let requiredScope: 'read' | 'write' = 'read';
  let grantedScope = 'read';
  let holdExchange = false;
  let discoveryReads = 0;
  let listReads = 0;
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    t.mock.method(console, method, (...args: unknown[]) => {
      logs.push(args.map(value => value instanceof Error ? value.stack : String(value)).join(' '));
    });
  }
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: 'synthetic-effect-only-oauth', version: '1.0.0' });
    server.registerTool('echo', {}, async () => ({ content: [{ type: 'text', text: 'Safe explicitly requested effect' }] }));
    return server;
  }, { legacy: 'stateless' });
  const listener = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const message: unknown = body ? JSON.parse(body) : null;
      const method = message && typeof message === 'object' && 'method' in message ? message.method : undefined;
      if (method === 'tools/list') listReads++;
      else if (method !== 'tools/call') discoveryReads++;
      // Discovery and tools/list remain public even when all effect calls fail.
      if (method === 'tools/call') {
        const authorization = req.headers.authorization;
        effectHeaders.push(authorization);
        const authenticated = authorization === `Bearer ${readAccess}` || authorization === `Bearer ${writeAccess}`;
        const scopeGranted = requiredScope === 'read' || authorization === `Bearer ${writeAccess}`;
        if (!authenticated || !scopeGranted) {
          const status = authenticated ? 403 : 401;
          challenges.push(status);
          res.writeHead(status, { 'WWW-Authenticate': `Bearer error="${authenticated ? 'insufficient_scope' : 'invalid_token'}", scope="${requiredScope}", resource_metadata="${issuer}${metadataPath}", error_description="${diagnostic}"` });
          res.end(`${diagnostic} ${clientSecret}`);
          return;
        }
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const response = await handler.fetch(new Request(origin + req.url, {
        method: req.method!, headers, signal: controller.signal, ...(body ? { body } : {}),
      }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.flushHeaders();
      if (response.body) for await (const chunk of response.body) { if (res.destroyed) break; res.write(chunk); }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
  let revoke = () => {};
  let host: ExtensionHost | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    assert.ok(address && typeof address !== 'string');
    origin = `http://127.0.0.1:${address.port}`;
    const url = `${origin}/mcp`;
    revoke = allowLocalTestHttp(origin);
    const fixtureFetch: typeof fetch = async (input, init) => {
      const target = new URL(input instanceof Request ? input.url : String(input));
      if (target.origin !== issuer) return originalFetch(input, init);
      oauthRequests.push(target.pathname);
      assert.equal(init?.redirect, 'error', 'Explicit OAuth must use the safe fetch redirect boundary');
      assert.ok(init?.signal, 'Explicit OAuth must carry its action cancellation signal');
      if (target.pathname === metadataPath) return Response.json({ resource: url, authorization_servers: [issuer], scopes_supported: ['read'] });
      if (target.pathname.includes('.well-known')) return Response.json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`, response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'],
        authorization_response_iss_parameter_supported: true,
      });
      if (target.pathname === '/register') return Response.json({
        ...JSON.parse(String(init?.body)) as Record<string, unknown>, client_id: 'synthetic-effect-client', client_secret: clientSecret,
      }, { status: 201 });
      if (target.pathname === '/token') {
        const params = new URLSearchParams(String(init?.body));
        const grant = params.get('grant_type');
        assert.equal(grant, 'authorization_code', 'A strict scope upgrade must request consent rather than refresh the read token');
        tokenGrants.push(grant!);
        assert.equal(params.get('code'), 'SYNTHETIC_EFFECT_CODE');
        assert.equal(params.get('resource'), url);
        verifiers.push(params.get('code_verifier') ?? '');
        if (holdExchange) {
          exchangeStarted.resolve(init.signal);
          // Deliberately ignore abort until released, exercising late response fencing.
          await releaseExchange.promise;
        }
        return Response.json({ access_token: holdExchange ? cancelledAccess : grantedScope === 'read' ? readAccess : writeAccess,
          refresh_token: refresh, token_type: 'Bearer', scope: grantedScope, expires_in: 3600 });
      }
      throw new Error('Unexpected synthetic effect-only OAuth endpoint');
    };
    t.mock.method(globalThis, 'fetch', fixtureFetch);
    const configurationFile = path.join(root, 'extensions.json');
    const entries = [{ id: 'remote', path: path.resolve('packages/mcp-plugin/src/index.ts'), config: {
      transport: 'http', protocol: '2026-07-28', auth: 'oauth', url, callbackPort: String(await freeCallbackPort()),
    } }];
    await writeFile(configurationFile, JSON.stringify({ entries }));
    host = new ExtensionHost({ entries, configurationFile, receive: async () => 'inserted' });
    const activeHost = host;
    const settings = async () => {
      const view = await activeHost.extensionSettings('remote');
      assert.ok(view);
      assert.equal(view.status.details, undefined, 'Private challenge data must not become settings status details');
      const publicView = structuredClone(view);
      // Only the protected authorization URL may expose the requested OAuth scope.
      delete publicView.status.authorization;
      visible.push(publicView);
      return view;
    };
    const completed = () => waitFor(async () => {
      const view = await settings();
      return view.operation && view.operation.state !== 'pending' ? view : null;
    });
    const action = async (name: 'disconnect' | 'connect' | 'forgetAuthorization') => {
      const view = await settings();
      await activeHost.startSettingsAction('remote', name, view.revision);
      const result = await completed();
      assert.equal(result.operation?.state, 'succeeded');
      return result;
    };
    const controlCurrent = async () => {
      const control = extensionTools(await activeHost.prepare()).find(tool => tool.name.startsWith('mcp_control_'));
      assert.ok(control);
      modelOutput.push(await control.execute('current-safe-receipt', { operation: 'current' }, new AbortController().signal));
    };
    const effect = async (id: string, succeeds = false) => {
      const echo = extensionTools(await activeHost.prepare()).find(tool => tool.name === toolName('remote', 'echo'));
      assert.ok(echo);
      const before = effectHeaders.length;
      if (succeeds) {
        const result = await echo.execute(id, {}, new AbortController().signal);
        modelOutput.push(result);
        assert.match(JSON.stringify(result), /Safe explicitly requested effect/);
      } else {
        await assert.rejects(echo.execute(id, {}, new AbortController().signal), error => {
          assert.ok(error instanceof Error);
          modelOutput.push(error.message);
          assert.equal(error.message, unknownOutcome);
          return true;
        });
      }
      assert.equal(effectHeaders.length, before + 1, 'Each explicit effect call must be sent exactly once');
    };
    const authorize = async (scope: string) => {
      const view = await settings();
      assert.equal(view.status.state, 'connected');
      assert.ok(view.actions.some(action => action.id === 'authorize'), 'Authorize remains available on a public connected server');
      await activeHost.startSettingsAction('remote', 'authorize', view.revision);
      const pending = await waitFor(async () => {
        const current = await settings();
        return current.status.authorization ? current : null;
      });
      assert.equal(pending.operation?.state, 'pending');
      const authorization = new URL(pending.status.authorization!.url);
      assert.equal(authorization.origin, issuer);
      assert.deepEqual(new Set(authorization.searchParams.get('scope')?.split(' ')), new Set(scope.split(' ')));
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      assert.equal(authorization.searchParams.get('state')?.length, 43);
      await controlCurrent();
      return { pending, authorization };
    };
    const callback = async (authorization: URL) => {
      const target = new URL(authorization.searchParams.get('redirect_uri')!);
      target.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'SYNTHETIC_EFFECT_CODE', iss: issuer }).toString();
      const revokeCallback = allowLocalTestHttp(target.origin);
      try {
        const response = await originalFetch(target);
        assert.equal(response.status, 200);
        visible.push(await response.text());
      } finally { revokeCallback(); }
    };
    const assertQuiet = async (requestCount: number) => {
      assert.equal(oauthRequests.length, requestCount, 'Effects, Disconnect and Connect must not initiate OAuth discovery or exchange');
      assert.equal((await settings()).status.authorization, undefined);
      await controlCurrent();
    };
    await host.start();
    assert.equal((await settings()).status.state, 'connected');
    assert.ok(discoveryReads > 0 && listReads > 0, 'Real SDK handshake and tools/list succeed without authentication');
    await assertQuiet(0);
    await effect('first-effect-401');
    assert.deepEqual(challenges, [401]);
    await assertQuiet(0);
    await action('disconnect');
    await action('connect');
    await assertQuiet(0);
    const first = await authorize('read');
    assert.equal(effectHeaders.length, 1, 'Explicit authorization cannot replay the first unknown effect');
    assert.ok(oauthRequests.includes(metadataPath), 'Authorization must consume the private effect challenge metadata URL');
    await callback(first.authorization);
    assert.equal((await completed()).operation?.state, 'succeeded');
    assert.equal(tokenGrants.length, 1);
    assert.equal(createHash('sha256').update(verifiers[0]!).digest('base64url'), first.authorization.searchParams.get('code_challenge'));
    assert.equal(effectHeaders.length, 1);
    await effect('new-read-effect', true);
    assert.equal(effectHeaders.at(-1), `Bearer ${readAccess}`);

    requiredScope = 'write';
    const beforeUpgrade = oauthRequests.length;
    await effect('later-effect-403');
    assert.deepEqual(challenges, [401, 403]);
    await assertQuiet(beforeUpgrade);
    await action('disconnect');
    await action('connect');
    await assertQuiet(beforeUpgrade);
    grantedScope = 'read write';
    const upgrade = await authorize('read write');
    assert.equal(tokenGrants.length, 1, 'Cached read credentials must not bypass new write consent');
    assert.equal(effectHeaders.length, 3);
    await callback(upgrade.authorization);
    assert.equal((await completed()).operation?.state, 'succeeded');
    assert.equal(tokenGrants.length, 2);
    assert.equal(createHash('sha256').update(verifiers[1]!).digest('base64url'), upgrade.authorization.searchParams.get('code_challenge'));
    assert.equal(effectHeaders.length, 3, 'Scope upgrade must not replay the challenged effect');
    await effect('new-write-effect', true);
    assert.equal(effectHeaders.at(-1), `Bearer ${writeAccess}`);

    // Start fresh so a cancelled exchange cannot be hidden by existing tokens.
    await action('forgetAuthorization');
    await action('connect');
    requiredScope = 'read';
    grantedScope = 'read';
    holdExchange = true;
    const beforeCancelled = oauthRequests.length;
    await effect('effect-before-cancelled-auth');
    await assertQuiet(beforeCancelled);
    const cancelled = await authorize('read');
    await callback(cancelled.authorization);
    const exchangeSignal = await exchangeStarted.promise;
    const privateRoot = path.join(root, 'extension-private');
    const privateDirectories = await readdir(privateRoot);
    assert.equal(privateDirectories.length, 1);
    const credentialFile = path.join(privateRoot, privateDirectories[0]!, 'credentials.json');
    const credentialsBeforeCancel = await readFile(credentialFile, 'utf8');
    assert.ok(!credentialsBeforeCancel.includes('access_token') && !credentialsBeforeCancel.includes('refresh_token":"'));
    assert.ok(cancelled.pending.operation);
    await host.cancelSettingsAction('remote', cancelled.pending.operation.id);
    assert.equal(exchangeSignal.aborted, true, 'Cancellation reaches the held official-SDK token exchange');
    releaseExchange.resolve();
    const cancelledView = await completed();
    assert.equal(cancelledView.operation?.state, 'cancelled');
    assert.equal(cancelledView.status.authorization, undefined);
    assert.equal(await readFile(credentialFile, 'utf8'), credentialsBeforeCancel, 'Late token response must not save any new credentials');
    assert.equal(effectHeaders.length, 5, 'Cancelled authorization must not replay the unknown effect');
    const afterCancellation = oauthRequests.length;
    await action('connect');
    await assertQuiet(afterCancellation);
    await effect('new-effect-after-cancel');
    assert.equal(effectHeaders.at(-1), undefined, 'Cancelled token response must not become a future bearer token');
    await assertQuiet(afterCancellation);
    assert.deepEqual(challenges, [401, 403, 401, 401]);
    const publicOutput = JSON.stringify({ visible, modelOutput, inspect: host.inspect(), diagnostics: host.diagnosticsLog(),
      config: await readFile(configurationFile, 'utf8'), logs });
    for (const secret of [readAccess, writeAccess, cancelledAccess, refresh, clientSecret, diagnostic, metadataPath,
      'insufficient_scope', 'invalid_token', 'resource_metadata', 'SYNTHETIC_EFFECT_CODE', ...verifiers]) {
      assert.ok(secret.length > 0);
      assert.ok(!publicOutput.includes(secret), 'Model/control/settings/configuration/diagnostics must not disclose private challenge or OAuth material');
    }
  } finally {
    releaseExchange.resolve();
    try { await host?.close(); } finally {
      try { await handler.close(); } finally {
        listener.closeAllConnections();
        await new Promise<void>(resolve => listener.close(() => resolve()));
        revoke();
        t.mock.restoreAll();
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});
