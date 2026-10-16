import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { ExtensionCredentials } from '@mira/extension-sdk';
import {
  OAuthErrorCode, validateAuthorizationResponseIssuer,
  type OAuthClientInformationContext, type OAuthClientMetadata,
  type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens,
} from '@modelcontextprotocol/client';

const DEFAULT_CALLBACK_PORT = 37391;
const AUTH_TIMEOUT_MS = 5 * 60_000;
const MAX_CREDENTIAL_LENGTH = 16_384;
const MAX_KNOWN_ISSUERS = 32;
const failure = () => new Error('MCP authorization failed');
const cancelled = () => new DOMException('MCP authorization cancelled or expired', 'AbortError');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const key = (...parts: string[]) => `mcp_o_${createHash('sha256').update(JSON.stringify(parts)).digest('base64url')}`;

export interface OAuthSessionConfig {
  /** HTTP 127.0.0.1 for a browser on this computer, or explicitly configured HTTPS
   * routed by an existing user-managed proxy to this loopback callback path. */
  redirectUrl?: string;
  callbackPort?: number;
  /** Shorter values are useful for synthetic expiry tests. Never over five minutes. */
  timeoutMs?: number;
}

interface Attempt {
  controller: AbortController;
  server: Server;
  closed?: Promise<void>;
  state?: string | undefined;
  verifier?: string | undefined;
  discovery?: OAuthDiscoveryState | undefined;
  issuer?: string | undefined;
  redirected: boolean;
  consumed: boolean;
  delivered: boolean;
  callback: Promise<URLSearchParams>;
  resolve(params: URLSearchParams): void;
  reject(error: Error): void;
}

/** OAuth state and PKCE deliberately survive only the current action, not a restart.
 * The host credentials implementation provides the installation boundary. All
 * additional persistence keys bind the complete MCP URL and issuer. */
export class OAuthSession implements OAuthClientProvider {
  readonly provider: OAuthClientProvider = this;
  private readonly credentials: ExtensionCredentials;
  private readonly serverUrl: string;
  private readonly configuredRedirect: URL;
  private readonly callbackPort: number;
  private readonly timeoutMs: number;
  private readonly onAuthorization: (url: string | null) => void;
  private effectiveRedirect: URL;
  private attempt: Attempt | undefined;
  private forgetting: Promise<void> | undefined;

  constructor(credentials: ExtensionCredentials, serverUrl: string | URL, config: OAuthSessionConfig = {}, onAuthorization: (url: string | null) => void = () => {}) {
    this.credentials = credentials;
    const server = secureUrl(String(serverUrl), true);
    this.serverUrl = server.href;
    this.onAuthorization = onAuthorization;
    const explicitRedirect = config.redirectUrl ? secureUrl(config.redirectUrl, true) : undefined;
    if (explicitRedirect?.search || explicitRedirect?.hash || (explicitRedirect?.protocol === 'http:' && explicitRedirect.hostname !== '127.0.0.1')) throw failure();
    const port = config.callbackPort ?? (explicitRedirect?.protocol === 'http:' ? Number(explicitRedirect.port || 80) : DEFAULT_CALLBACK_PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure();
    if (explicitRedirect?.protocol === 'https:' && !port) throw failure();
    if (explicitRedirect?.protocol === 'http:' && Number(explicitRedirect.port || 80) !== port) throw failure();
    this.callbackPort = port;
    this.configuredRedirect = explicitRedirect ?? new URL(`http://127.0.0.1:${port}/oauth/callback`);
    this.effectiveRedirect = new URL(this.configuredRedirect);
    this.timeoutMs = config.timeoutMs ?? AUTH_TIMEOUT_MS;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > AUTH_TIMEOUT_MS) throw failure();
  }

