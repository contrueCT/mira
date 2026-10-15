// In-memory production proxy contract; invoked by browser-http.test.mts.
// This executes unchanged production registerBrowserHttp with in-memory WebSocket
// doubles. It creates no sockets and starts no browser or daemon.
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
const browser = { id: '11111111-1111-4111-8111-111111111111', epoch: 1, state: 'human', ownerLabel: 'Mira' };
let calls = 0, disconnects = 0, finishVerify;
const backend = {
  list: () => [browser], subscribe: () => () => {},
  stream: () => ++calls === 1 ? Promise.resolve('ws://127.0.0.1:12345') : new Promise(resolve => { finishVerify = () => resolve('ws://127.0.0.1:12345'); }),
  disconnect: () => { disconnects++; }, isHuman: () => true, invalidate() {}, humanInput: async () => {},
};
mod.exports.registerBrowserHttp(app, backend, new Map([['mira.example', 'https://mira.example']]));
try {
  const { ticket } = await routes.get('/api/browser/:id/ticket')({ params: { id: browser.id }, headers: {} }, { code() { return this; }, send(value) { return value; } });
  app.server.emit('upgrade', {
    method: 'GET', url: '/api/browser/stream', rawHeaders: ['Host', 'mira.example', 'Origin', 'https://mira.example'],
    headers: { host: 'mira.example', origin: 'https://mira.example', 'sec-websocket-protocol': `mira-browser, ${ticket}` },
  }, { end() { throw Error('Unexpected rejected ticket'); } }, Buffer.alloc(0));
  await new Promise(resolve => setImmediate(resolve));
  upstream.emit('open');
  const tabs = { type: 'tabs', timestamp: Date.now(), tabs: [{ targetId: 'active', active: true, url: 'https://example.test/' }] };
  // Pinned upstream sends status/tabs/seed, then command/result/tabs for each
  // of the two stream_status commands in the post-connect identity recheck.
  const events = [
    { type: 'status', connected: true }, tabs,
    { type: 'frame', seq: 1, data: 'YQ==', metadata: { deviceWidth: 100, deviceHeight: 100, timestamp: Date.now() } },
  ];
  for (let i = 0; i < 2; i++) events.push({ type: 'command', action: 'stream_status' }, { type: 'result', action: 'stream_status' }, tabs);
  for (let i = 0; i < 40; i++) events.push({ type: 'console', text: 'synthetic private content' });
  const scenario = process.argv[2] ?? 'normal';
  if (scenario === 'count') for (let i = 0; i < 9; i++) events.push(tabs);
  if (scenario === 'bytes') for (let i = 0; i < 2; i++) events.push({ type: 'frame', data: 'A'.repeat(4 * 1024 * 1024) });
  let closedOn = null;
  for (const [index, event] of events.entries()) {
    upstream.emit('message', Buffer.from(JSON.stringify(event)), false);
    if (client.ended) { closedOn = index + 1; break; }
  }
  assert.deepEqual(client.messages.map(item => item.type), ['mira_state'], 'No upstream data escapes before identity verification');
  if (scenario !== 'normal') {
    assert.notEqual(closedOn, null, 'Required viewport events remain bounded');
    assert.equal(disconnects, 1);
  } else {
    assert.equal(closedOn, null, 'Official verification chatter must not close the connection');
    assert.equal(disconnects, 0);
    finishVerify(); await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(client.messages.map(item => item.type), ['mira_state', 'status', 'tabs', 'frame']);
    assert.equal(JSON.stringify(client.messages).includes('synthetic private content'), false);
    assert.equal(client.ended, false);
  }
} finally { for (const hook of hooks) await hook(); }
