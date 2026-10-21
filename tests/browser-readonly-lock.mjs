// Read-only locked stream contract; invoked by browser-http.test.mts.
// Compiles production registerBrowserHttp and drives it with in-memory sockets.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const ts = require('typescript');
let upstream;
class Socket extends EventEmitter {
  static OPEN = 1; readyState = 1; bufferedAmount = 0; messages = []; ended = false;
  constructor(url) { super(); if (url) upstream = this; }
  send(data, callback) { this.messages.push(JSON.parse(data)); callback?.(); }
  close() { this.ended = true; this.readyState = 3; this.emit('close'); }
  terminate() { this.close(); }
}
const client = new Socket();
class Server {
  handleUpgrade(_request, _socket, _head, callback) { callback(client); }
  close() {}
}
const source = fs.readFileSync('apps/server/src/browser-http.ts', 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const mod = { exports: {} };
new Function('require', 'exports', 'module', compiled)(name => name === 'ws' ? { WebSocket: Socket, WebSocketServer: Server } : require(name), mod.exports, mod);
const routes = new Map(), hooks = [];
const app = { server: new EventEmitter(), get() {}, post(route, _options, handler) { routes.set(route, handler); }, addHook(_name, callback) { hooks.push(callback); } };
const browser = { id: '11111111-1111-4111-8111-111111111111', epoch: 4, state: 'unknown', lock: 'outcome', ownerLabel: 'Mira' };
let inputs = 0, navs = 0, calls = 0, finishVerify;
const backend = {
  list: () => [browser], subscribe: () => () => {},
  stream: () => ++calls === 1 ? Promise.resolve('ws://127.0.0.1:12345') : new Promise(resolve => { finishVerify = () => resolve('ws://127.0.0.1:12345'); }),
  disconnect() {}, isHuman: () => true, invalidate() {}, reopen: async () => browser,
  humanInput: async () => { inputs++; throw Error('read-only connection forwarded input'); },
  humanNavigate: async () => { navs++; throw Error('read-only connection forwarded navigation'); },
};
const reply = () => ({ code() { return this; }, send(value) { return value; } });
mod.exports.registerBrowserHttp(app, backend, new Map([['mira.example', 'https://mira.example']]));
try {
  const { ticket } = await routes.get('/api/browser/:id/ticket')({ params: { id: browser.id }, headers: {} }, reply());
  const headers = { host: 'mira.example', origin: 'https://mira.example', 'sec-websocket-protocol': `mira-browser, ${ticket}` };
  const upgrade = { method: 'GET', url: '/api/browser/stream', rawHeaders: ['Host', 'mira.example', 'Origin', 'https://mira.example'], headers };
  app.server.emit('upgrade', upgrade, { end() { throw Error('Unexpected rejected outcome ticket'); } }, Buffer.alloc(0));
  await new Promise(resolve => setImmediate(resolve));
  upstream.emit('open'); finishVerify(); await new Promise(resolve => setImmediate(resolve));
  const now = Date.now();
  upstream.emit('message', Buffer.from(JSON.stringify({ type: 'tabs', timestamp: now, tabs: [{ targetId: 'active', active: true, url: 'https://example.test/' }] })), false);
  upstream.emit('message', Buffer.from(JSON.stringify({ type: 'frame', seq: 1, data: 'YQ==', metadata: { deviceWidth: 8, deviceHeight: 8, timestamp: now + 1 } })), false);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'ack', seq: 1 })), false);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'input_text', text: 'secret', epoch: browser.epoch, generation: 1, frameSeq: 1 })), false);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'input_mouse', eventType: 'mousePressed', x: 1, y: 1, button: 'left', clickCount: 1, epoch: browser.epoch, generation: 1, frameSeq: 1 })), false);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'nav_open', epoch: browser.epoch, url: 'https://example.org/' })), false);
  client.emit('message', Buffer.from(JSON.stringify({ type: 'nav_tab', epoch: browser.epoch, tabId: 't2' })), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(inputs, 0, 'a read-only lock must not forward input');
  assert.equal(navs, 0, 'a read-only lock must not forward navigation');
  assert.equal(client.ended, false);
  assert.equal(client.messages.some(item => item.type === 'frame'), true);
  const minted = await routes.get('/api/browser/:id/ticket')({ params: { id: browser.id }, headers: {} }, reply());
  browser.lock = 'cleanup';
  const denied = { status: 200, body: undefined, code(status) { this.status = status; return this; }, send(value) { this.body = value; return value; } };
  await routes.get('/api/browser/:id/ticket')({ params: { id: browser.id }, headers: {} }, denied);
  assert.equal(denied.status, 409); assert.equal(denied.body.error, 'Browser is not available for viewing');
  let rejected = false;
  app.server.emit('upgrade', { ...upgrade, headers: { ...headers, 'sec-websocket-protocol': `mira-browser, ${minted.ticket}` } }, { end() { rejected = true; } }, Buffer.alloc(0));
  assert.equal(rejected, true, 'cleanup lock must not upgrade');
} finally { for (const hook of hooks) await hook(); }