  get redirectUrl(): URL { return new URL(this.effectiveRedirect); }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: 'Mira MCP plugin', redirect_uris: [this.redirectUrl.href],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' };
  }

  /** Explicit local reset only: no provider revocation or network requests.
   * Retain the write-ahead index until every referenced credential is removed,
   * so a failed/interrupted reset can safely be repeated after restart. */
  async forget(): Promise<void> {
    if (this.attempt) throw new Error('MCP authorization is still running');
    if (this.forgetting) return await this.forgetting;
    const task = this.forgetStored();
    this.forgetting = task;
    try { await task; }
    finally { if (this.forgetting === task) this.forgetting = undefined; }
  }

  /** Only an explicit protected-settings action may enter interactive auth. The
   * caller must use attemptSignal for its SDK transport fetch, await finishAuth,
   * and close its transports before returning. Callback parameters go directly
   * to the SDK's finishAuth(URLSearchParams), never to settings or model output. */
  async run<T>(signal: AbortSignal, operation: (provider: OAuthClientProvider, waitForCallback: () => Promise<URLSearchParams>, attemptSignal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.attempt || this.forgetting) throw new Error('MCP authorization is already running or being reset');
    if (signal.aborted) throw cancelled();
    const controller = new AbortController();
    const deferred = Promise.withResolvers<URLSearchParams>();
    // The callback can reject while SDK discovery is still running.
    void deferred.promise.catch(() => {});
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      this.receiveCallback(attempt, request.method, request.url, request.headers.host, response);
    });
    server.requestTimeout = 5000;
    server.headersTimeout = 5000;
    server.keepAliveTimeout = 1;
    server.maxRequestsPerSocket = 1;
    const attempt: Attempt = { controller, server, redirected: false, consumed: false, delivered: false,
      callback: deferred.promise, resolve: deferred.resolve, reject: deferred.reject };
    this.attempt = attempt;
    const stop = () => {
      controller.abort();
      attempt.state = undefined;
      attempt.verifier = undefined;
      attempt.reject(cancelled());
      void this.closeListener(attempt);
    };
    signal.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(stop, this.timeoutMs);
    try {
      await new Promise<void>((resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(cancelled()), { once: true });
        server.once('error', () => reject(new Error('MCP authorization callback listener could not start')));
        server.listen(this.callbackPort, '127.0.0.1', resolve);
      });
      this.assertActive(attempt);
      const address = server.address();
      if (!address || typeof address === 'string') throw failure();
      this.effectiveRedirect = new URL(this.configuredRedirect);
      if (this.configuredRedirect.protocol === 'http:' && !this.callbackPort) this.effectiveRedirect.port = String(address.port);
      const result = await operation(this.provider, async () => {
        this.assertActive(attempt);
        if (!attempt.redirected || attempt.delivered) throw failure();
        attempt.delivered = true;
        return await attempt.callback;
      }, controller.signal);
      this.assertActive(attempt);
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      stop();
      await this.closeListener(attempt);
      attempt.discovery = undefined;
      attempt.issuer = undefined;
      this.attempt = undefined;
      this.onAuthorization(null);
    }
  }

  state(): string {
    const attempt = this.active();
    if (attempt.redirected || attempt.consumed) throw failure();
    return attempt.state ??= randomBytes(32).toString('base64url');
  }
  saveCodeVerifier(verifier: string): void {
    const attempt = this.active();
    if (attempt.redirected || attempt.consumed || typeof verifier !== 'string' || !verifier.length) throw failure();
    attempt.verifier = verifier;
  }
  codeVerifier(): string {
    const attempt = this.active();
    if (!attempt.consumed || !attempt.verifier) throw failure();
    return attempt.verifier;
  }
  redirectToAuthorization(url: URL): void {
    const attempt = this.active();
    const target = secureUrl(url.href, false);
    if (attempt.redirected || attempt.consumed || !attempt.issuer || !attempt.verifier || !attempt.state ||
      target.searchParams.get('state') !== attempt.state || target.searchParams.get('redirect_uri') !== this.redirectUrl.href ||
      target.searchParams.get('code_challenge_method') !== 'S256' || !target.searchParams.get('code_challenge') ||
      ['code_verifier', 'client_secret', 'access_token', 'refresh_token', 'id_token', 'client_assertion', 'password'].some(name => target.searchParams.has(name))) throw failure();
    attempt.redirected = true;
    this.onAuthorization(target.href);
  }
  saveDiscoveryState(discovery: OAuthDiscoveryState): void {
    const attempt = this.active();
    const issuer = discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl;
    secureUrl(issuer, true);
    if (attempt.redirected && attempt.issuer !== issuer) throw failure();
    attempt.discovery = structuredClone(discovery);
    attempt.issuer = issuer;
  }
  discoveryState(): OAuthDiscoveryState | undefined {
    const attempt = this.active();
    return attempt.discovery ? structuredClone(attempt.discovery) : undefined;
  }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = this.issuer(ctx);
    const value = await this.read('client', issuer);
    return value as StoredOAuthClientInformation | undefined;
  }
  async saveClientInformation(value: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.save('client', value, ctx);
  }
  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    if (this.forgetting) throw new Error('MCP authorization is being reset');
    let issuer: string;
    if (ctx) issuer = this.issuer(ctx);
    else {
      const raw = await this.credentials.get(key(this.serverUrl, 'latest'));
      if (!raw) return undefined;
      let pointer: unknown;
      try { pointer = JSON.parse(raw); } catch { throw failure(); }
      if (!object(pointer) || pointer['server'] !== this.serverUrl || typeof pointer['issuer'] !== 'string') throw failure();
      issuer = pointer['issuer'];
    }
    return await this.read('tokens', issuer, !!ctx) as StoredOAuthTokens | undefined;
  }
  async saveTokens(value: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const attempt = this.active();
    const issuer = this.issuer(ctx);
    const client = await this.clientInformation(ctx);
    this.assertActive(attempt);
    if (!client) throw failure();
    await this.save('tokens', value, ctx, client.client_id);
    this.assertActive(attempt);
    await this.credentials.set(key(this.serverUrl, 'latest'), JSON.stringify({ server: this.serverUrl, issuer }));
    this.assertActive(attempt);
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const attempt = this.active();
    const issuer = attempt.issuer;
    if (scope === 'all' || scope === 'verifier') attempt.verifier = undefined;
    if (scope === 'all' || scope === 'discovery') { attempt.discovery = undefined; attempt.issuer = undefined; }
    // SDK invalidation has no context parameter. Use the active discovery issuer,
    // never the last bearer-token pointer (which may belong to a different AS).
    if (issuer && (scope === 'all' || scope === 'client')) await this.credentials.delete(key(this.serverUrl, issuer, 'client'));
    this.assertActive(attempt);
    if (issuer && (scope === 'all' || scope === 'tokens')) await this.credentials.delete(key(this.serverUrl, issuer, 'tokens'));
    this.assertActive(attempt);
  }

  private active(): Attempt {
    const attempt = this.attempt;
    if (!attempt) throw new Error('MCP authorization requires an explicit connect action');
    this.assertActive(attempt);
    return attempt;
  }
  private assertActive(attempt: Attempt): void {
    if (this.attempt !== attempt || attempt.controller.signal.aborted) throw cancelled();
  }
  private issuer(ctx?: OAuthClientInformationContext): string {
    const attempt = this.active();
    if (!attempt.issuer || (ctx && ctx.issuer !== attempt.issuer)) throw failure();
    return attempt.issuer;
  }
  private async read(kind: 'tokens' | 'client', issuer: string, forRefresh = false): Promise<Record<string, unknown> | undefined> {
    const raw = await this.credentials.get(key(this.serverUrl, issuer, kind));
    if (!raw) return undefined;
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { throw failure(); }
    if (!object(envelope) || envelope['server'] !== this.serverUrl || envelope['issuer'] !== issuer || !object(envelope['value']) || envelope['value']['issuer'] !== issuer) throw failure();
    if (kind === 'client' && envelope['redirect'] !== this.redirectUrl.href) return undefined;
    if (forRefresh) {
      const client = await this.read('client', issuer);
      if (!client || envelope['registration'] !== client['client_id']) return undefined;
    }
    return envelope['value'];
  }
  private async save(kind: 'tokens' | 'client', value: StoredOAuthTokens | StoredOAuthClientInformation, ctx?: OAuthClientInformationContext, registration?: string): Promise<void> {
    const attempt = this.active();
    const issuer = this.issuer(ctx);
    if (value.issuer !== issuer) throw failure();
    const raw = JSON.stringify({ server: this.serverUrl, issuer, ...(kind === 'client' ? { redirect: this.redirectUrl.href } : { registration }), value });
    if (raw.length > MAX_CREDENTIAL_LENGTH) throw failure();
    await this.rememberIssuer(issuer);
    this.assertActive(attempt);
    await this.credentials.set(key(this.serverUrl, issuer, kind), raw);
    this.assertActive(attempt);
  }
  private async knownIssuers(): Promise<string[]> {
    const issuers = new Set<string>();
    const raw = await this.credentials.get(key(this.serverUrl, 'issuers'));
    if (raw) {
      let index: unknown;
      try { index = JSON.parse(raw); } catch { throw failure(); }
      if (!object(index) || index['server'] !== this.serverUrl || !Array.isArray(index['issuers']) || index['issuers'].length > MAX_KNOWN_ISSUERS) throw failure();
      for (const issuer of index['issuers']) {
        if (typeof issuer !== 'string') throw failure();
        secureUrl(issuer, true);
        issuers.add(issuer);
      }
    }
    // A last-token pointer is also useful when a prior partial write left no
    // index. Never use a pointer from a different exact resource server URL.
    const latest = await this.credentials.get(key(this.serverUrl, 'latest'));
    if (latest) {
      let pointer: unknown;
      try { pointer = JSON.parse(latest); } catch { throw failure(); }
      if (!object(pointer) || pointer['server'] !== this.serverUrl || typeof pointer['issuer'] !== 'string') throw failure();
      secureUrl(pointer['issuer'], true);
      issuers.add(pointer['issuer']);
    }
    return [...issuers];
  }
  private async rememberIssuer(issuer: string): Promise<void> {
    const issuers = new Set(await this.knownIssuers());
    issuers.add(issuer);
    if (issuers.size > MAX_KNOWN_ISSUERS) throw failure();
    const raw = JSON.stringify({ server: this.serverUrl, issuers: [...issuers] });
    if (raw.length > MAX_CREDENTIAL_LENGTH) throw failure();
    await this.credentials.set(key(this.serverUrl, 'issuers'), raw);
  }
  private async forgetStored(): Promise<void> {
    this.onAuthorization(null);
    const issuers = await this.knownIssuers();
    for (const issuer of issuers) {
      await this.credentials.delete(key(this.serverUrl, issuer, 'client'));
      await this.credentials.delete(key(this.serverUrl, issuer, 'tokens'));
    }
    await this.credentials.delete(key(this.serverUrl, 'latest'));
    await this.credentials.delete(key(this.serverUrl, 'issuers'));
    this.effectiveRedirect = new URL(this.configuredRedirect);
  }
  private closeListener(attempt: Attempt): Promise<void> {
    return attempt.closed ??= new Promise(resolve => {
      attempt.server.close(() => resolve());
      attempt.server.closeAllConnections();
    });
  }
  private receiveCallback(attempt: Attempt, method: string | undefined, rawUrl: string | undefined, host: string | undefined, response: ServerResponse): void {
    const reply = (status: number, message: string) => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
        'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'", connection: 'close' });
      response.end(message);
    };
    if (this.attempt !== attempt || attempt.controller.signal.aborted || attempt.consumed) { reply(410, 'Authorization is no longer pending.'); return; }
    const address = attempt.server.address();
    const localHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    if (method !== 'GET' || !rawUrl?.startsWith('/') || rawUrl.startsWith('//') || rawUrl.length > 8192 ||
      (host !== localHost && host !== this.effectiveRedirect.host)) { reply(400, 'Invalid authorization callback.'); return; }
    let target: URL;
    try { target = new URL(rawUrl, 'http://127.0.0.1'); }
    catch { reply(400, 'Invalid authorization callback.'); return; }
    if (target.origin !== 'http://127.0.0.1') { reply(400, 'Invalid authorization callback.'); return; }
    const params = target.searchParams;
    if (target.pathname !== this.effectiveRedirect.pathname || !attempt.redirected || !attempt.state ||
      ['state', 'code', 'iss', 'error'].some(name => params.getAll(name).length > 1)) { reply(400, 'Invalid authorization callback.'); return; }
    const state = params.get('state');
    if (!state || Buffer.byteLength(state) !== Buffer.byteLength(attempt.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) {
      reply(400, 'Invalid authorization callback.'); return;
    }
    attempt.consumed = true;
    attempt.state = undefined;
    try {
      validateAuthorizationResponseIssuer({ iss: params.get('iss') ?? undefined, expectedIssuer: attempt.issuer,
        issParameterSupported: attempt.discovery?.authorizationServerMetadata?.authorization_response_iss_parameter_supported === true });
      const code = params.get('code');
      if (!code || params.has('error')) throw failure();
      const result = new URLSearchParams({ code });
      const issuer = params.get('iss');
      if (issuer !== null) result.set('iss', issuer);
      reply(200, 'Authorization received. You can return to Mira.');
      attempt.resolve(result);
    } catch {
      attempt.verifier = undefined;
      reply(400, 'Authorization could not be completed. Return to Mira and try again.');
      attempt.reject(failure());
    }
  }
}

