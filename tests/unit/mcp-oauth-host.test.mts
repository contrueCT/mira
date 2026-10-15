import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
            : { 'WWW-Authenticate': `Bearer error="${effectMode === 'scope' ? 'insufficient_scope' : 'invalid_token'}", scope="read write admin", resource_metadata="${issuer}/resource", error_description="${diagnostic}"` });
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
      assert.ok(listChallenges >= 2, 'Startup and explicit authorization must reach the protected list after public discovery');
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
