// Owner navigation proxy contract; invoked by browser-http.test.mts.
// Compiles production registerBrowserHttp and drives it with in-memory sockets.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
const require = createRequire(path.join(process.cwd(), 'package.json'));
const ts = require('typescript');
const scenario = process.argv[2] ?? 'owner';
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
const browser = { id: '11111111-1111-4111-8111-111111111111', epoch: 4, state: 'human', ownerLabel: 'Mira' };
let inputs = 0, calls = 0, finishVerify;
const navs = [];
const backend = {
  list: () => [browser], subscribe: () => () => {},
  stream: () => ++calls === 1 ? Promise.resolve('ws://127.0.0.1:12345') : new Promise(resolve => { finishVerify = () => resolve('ws://127.0.0.1:12345'); }),
  disconnect() {}, isHuman: () => true, invalidate() {}, reopen: async () => browser,
  humanInput: async () => { inputs++; },
  humanNavigate: async (_id, _epoch, action) => {
    navs.push(action);
    if (scenario === 'fatal') throw Error('navigation exploded');
    if (action.kind === 'tab') { const error = new Error('Browser navigation requires the current human control lease'); error.name = 'BrowserControlError'; throw error; }
    return browser;
  },
};
const reply = () => ({ code() { return this; }, send(value) { return value; } });
const flush = () => new Promise(resolve => setImmediate(resolve));
mod.exports.registerBrowserHttp(app, backend, new Map([['mira.example', 'https://mira.example']]));
try {
  const { ticket } = await routes.get('/api/browser/:id/ticket')({ params: { id: browser.id }, headers: {} }, reply());
  app.server.emit('upgrade', {
    method: 'GET', url: '/api/browser/stream', rawHeaders: ['Host', 'mira.example', 'Origin', 'https://mira.example'],
    headers: { host: 'mira.example', origin: 'https://mira.example', 'sec-websocket-protocol': `mira-browser, ${ticket}` },
  }, { end() { throw Error('Unexpected rejected ticket'); } }, Buffer.alloc(0));
  await flush();
  upstream.emit('open'); finishVerify(); await flush();
  if (scenario === 'owner') {
    const now = Date.now();
    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'tabs', timestamp: now, tabs: [
      { active: true, label: null, tabId: 't1', targetId: '3259', title: ' example.com ', type: 'page', url: 'https://example.com/' },
      { active: false, tabId: 'bad id', targetId: 'x', title: 'nope', url: 'https://example.com/nope' },
      { active: false, tabId: 't2', targetId: 'y', title: 'T'.repeat(250), url: 'javascript:alert(1)' },
      { active: false, tabId: 't3', targetId: 'z', title: 'file', url: 'file:///etc/passwd' },
      { active: false, tabId: 't4', targetId: 'c', title: 'creds', url: 'https://user:secret-pw@hidden.test/a' },
    ] })), false);
    // Same active page, title loaded later: list-only refresh, no new generation; an identical list is not resent.
    const titled = { type: 'tabs', timestamp: now, tabs: [{ active: true, tabId: 't1', targetId: '3259', title: 'Example Domain', url: 'https://example.com/' }] };
    upstream.emit('message', Buffer.from(JSON.stringify(titled)), false);
    upstream.emit('message', Buffer.from(JSON.stringify(titled)), false);
    const lists = client.messages.filter(item => item.type === 'tab_list');
    assert.equal(lists.length, 1); assert.equal(lists[0].tabs[0].title, 'Example Domain');
    assert.equal(lists[0].generation, client.messages.find(item => item.type === 'tabs').generation);
    upstream.emit('message', Buffer.from(JSON.stringify({ type: 'url', timestamp: now + 1, url: 'https://httpbin.org/html' })), false);
    const projected = client.messages.filter(item => item.type === 'tabs' || item.type === 'url');
    assert.equal(projected.length, 2);
    assert.deepEqual(projected[0].tabs.map(tab => tab.tabId), ['t1', 't2', 't3', 't4']);
    assert.equal(projected[0].tabs[0].title, 'example.com'); assert.equal(projected[0].tabs[0].url, 'https://example.com/'); assert.equal(projected[0].tabs[0].active, true);
    assert.equal(projected[0].tabs[1].title.length, 200); assert.equal(projected[0].tabs[1].url, null);
    assert.equal(projected[0].tabs[2].url, null); assert.equal(projected[0].tabs[3].url, null); assert.equal(projected[0].tabs[3].domain, 'hidden.test');
    assert.deepEqual(projected[1], { type: 'url', domain: 'httpbin.org', url: 'https://httpbin.org/html', generation: projected[1].generation });
    const wire = JSON.stringify(client.messages);
    assert.equal(wire.includes('secret-pw'), false); assert.equal(wire.includes('javascript:'), false); assert.equal(wire.includes('file:'), false);
    client.emit('message', Buffer.from(JSON.stringify({ type: 'nav_open', epoch: browser.epoch, url: 'https://example.org/' })), false);
    await flush();
    assert.deepEqual(navs, [{ kind: 'open', url: 'https://example.org/' }]);
    assert.equal(client.messages.some(item => item.type === 'nav_done'), true);
    client.emit('message', Buffer.from(JSON.stringify({ type: 'input_text', text: 'secret', epoch: browser.epoch, generation: 1, frameSeq: 1 })), false);
    await flush();
    assert.equal(inputs, 0, 'navigation does not require a frame, but input still does');
    assert.equal(client.ended, false);
    client.emit('message', Buffer.from(JSON.stringify({ type: 'nav_tab', epoch: browser.epoch, tabId: 't2' })), false);
    await flush();
    assert.equal(navs.length, 2); assert.deepEqual(navs[1], { kind: 'tab', tabId: 't2' });
    assert.equal(client.messages.some(item => item.type === 'nav_error' && item.message.includes('human control lease')), true);
    assert.equal(client.ended, false);
  } else if (scenario === 'fatal') {
    client.emit('message', Buffer.from(JSON.stringify({ type: 'nav_open', epoch: browser.epoch, url: 'https://example.org/' })), false);
    await flush(); await flush();
    assert.equal(navs.length, 1);
    assert.equal(client.messages.some(item => item.type === 'nav_error' && item.message === 'navigation exploded'), true);
    assert.equal(client.ended, true);
  } else if (scenario === 'malformed') {
    client.emit('message', Buffer.from(JSON.stringify({ type: 'nav_open', epoch: browser.epoch, url: 'https://example.org/', extra: true })), false);
    await flush();
    assert.equal(navs.length, 0);
    assert.equal(client.ended, true);
  } else throw Error(`Unknown scenario ${scenario}`);
} finally { for (const hook of hooks) await hook(); }