function secureUrl(value: string, allowLoopback: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw failure(); }
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(allowLoopback && url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw failure();
  return url;
}

/** The SDK logs recoverable OAuth failures. Do not let provider error descriptions,
 * malformed error bodies, redirect URLs, or thrown network diagnostics enter those
 * logs. Successful protocol payloads remain untouched. */
export function safeOAuthFetch(fetchFn: typeof globalThis.fetch = globalThis.fetch, signal?: AbortSignal): typeof globalThis.fetch {
  const codes = new Set<string>(Object.values(OAuthErrorCode));
  return async (input, init) => {
    try {
      secureUrl(input instanceof Request ? input.url : String(input), true);
      const signals = [signal, init?.signal, input instanceof Request ? input.signal : undefined].filter((value): value is AbortSignal => !!value);
      const response = await fetchFn(input, { ...init, redirect: 'error', ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
      if (response.redirected || (response.status >= 300 && response.status < 400)) throw failure();
      // The SDK may log a JSON parse error or an OAuth error even when a token
      // endpoint incorrectly returns 2xx. Inspect only token-form responses; do
      // not parse or alter successful MCP streams or discovery documents.
      let tokenBody: unknown;
      if (response.ok && init?.body instanceof URLSearchParams && init.body.has('grant_type')) {
        tokenBody = await response.clone().json();
        if (!object(tokenBody) || !Object.hasOwn(tokenBody, 'error')) return response;
      } else if (response.ok) return response;
      let code = 'server_error';
      try { const body: unknown = tokenBody ?? await response.json(); if (object(body) && typeof body['error'] === 'string' && codes.has(body['error'])) code = body['error']; } catch { /* Never expose malformed provider bodies. */ }
      const headers = new Headers(response.headers);
      headers.set('content-type', 'application/json');
      headers.delete('content-length'); headers.delete('content-encoding'); headers.delete('set-cookie');
      return new Response(JSON.stringify({ error: code, error_description: 'OAuth request failed' }), { status: response.status, headers });
    } catch {
      if (signal?.aborted || init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) throw cancelled();
      throw new Error('MCP authorization network request failed');
    }
  };
}
