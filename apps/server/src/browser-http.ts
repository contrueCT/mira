import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { WebSocket, WebSocketServer } from 'ws';
import type { WebAccessAuth } from './web-auth.ts';

export interface BrowserView {
  id: string; state: string; epoch: number; ownerLabel: string; domain?: string | null; message?: string;
  lock?: 'outcome' | 'cleanup'; replacedBy?: string; replaces?: string;
}
export interface BrowserWebBackend {
  list(): BrowserView[];
  takeover(id: string): Promise<BrowserView>;
  release(id: string, epoch: number): Promise<BrowserView>;
  reopen(id: string, epoch: number): Promise<BrowserView>;
  disconnect(id: string, epoch: number): void;
  stream(id: string): string | Promise<string>;
  invalidate(id: string): void;
  humanInput(id: string, epoch: number, input: Record<string, unknown>, current: () => boolean): Promise<void>;
  humanNavigate(id: string, epoch: number, action: { kind: 'open'; url: string } | { kind: 'tab'; tabId: string }): Promise<BrowserView>;
  isHuman(id: string, epoch: number): boolean;
  subscribe(listener: (browser: BrowserView) => void): () => void;
}
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const empty = object({});
const params = object({ id: { type: 'string', format: 'uuid' } }, ['id']);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const domain = (value: unknown): string | null => {
  try { const url = new URL(String(value)); return ['https:', 'http:'].includes(url.protocol) ? url.hostname : null; } catch { return null; }
};
const finite = (value: unknown, limit: number): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const viewing = (browser: BrowserView) => !['closed', 'returning', 'requesting'].includes(browser.state) && (browser.state !== 'unknown' || browser.lock === 'outcome');
/** Frame and navigation channels are independent upstream. Arrival order is not capture order. */
export class BrowserFrameFence {
  generation = 0;
  #target: string | null = null;
  #url: string | null = null;
  #capturedAfter = 0;
  page(target: string, url: string, now = Date.now()): boolean {
    const targetKey = digest(target), urlKey = digest(url);
    if (this.#target === targetKey && this.#url === urlKey) return false;
    if (this.#target !== null) this.#capturedAfter = now;
    this.#target = targetKey; this.#url = urlKey; this.generation++; return true;
  }
  url(url: string, now = Date.now()): boolean {
    const key = digest(url); // Every upstream navigation event is a document boundary, even at the same URL.
    this.#url = key; this.#capturedAfter = now; this.generation++; return true;
  }
  accepts(timestamp: unknown): boolean { return this.#target !== null && typeof timestamp === 'number' && Number.isFinite(timestamp) && timestamp > this.#capturedAfter; }
}
const httpAddress = (value: unknown): string | null => {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null; return value; } catch { return null; }
};
const tabTitle = (value: unknown) => typeof value === 'string' ? value.trim().slice(0, 200) : '';
const sameKeys = (value: Record<string, unknown>, keys: readonly string[]) => { const actual = Object.keys(value); return actual.length === keys.length && keys.every(key => actual.includes(key)); };
/** Viewer-only http(s) page URL. Credentials and other schemes become null. Never log or persist this. */
export function browserPageUrl(value: unknown): { domain: string | null; url: string | null } { return { domain: domain(value), url: httpAddress(value) }; }
/** Viewer-only tab list. Invalid ids are dropped; titles are trimmed to 200 characters. */
export function browserTabs(value: unknown): Array<{ tabId: string; active: boolean; domain: string | null; url: string | null; title: string }> {
  if (!Array.isArray(value)) return [];
  const tabs: Array<{ tabId: string; active: boolean; domain: string | null; url: string | null; title: string }> = [];
  for (const item of value) {
    if (tabs.length >= 32) break;
    if (!item || typeof item !== 'object') continue;
    const tab = item as Record<string, unknown>;
    if (typeof tab.tabId !== 'string' || !/^[\w-]{1,128}$/.test(tab.tabId)) continue;
    tabs.push({ tabId: tab.tabId, active: tab.active === true, domain: domain(tab.url), url: httpAddress(tab.url), title: tabTitle(tab.title) });
  }
  return tabs;
}
/** Owner navigation payload. Null means the shape is invalid and the caller closes the socket. */
export function browserNavigation(value: Record<string, unknown>): { kind: 'open'; url: string } | { kind: 'tab'; tabId: string } | null {
  if (value.type === 'nav_open' && sameKeys(value, ['type', 'epoch', 'url']) && typeof value.url === 'string' && value.url.length <= 2048) return { kind: 'open', url: value.url };
  if (value.type === 'nav_tab' && sameKeys(value, ['type', 'epoch', 'tabId']) && typeof value.tabId === 'string' && /^[\w-]{1,128}$/.test(value.tabId)) return { kind: 'tab', tabId: value.tabId };
  return null;
}
/** Strict projection to the authenticated viewer: bounded frame/status plus http(s) URL and title. No commands, raw CDP, console, credentials, or arbitrary objects. */
export function browserInput(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const modifiers = v.modifiers ?? 0;
  if (!integer(modifiers) || modifiers > 15) return null;
  if (v.type === 'input_mouse') {
    if (!['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'].includes(String(v.eventType)) || !finite(v.x, 16384) || !finite(v.y, 16384) || v.x < 0 || v.y < 0) return null;
    if (!['none', 'left', 'middle', 'right'].includes(String(v.button ?? 'none')) || !integer(v.clickCount ?? 0) || Number(v.clickCount ?? 0) > 2 || !finite(v.deltaX ?? 0, 10000) || !finite(v.deltaY ?? 0, 10000)) return null;
    return { action: 'input_mouse', type: v.eventType, x: v.x, y: v.y, button: v.button ?? 'none', clickCount: v.clickCount ?? 0, deltaX: v.deltaX ?? 0, deltaY: v.deltaY ?? 0, modifiers };
  }
  if (v.type === 'input_release') {
    if (!['left', 'middle', 'right'].includes(String(v.button))) return null;
    return { action: 'input_mouse', type: 'mouseReleased', button: v.button };
  }
  if (v.type === 'input_text') {
    if (typeof v.text !== 'string' || !v.text || Buffer.byteLength(v.text) > 4096) return null;
    return { action: 'inserttext', text: v.text };
  }
  if (v.type === 'input_key') {
    if (typeof v.key !== 'string' || !/^(?:Enter|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Escape|[a-zA-Z0-9])$/.test(v.key)) return null;
    const chord = [modifiers & 1 ? 'Alt' : '', modifiers & 2 ? 'Control' : '', modifiers & 4 ? 'Meta' : '', modifiers & 8 ? 'Shift' : '', v.key].filter(Boolean).join('+');
    return { action: 'press', key: chord };
  }
  return null;
}
export function trustedBrowserUpgrade(request: IncomingMessage, origins: ReadonlyMap<string, string>): boolean {
  if (request.method !== 'GET' || request.url !== '/api/browser/stream') return false;
  const unique = new Set(['host', 'origin', 'cookie', 'sec-websocket-protocol', 'sec-websocket-key', 'sec-websocket-version']);
  const seen = new Set<string>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    if (unique.has(name) && seen.has(name)) return false;
    seen.add(name);
  }
  const origin = origins.get(request.headers.host ?? '');
  return !!origin && request.headers.origin === origin && (request.headers['sec-fetch-site'] === undefined || request.headers['sec-fetch-site'] === 'same-origin');
}
interface Ticket { id: string; epoch: number; cookie: string; expires: number }
interface Connection { browser: BrowserView; socket: WebSocket; upstream: WebSocket | null; cookie: string; inputOwner: boolean; closed: boolean }
/** Only the exact upgrade route is exempt from X-Mira-Client, via this independent guard. */
export function registerBrowserHttp(app: FastifyInstance, backend: BrowserWebBackend | undefined, origins: ReadonlyMap<string, string>, auth?: WebAccessAuth): void {
  const tickets = new Map<string, Ticket>();
  const connections = new Set<Connection>();
  const owners = new Map<string, Connection>();
  const server = new WebSocketServer({ noServer: true, maxPayload: 16_384, perMessageDeflate: false, handleProtocols: protocols => protocols.has('mira-browser') ? 'mira-browser' : false });
  const available = () => { if (!backend) throw Error('Browser service unavailable'); return backend; };
  const view = (id: string) => available().list().find(item => item.id === id);
  const close = (connection: Connection) => {
    if (connection.closed) return;
    connection.closed = true; connections.delete(connection);
    if (owners.get(connection.browser.id) === connection) { owners.delete(connection.browser.id); backend?.disconnect(connection.browser.id, connection.browser.epoch); }
    connection.upstream?.terminate(); connection.socket.close(1000, 'Browser connection ended');
    const timer = setTimeout(() => connection.socket.terminate(), 1000); timer.unref();
  };
  const send = (connection: Connection, value: unknown) => {
    if (connection.closed || connection.socket.readyState !== WebSocket.OPEN) return;
    if (connection.socket.bufferedAmount > 4 * 1024 * 1024) { close(connection); return; }
    connection.socket.send(JSON.stringify(value), error => { if (error) close(connection); });
  };
  const revoke = () => { tickets.clear(); for (const connection of [...connections]) close(connection); };
  const stopAuth = auth?.onChange(revoke);
  const stopState = backend?.subscribe(browser => {
    for (const connection of [...connections]) if (connection.browser.id === browser.id) {
      send(connection, { type: 'mira_state', browser });
      if (connection.browser.epoch !== browser.epoch || browser.state === 'returning' || browser.state === 'closed' || (browser.state === 'unknown' && !(browser.lock === 'outcome' && connection.browser.epoch === browser.epoch))) close(connection);
    }
  });
  app.get('/api/browser', { schema: { querystring: empty } }, async () => ({ browsers: backend?.list() ?? [] }));
  app.post<{ Params: { id: string } }>('/api/browser/:id/takeover', { schema: { params, querystring: empty, body: empty } }, async request => available().takeover(request.params.id));
  app.post<{ Params: { id: string }; Body: { epoch: number } }>('/api/browser/:id/return', { schema: { params, querystring: empty, body: object({ epoch: { type: 'integer', minimum: 0 } }, ['epoch']) } }, async request => available().release(request.params.id, request.body.epoch));
  app.post<{ Params: { id: string }; Body: { epoch: number } }>('/api/browser/:id/reopen', { schema: { params, querystring: empty, body: object({ epoch: { type: 'integer', minimum: 0 } }, ['epoch']) } }, async (request, reply) => { try { return await available().reopen(request.params.id, request.body.epoch); } catch (error) { if (error instanceof Error && error.name === 'BrowserControlError') return reply.code(409).send({ error: error.message }); throw error; } });
  app.post<{ Params: { id: string } }>('/api/browser/:id/ticket', { schema: { params, querystring: empty, body: empty } }, async (request, reply) => {
    const browser = view(request.params.id);
    if (!browser || !viewing(browser)) return reply.code(409).send({ error: 'Browser is not available for viewing' });
    for (const [key, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(key);
    if (tickets.size >= 32 || connections.size >= 16) return reply.code(429).send({ error: 'Too many browser connections' });
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(digest(ticket), { id: browser.id, epoch: browser.epoch, cookie: digest(request.headers.cookie ?? ''), expires: Date.now() + 15_000 });
    return { ticket, epoch: browser.epoch };
  });
  const reject = (socket: Duplex) => { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
  app.server.on('upgrade', (request, socket, head) => {
    if (!backend || !trustedBrowserUpgrade(request, origins) || (auth && !auth.status(request.headers.cookie).authenticated) || connections.size >= 16) { reject(socket); return; }
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map(value => value.trim());
    if (protocols?.length !== 2 || protocols[0] !== 'mira-browser' || !/^[A-Za-z0-9_-]{43}$/.test(protocols[1]!)) { reject(socket); return; }
    const key = digest(protocols[1]!); const ticket = tickets.get(key); tickets.delete(key);
    const browser = ticket ? view(ticket.id) : undefined;
    if (!ticket || ticket.expires <= Date.now() || ticket.cookie !== digest(request.headers.cookie ?? '') || !browser || ticket.epoch !== browser.epoch || !viewing(browser)) { reject(socket); return; }
    const inputOwner = browser.state === 'human';
    if (inputOwner && owners.has(browser.id)) { reject(socket); return; }
    server.handleUpgrade(request, socket, head, client => {
      const connection: Connection = { browser, socket: client, upstream: null, cookie: request.headers.cookie ?? '', inputOwner, closed: false };
      connections.add(connection); if (inputOwner) owners.set(browser.id, connection);
      send(connection, { type: 'mira_state', browser });
      client.on('error', () => close(connection)); client.on('close', () => close(connection));
      const fence = new BrowserFrameFence(); let frame: { seq: number; generation: number; width: number; height: number } | null = null; let rendered: { seq: number; generation: number; width: number; height: number } | null = null;
      let inputWindow = Date.now(); let inputCount = 0; let upstreamVerified = false;
      client.on('message', (data, binary) => {
        if (connection.closed || binary || !connection.upstream || connection.upstream.readyState !== WebSocket.OPEN || (auth && !auth.status(connection.cookie).authenticated)) { close(connection); return; }
        let value: Record<string, unknown>;
        try { value = JSON.parse(data.toString()) as Record<string, unknown>; } catch { close(connection); return; }
        if (!value || typeof value !== 'object' || Array.isArray(value)) { close(connection); return; }
        if (value.type === 'ack') {
          if (!frame || value.seq !== frame.seq) return;
          rendered = frame; connection.upstream.send(JSON.stringify({ type: 'ack', seq: frame.seq })); return;
        }
        const navigating = value.type === 'nav_open' || value.type === 'nav_tab';
        // Read-only and stale sockets ignore navigation the same way they ignore input.
        if (!upstreamVerified || !connection.inputOwner || owners.get(browser.id) !== connection || !backend.isHuman(browser.id, browser.epoch) || value.epoch !== browser.epoch) return;
        if (!navigating && (!rendered || rendered.generation !== fence.generation || value.generation !== fence.generation || value.frameSeq !== rendered.seq)) return;
        if (Date.now() - inputWindow >= 1000) { inputWindow = Date.now(); inputCount = 0; }
        if (++inputCount > 240) { close(connection); return; }
        if (navigating) {
          const action = browserNavigation(value);
          if (!action) { close(connection); return; }
          void backend.humanNavigate(browser.id, browser.epoch, action).then(() => send(connection, { type: 'nav_done' }), (error: unknown) => {
            send(connection, { type: 'nav_error', message: error instanceof Error && error.message ? error.message : 'Browser navigation failed' });
            if (!(error instanceof Error) || error.name !== 'BrowserControlError') close(connection);
          });
          return;
        }
        const input = browserInput(value);
        if (!input || !rendered || (input.action === 'input_mouse' && input.x !== undefined && (Number(input.x) > rendered.width || Number(input.y) > rendered.height))) { close(connection); return; }
        const generation = fence.generation;
        void backend.humanInput(browser.id, browser.epoch, input, () => !connection.closed && fence.generation === generation && (!auth || auth.status(connection.cookie).authenticated)).catch(() => close(connection));
      });
      void Promise.resolve(backend.stream(browser.id)).then(address => {
        if (connection.closed) return;
        const url = new URL(address);
        if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw Error('Invalid managed stream address');
        url.search = '?pacing=ack&maxFps=15';
        const upstream = new WebSocket(url, { maxPayload: 4 * 1024 * 1024, perMessageDeflate: false, handshakeTimeout: 5000 }); connection.upstream = upstream;
        upstream.on('error', () => close(connection)); upstream.on('close', () => close(connection));
        const pending: Array<{ data: string; binary: boolean }> = []; let pendingBytes = 0;
        upstream.on('open', () => {
          void Promise.resolve(backend.stream(browser.id)).then(current => {
            if (connection.closed || current !== address) { close(connection); return; }
            upstreamVerified = true; pendingBytes = 0; for (const message of pending.splice(0)) receive(message.data, message.binary);
          }).catch(() => close(connection));
        });
        upstream.on('message', (data, binary) => {
          if (!upstreamVerified) {
            if (binary) return;
            const text = data.toString(); let value: Record<string, unknown>;
            try { value = JSON.parse(text) as Record<string, unknown>; } catch { close(connection); return; }
            // Verification itself emits command/result traffic. Never retain it
            // (or console/input contents); only viewport events need ordered replay.
            if (!value || !['frame', 'url', 'tabs', 'status'].includes(String(value.type))) return;
            const bytes = Buffer.byteLength(text);
            if (pending.length >= 8 || pendingBytes + bytes > 8 * 1024 * 1024) { close(connection); return; }
            pendingBytes += bytes; pending.push({ data: text, binary: false }); return;
          }
          receive(data.toString(), binary);
        });
        const receive = (data: string, binary: boolean) => {
          if (binary || connection.closed) return;
          let value: Record<string, unknown>;
          try { value = JSON.parse(data.toString()) as Record<string, unknown>; } catch { close(connection); return; }
          if (!value || typeof value !== 'object' || Array.isArray(value)) return;
          if (value.type === 'frame') {
            const m = value.metadata as Record<string, unknown> | undefined;
            if (!integer(value.seq) || typeof value.data !== 'string' || value.data.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(value.data) || !m || !finite(m.deviceWidth, 16384) || !finite(m.deviceHeight, 16384) || m.deviceWidth <= 0 || m.deviceHeight <= 0) { close(connection); return; }
            if (!fence.accepts(m.timestamp)) { upstream.send(JSON.stringify({ type: 'ack', seq: value.seq })); return; }
            const generation = fence.generation;
            frame = { seq: value.seq, generation, width: m.deviceWidth, height: m.deviceHeight };
            send(connection, { type: 'frame', seq: value.seq, data: value.data, epoch: browser.epoch, generation, metadata: { deviceWidth: m.deviceWidth, deviceHeight: m.deviceHeight, timestamp: finite(m.timestamp, Number.MAX_SAFE_INTEGER) ? m.timestamp : 0 } });
          } else if (value.type === 'url' || value.type === 'tabs') {
            // Native emission time, not delayed proxy receipt time, separates
            // pre-navigation captures from a valid static destination frame.
            if (!integer(value.timestamp) || Number(value.timestamp) <= 0 || Number(value.timestamp) > Date.now() + 1000) { close(connection); return; }
            const emittedAt = Number(value.timestamp);
            let changed = false;
            if (value.type === 'url' && typeof value.url === 'string') changed = fence.url(value.url, emittedAt);
            if (value.type === 'tabs') {
              const tabs = Array.isArray(value.tabs) ? value.tabs as Array<Record<string, unknown>> : [];
              const active = tabs.find(tab => tab?.active === true);
              if (!active || typeof active.targetId !== 'string' || typeof active.url !== 'string') { backend.invalidate(browser.id); close(connection); return; }
              changed = fence.page(active.targetId, active.url, emittedAt);
            }
            if (!changed) return;
            if (frame) upstream.send(JSON.stringify({ type: 'ack', seq: frame.seq }));
            rendered = null; frame = null;
            const generation = fence.generation;
            if (value.type === 'url') send(connection, { type: 'url', ...browserPageUrl(value.url), generation });
            else send(connection, { type: 'tabs', generation, tabs: browserTabs(value.tabs) });
          } else if (value.type === 'status') {
            send(connection, { type: 'status', connected: value.connected === true, screencasting: value.screencasting === true, viewportWidth: finite(value.viewportWidth, 16384) ? value.viewportWidth : 0, viewportHeight: finite(value.viewportHeight, 16384) ? value.viewportHeight : 0 });
            if (value.connected === false) { backend.invalidate(browser.id); close(connection); }
          }
        };
      }).catch(() => close(connection));
    });
  });
  const expiry = setInterval(() => {
    for (const [key, ticket] of tickets) if (ticket.expires <= Date.now()) tickets.delete(key);
    for (const connection of [...connections]) if (auth && !auth.status(connection.cookie).authenticated) close(connection);
  }, 1000); expiry.unref();
  app.addHook('onClose', async () => { clearInterval(expiry); stopAuth?.(); stopState?.(); tickets.clear(); for (const connection of [...connections]) close(connection); server.close(); });
}
