import { WebAccessAuth, WebAuthError, type WebAuthWrite } from './web-auth.ts';
import { webPublicOrigin } from './web-config.ts';
import { AttachmentError, attachmentDescriptor, attachmentLimits, type AttachmentDescriptor } from './attachments.ts';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { HistoryError } from '@mira/life';
import { registerManagementHttp } from './management-http.ts';
import type { ManagementBackend } from './management.ts';
import type { ModelRetryStatus } from './model-retry.ts';
import { ModelRequestFailure } from './model-errors.ts';
import { PersistenceFailureNotice } from './persistence-errors.ts';
import { listBuiltinCatalog } from './model-catalog.ts';
import { ExternalProtocolError } from '@mira/external-sdk';
import { PersistenceError } from '@mira/persistence';
import { registerExternalHttp, type ExternalHttpOptions } from './external-http.ts';
import { parseWebConnectionWrite } from './web-model-config.ts';
import type { ModelDiscoveryResult } from './model-discovery.ts';
import { parseWebSettings, parseWebSettingsWrite, WebSettingsError, webSettingsMaxBytes, type WebSettings } from './web-settings.ts';

export interface WebBackend extends Partial<ManagementBackend> {
  status(): Promise<{ state: 'idle' | 'working' | 'error' | 'stopped'; mode: 'synthetic' | 'live'; model: string | null; error: string | ModelRequestFailure | PersistenceFailureNotice | null; modelRetry?: ModelRetryStatus | null }>;
  timeline(before?: string): Promise<{
    items: Array<{ id: string; externalEventId?: string; role: 'user' | 'assistant' | 'notice'; text: string; occurredAt: string; attachments?: AttachmentDescriptor[] }>;
    nextCursor: string | null;
  }>;
  uploadAttachment?(name: string, bytes: Uint8Array): Promise<AttachmentDescriptor>;
  readAttachment?(id: string): Promise<{ descriptor: AttachmentDescriptor; bytes: Uint8Array }>;
  submit(input: { id: string; text: string; occurredAt: string; attachmentIds?: string[] }): Promise<{ id: string; receipt: 'inserted' | 'duplicate' }>;
  settings(): Promise<WebSettings>;
  saveSettings(value: unknown): Promise<WebSettings>;
  discover(connection: unknown, signal?: AbortSignal): Promise<ModelDiscoveryResult>;
}
export class WebHttpError extends Error {
  readonly code: 'too_large' | 'busy' | 'conflict' | 'unavailable' | 'invalid_input';
  constructor(code: WebHttpError['code']) { super(code); this.name = 'WebHttpError'; this.code = code; }
}
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const noQuery = objectSchema({});
const identifier = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' };
const boundedName = { type: 'string', minLength: 1, maxLength: 512 };
const selectionSchema = { anyOf: [
  { type: 'null' },
  objectSchema({ kind: { const: 'builtin' }, provider: boundedName, model: boundedName }, ['kind', 'provider', 'model']),
  objectSchema({ kind: { const: 'custom' }, connection: boundedName, model: boundedName }, ['kind', 'connection', 'model']),
] };
const settingsSchema = objectSchema({ revision: { type: 'string', pattern: '^[a-f0-9]{64}$' }, configuration: { type: 'object' }, selection: selectionSchema }, ['revision', 'configuration', 'selection']);
const protectedError = 'Mira could not complete the operation. Check the local server and model configuration.';
const securityHeaders = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()', 'cache-control': 'private, no-store',
};
const safeErrors = {
  too_large: { status: 413, text: 'MEMORY.md exceeds the 1 MiB display limit. The original is unchanged; no partial content was returned.' },
  busy: { status: 409, text: 'Mira is working; retry when it is idle' },
  conflict: { status: 409, text: 'The request conflicts with previously saved data' },
  unavailable: { status: 503, text: 'Mira is unavailable; check the local server' },
  invalid_input: { status: 400, text: 'Invalid request' },
} as const;
/** Fastify composition only. The CLI owns binding and backend shutdown. */
export function createLocalHttp(options: { backend: WebBackend; port: number; assetsDirectory?: string; external?: ExternalHttpOptions; auth?: WebAccessAuth; publicOrigin?: string }): FastifyInstance {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) throw Error('A fixed local HTTP port from 1 to 65535 is required');
  const host = `127.0.0.1:${options.port}`; const origin = `http://${host}`;
  const publicOrigin = options.publicOrigin === undefined ? undefined : webPublicOrigin(options.publicOrigin);
  const origins = new Map([[host, origin]]);
  if (publicOrigin) {
    const publicHost = new URL(publicOrigin).host;
    if (publicHost === host && publicOrigin !== origin) throw Error('Public origin conflicts with the local HTTP origin');
    origins.set(publicHost, publicOrigin);
  }
  const secure = (request: FastifyRequest) => origins.get(request.headers.host ?? '')?.startsWith('https://') === true;
  const app = Fastify({
    logger: false, trustProxy: false, exposeHeadRoutes: false,
    bodyLimit: 65_536, connectionTimeout: 20_000, requestTimeout: 20_000, keepAliveTimeout: 5_000, maxRequestsPerSocket: 1_000,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    onProtoPoisoning: 'error', onConstructorPoisoning: 'error',
    // Malformed URLs can fail in the router before normal hooks/error handlers.
    frameworkErrors: (_error, request, reply: FastifyReply) => reply.headers(securityHeaders).code(origins.has(request.headers.host ?? '') ? 400 : 403).send({ error: 'Invalid local request' }),
  });
  const backend = options.backend;
  const externalSenders = new WeakMap<FastifyRequest, string>();
  const active = new WeakSet<FastifyRequest>(); let inFlight = 0;
  let interval = performance.now(); let reads = 0; let writes = 0; let discoveries = 0; let discovering = false;
  const methods = new Map<string, readonly string[]>([
    ['/api/auth/status', ['GET']], ['/api/auth/login', ['POST']], ['/api/auth/logout', ['POST']], ['/api/auth/settings', ['GET', 'PUT']],
    ['/api/attachments', ['POST']], ['/api/attachments/:id', ['GET']], ['/api/status', ['GET']], ['/api/timeline', ['GET', 'POST']], ['/api/messages', ['POST']], ['/api/settings', ['GET', 'PUT']],
    ['/api/memory', ['GET']], ['/api/messages/:id/status', ['GET']], ['/api/extensions', ['GET']], ['/api/extensions/:id', ['POST']], ['/api/extensions/:id/settings', ['GET', 'POST']], ['/api/extensions/:id/settings/actions', ['POST']], ['/api/extensions/:id/settings/cancel', ['POST']], ['/api/runs', ['GET']], ['/api/runs/:id', ['GET']], ['/api/runs/:id/requests', ['GET']],
    ['/api/models/catalog', ['GET']], ['/api/models/discover', ['POST']],
    ['/api/external/events', ['POST']], ['/api/external/wake', ['POST']], ['/api/external/notifications', ['POST']],
  ]);
  app.addHook('onRequest', async (request, reply) => {
    reply.headers(securityHeaders);
    const pathname = request.url.split('?', 1)[0] ?? '';
    const route = request.routeOptions.url;
    const api = pathname === '/api' || pathname.startsWith('/api/') || (typeof route === 'string' && route.startsWith('/api/'));
    const uniqueHeaders = new Set(['host', 'origin', 'x-mira-client', 'cookie']);
    const receivedHeaders = new Set<string>();
    for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
      const name = request.raw.rawHeaders[i]!.toLowerCase();
      if (uniqueHeaders.has(name) && receivedHeaders.has(name)) return reply.code(403).send({ error: 'Duplicate security header' });
      receivedHeaders.add(name);
    }
    // Exact configured authorities only; never trust arbitrary Host/Forwarded headers.
    const expectedOrigin = origins.get(request.headers.host ?? '');
    if (!expectedOrigin) return reply.code(403).send({ error: 'Untrusted host; configure MIRA_PUBLIC_ORIGIN for remote access' });
    const requestOrigin = request.headers.origin;
    if (requestOrigin !== undefined && requestOrigin !== expectedOrigin) return reply.code(403).send({ error: 'Untrusted origin' });
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return reply.code(403).send({ error: 'Cross-site requests are not allowed' });
    // Fastify decodes static route segments before matching. Reject encoded
    // aliases before any handler so raw-path classification cannot bypass API guards.
    if (pathname.includes('%')) return reply.code(400).send({ error: 'Use canonical local paths' });
    if (!api) return;
    const external = pathname === '/api/external' || pathname.startsWith('/api/external/');
    if (external) {
      if (request.headers.host !== host || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.ip)) return reply.code(403).send({ error: 'External programs require loopback access' });
      if (!options.external) return reply.code(404).send({ error: 'Not found' });
      if (requestOrigin !== undefined || site !== undefined || request.headers['sec-fetch-dest'] !== undefined
        || request.headers['x-mira-client'] !== 'external') return reply.code(403).send({ error: 'External programs only' });
      const mode = request.headers['sec-fetch-mode'];
      if (mode !== undefined && mode !== 'cors') return reply.code(403).send({ error: 'External programs only' });
      const protectedNames = new Set(['host', 'authorization', 'x-mira-sender', 'x-mira-client']);
      const seen = new Set<string>();
      for (let index = 0; index < request.raw.rawHeaders.length; index += 2) {
        const name = request.raw.rawHeaders[index]!.toLowerCase();
        if (protectedNames.has(name) && seen.has(name)) return reply.code(403).send({ error: 'Invalid external credentials' });
        seen.add(name);
      }
      const allowed = methods.get(pathname) ?? (typeof route === 'string' ? methods.get(route) : undefined);
      if (allowed && !allowed.includes(request.method)) return reply.code(405).header('allow', allowed.join(', ')).send({ error: 'Method not allowed' });
      if (!/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(request.headers['content-type'] ?? '')) return reply.code(415).send({ error: 'JSON content type is required' });
      const now = performance.now();
      if (now - interval >= 60_000) { interval = now; reads = 0; writes = 0; discoveries = 0; }
      if (inFlight >= 32 || ++writes > 60) return reply.code(429).header('retry-after', '60').send({ error: 'Too many local requests; retry shortly' });
      active.add(request); inFlight++;
      const sender = request.headers['x-mira-sender']; const authorization = request.headers.authorization;
      if (typeof sender !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(sender)
        || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) return reply.code(401).send({ error: 'Invalid external credentials' });
      let authenticated: boolean;
      try { authenticated = await options.external.access.authenticate(sender, authorization.slice(7)); }
      catch { return reply.code(503).send({ error: 'External access configuration is unavailable' }); }
      if (!authenticated) return reply.code(401).send({ error: 'Invalid external credentials' });
      externalSenders.set(request, sender);
      return;
    }
    if (request.headers['x-mira-client'] !== 'web') return reply.code(403).send({ error: 'The local web client header is required' });
    const mode = request.headers['sec-fetch-mode']; const destination = request.headers['sec-fetch-dest'];
    if ((mode !== undefined && mode !== 'cors' && mode !== 'same-origin') || (destination !== undefined && destination !== 'empty')) return reply.code(403).send({ error: 'Only local API fetches are allowed' });
    const extensionSettingsRoute = /^\/api\/extensions\/[A-Za-z][A-Za-z0-9_-]*\/settings(?:\/(actions|cancel))?$/.exec(pathname);
    const allowed = methods.get(pathname) ?? (typeof route === 'string' ? methods.get(route) : undefined)
      ?? (extensionSettingsRoute ? (extensionSettingsRoute[1] ? ['POST'] : ['GET', 'POST']) : undefined);
    if (allowed && !allowed.includes(request.method)) return reply.code(405).header('allow', allowed.join(', ')).send({ error: 'Method not allowed' });
    const write = request.method !== 'GET' && request.method !== 'HEAD';
    if (write && requestOrigin !== expectedOrigin) return reply.code(403).send({ error: 'A same-origin write is required' });
    if (write && pathname === '/api/attachments' && request.headers['content-type'] !== 'application/octet-stream') return reply.code(415).send({ error: 'Binary content type is required' });
    if (write && pathname !== '/api/attachments' && !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu.test(request.headers['content-type'] ?? '')) return reply.code(415).send({ error: 'JSON content type is required' });
    const publicAuthRoute = pathname === '/api/auth/status' || pathname === '/api/auth/login';
    if (!publicAuthRoute && options.auth && !options.auth.status(request.headers.cookie).authenticated) return reply.code(401).send({ error: 'Please sign in to Mira' });
    const now = performance.now();
    if (now - interval >= 60_000) { interval = now; reads = 0; writes = 0; discoveries = 0; }
    if (inFlight >= 32 || (write ? ++writes > 60 : ++reads > 600) || (pathname === '/api/models/discover' && ++discoveries > 6)) return reply.code(429).header('retry-after', '60').send({ error: 'Too many local requests; retry shortly' });
    active.add(request); inFlight++;
  });
  const release = async (request: FastifyRequest): Promise<void> => { if (active.delete(request)) inFlight--; };
  app.addHook('onResponse', release);
  app.addHook('onRequestAbort', release);
  app.addHook('onTimeout', release);
  app.setErrorHandler((error: Error & { statusCode?: number; validation?: unknown }, _request, reply) => {
    if (error instanceof AttachmentError) return reply.code(error.code === 'too_large' ? 413 : error.code === 'invalid' ? 400 : 404).send({ error: error.code === 'too_large' ? 'Attachment exceeds the file or message size limit' : 'Attachment unavailable or invalid' });
    if (error instanceof HistoryError && error.code === 'invalid') return reply.code(400).send({ error: 'Invalid history request' });
    if (error instanceof HistoryError && error.code === 'too_large') return reply.code(413).send({ error: 'The durable record exceeds the display limit; the original is preserved' });
    if (error instanceof WebAuthError) { if (error.status === 429) reply.header('retry-after', '60'); return reply.code(error.status).send({ error: error.message }); }
    if (error instanceof ExternalProtocolError) return reply.code(400).send({ error: 'Invalid external request' });
    if (error instanceof PersistenceError && error.code === 'duplicate') return reply.code(409).send({ error: 'The request conflicts with previously saved data' });
    const persistence = PersistenceFailureNotice.from(error);
    if (persistence) return reply.code(503).send({ error: PersistenceFailureNotice.text(persistence) });
    if (error instanceof WebHttpError) { const safe = safeErrors[error.code]; return reply.code(safe.status).send({ error: safe.text }); }
    if (error instanceof WebSettingsError) {
      const status = error.code === 'invalid_settings' ? 400 : error.code === 'settings_conflict' ? 409 : 500;
      return reply.code(status).send({ error: new WebSettingsError(error.code).message });
    }
    if (error.validation || error.statusCode === 400) return reply.code(400).send({ error: 'Invalid request' });
    if (error.statusCode === 413) return reply.code(413).send({ error: 'Request body is too large' });
    if (error.statusCode === 415) return reply.code(415).send({ error: 'JSON content type is required' });
    return reply.code(500).send({ error: protectedError });
  });
  if (options.external) registerExternalHttp(app, options.external.ingress, request => {
    const sender = externalSenders.get(request);
    if (!sender) throw new WebHttpError('unavailable');
    return sender;
  });
  app.get('/api/auth/status', { schema: { querystring: noQuery } }, async request => options.auth?.status(request.headers.cookie) ?? { enabled: false, authenticated: true });
  app.post<{ Body: { password: string } }>('/api/auth/login', { bodyLimit: 4096, schema: { querystring: noQuery, body: objectSchema({ password: { type: 'string', maxLength: 1024 } }, ['password']) } }, async (request, reply) => {
    if (!options.auth) throw new WebAuthError(503, 'Web access settings are unavailable');
    const cookie = await options.auth.login(request.body.password, request.ip, secure(request));
    return reply.header('set-cookie', cookie).send({ enabled: true, authenticated: true });
  });
  app.post('/api/auth/logout', { schema: { querystring: noQuery, body: noQuery } }, async (request, reply) => {
    if (!options.auth) throw new WebAuthError(503, 'Web access settings are unavailable');
    return reply.header('set-cookie', options.auth.logout(request.headers.cookie, secure(request))).send(options.auth.status());
  });
  app.get('/api/auth/settings', { schema: { querystring: noQuery } }, async () => {
    if (!options.auth) throw new WebAuthError(503, 'Web access settings are unavailable');
    return options.auth.settings();
  });
  app.put<{ Body: WebAuthWrite }>('/api/auth/settings', { bodyLimit: 8192, schema: { querystring: noQuery, body: objectSchema({ revision: { type: 'string', format: 'uuid' }, enabled: { type: 'boolean' }, currentPassword: { type: 'string', maxLength: 1024 }, password: { type: 'string', maxLength: 1024 } }, ['revision', 'enabled']) } }, async (request, reply) => {
    if (!options.auth) throw new WebAuthError(503, 'Web access settings are unavailable');
    const cookie = await options.auth.save(request.body, request.headers.cookie, request.ip, secure(request));
    return reply.header('set-cookie', cookie).send({ ...options.auth.settings(), authenticated: true });
  });
  registerManagementHttp(app, backend);
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'Not found' }));
  app.get('/api/status', { schema: { querystring: noQuery } }, async () => {
    const result = await backend.status();
    return { state: result.state, mode: result.mode, model: result.model, ...(result.modelRetry ? { modelRetry: { phase: result.modelRetry.phase, attempt: result.modelRetry.attempt, maxAttempts: result.modelRetry.maxAttempts, delayMs: result.modelRetry.delayMs, reason: result.modelRetry.reason } } : {}), error: result.error === null ? null : result.error instanceof ModelRequestFailure ? result.error.message : PersistenceFailureNotice.text(result.error) ?? protectedError };
  });
  app.get<{ Querystring: { before?: string } }>('/api/timeline', {
    schema: { querystring: objectSchema({ before: { type: 'string', minLength: 1, maxLength: 2_048, pattern: '^[A-Za-z0-9_=-]+$' } }) },
  }, async request => {
    const result = await backend.timeline(request.query.before);
    return {
      items: result.items.map(item => ({ id: item.id, role: item.role, text: item.text, occurredAt: item.occurredAt, ...(item.attachments?.length ? { attachments: item.attachments.map(attachmentDescriptor) } : {}), ...(item.role === 'user' && item.externalEventId !== undefined ? { externalEventId: item.externalEventId } : {}) })),
      nextCursor: result.nextCursor,
    };
  });
  // Large history IDs belong in a bounded body, not a request URL/header line.
  app.post<{ Body: { before: string } }>('/api/timeline', {
    bodyLimit: 600_000,
    schema: { querystring: noQuery, body: objectSchema({ before: { type: 'string', minLength: 1, maxLength: 524_288, pattern: '^[A-Za-z0-9_=-]+$' } }, ['before']) },
  }, async request => {
    const result = await backend.timeline(request.body.before);
    return { items: result.items.map(item => ({ id: item.id, role: item.role, text: item.text, occurredAt: item.occurredAt, ...(item.attachments?.length ? { attachments: item.attachments.map(attachmentDescriptor) } : {}), ...(item.role === 'user' && item.externalEventId !== undefined ? { externalEventId: item.externalEventId } : {}) })), nextCursor: result.nextCursor };
  });
  app.post<{ Body: { id: string; text: string; occurredAt: string; attachmentIds?: string[] } }>('/api/messages', {
    schema: { querystring: noQuery, body: objectSchema({ id: identifier, text: { type: 'string', maxLength: 65_536 }, attachmentIds: { type: 'array', maxItems: 10, uniqueItems: true, items: { type: 'string', format: 'uuid' } }, occurredAt: { type: 'string', format: 'date-time', maxLength: 40 } }, ['id', 'text', 'occurredAt']) },
  }, async (request, reply) => {
    if ((!request.body.text.trim() && !request.body.attachmentIds?.length) || Buffer.byteLength(request.body.text) > 65_536 || !Number.isFinite(Date.parse(request.body.occurredAt))) throw new WebHttpError('invalid_input');
    const result = await backend.submit({ id: request.body.id, text: request.body.text, occurredAt: request.body.occurredAt, ...(request.body.attachmentIds ? { attachmentIds: request.body.attachmentIds } : {}) });
    return reply.code(result.receipt === 'inserted' ? 201 : 200).send({ id: result.id, receipt: result.receipt });
  });
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: attachmentLimits.file }, (_request, body, done) => done(null, body));
  app.post<{ Querystring: { name: string }; Body: Buffer }>('/api/attachments', {
    bodyLimit: attachmentLimits.file, schema: { querystring: objectSchema({ name: { type: 'string', minLength: 1, maxLength: 255 } }, ['name']) },
  }, async (request, reply) => {
    if (!backend.uploadAttachment || !Buffer.isBuffer(request.body)) throw new WebHttpError('invalid_input');
    return reply.code(201).send(attachmentDescriptor(await backend.uploadAttachment(request.query.name, request.body)));
  });
  app.get<{ Params: { id: string } }>('/api/attachments/:id', {
    schema: { querystring: noQuery, params: objectSchema({ id: { type: 'string', format: 'uuid' } }, ['id']) },
  }, async (request, reply) => {
    if (!backend.readAttachment) throw new WebHttpError('unavailable');
    const result = await backend.readAttachment(request.params.id); const descriptor = attachmentDescriptor(result.descriptor);
    return reply.type(descriptor.mimeType).header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(descriptor.name).replace(/['()*]/g, character => '%' + character.charCodeAt(0).toString(16))}`).send(Buffer.from(result.bytes));
  });
  app.get('/api/settings', { schema: { querystring: noQuery } }, async () => parseWebSettings(await backend.settings()));
  app.put('/api/settings', { bodyLimit: webSettingsMaxBytes, schema: { querystring: noQuery, body: settingsSchema } }, async request => {
    const settings = parseWebSettingsWrite(request.body);
    return parseWebSettings(await backend.saveSettings(settings));
  });
  app.get('/api/models/catalog', { schema: { querystring: noQuery } }, async () => listBuiltinCatalog());
  app.post<{ Body: { connection: unknown } }>('/api/models/discover', {
    bodyLimit: webSettingsMaxBytes,
    schema: { querystring: noQuery, body: objectSchema({ connection: { type: 'object' } }, ['connection']) },
  }, async request => {
    let connection;
    try { connection = parseWebConnectionWrite(request.body.connection); }
    catch { throw new WebHttpError('invalid_input'); }
    if (!connection) throw new WebHttpError('invalid_input');
    if (discovering) throw new WebHttpError('busy');
    discovering = true;
    const controller = new AbortController(); const abort = (): void => controller.abort();
    request.raw.once('aborted', abort);
    const timer = setTimeout(abort, 16_000);
    try {
      const result = await backend.discover(connection, controller.signal);
      return { endpoint: result.endpoint, models: result.models.map(model => ({ id: model.id, ...(model.name === undefined ? {} : { name: model.name }) })) };
    } finally { clearTimeout(timer); request.raw.removeListener('aborted', abort); discovering = false; }
  });
  if (options.assetsDirectory !== undefined) {
    if (!path.isAbsolute(options.assetsDirectory)) throw Error('Assets directory must be absolute');
    const directory = path.resolve(options.assetsDirectory);
    app.register(fastifyStatic, { root: directory, serve: false, dotfiles: 'deny', cacheControl: false, acceptRanges: false, etag: false, lastModified: false, index: false });
    const asset = async (relative: string): Promise<void> => {
      if ((await lstat(directory)).isSymbolicLink()) throw new WebHttpError('invalid_input');
      const root = await realpath(directory);
      const parts = relative.split('/');
      if (parts.some(part => !part || part.startsWith('.') || part.includes('\\'))) throw new WebHttpError('invalid_input');
      let current = root;
      for (const part of parts) {
        current = path.join(current, part);
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new WebHttpError('invalid_input');
      }
      const info = await lstat(current);
      if (!info.isFile()) throw new WebHttpError('invalid_input');
    };
    app.get('/', { schema: { querystring: noQuery } }, async (_request, reply) => { await asset('index.html'); return reply.sendFile('index.html'); });
    app.get<{ Params: { '*': string } }>('/assets/*', async (request, reply) => {
      const relative = `assets/${request.params['*']}`;
      try { await asset(relative); } catch { return reply.code(404).send({ error: 'Not found' }); }
      return reply.sendFile(relative);
    });
  }
  return app;
}
