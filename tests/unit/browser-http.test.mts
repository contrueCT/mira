import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage } from 'node:http';
import { BrowserFrameFence, browserInput, trustedBrowserUpgrade } from '../../apps/server/src/browser-http.ts';

const origins = new Map([['127.0.0.1:3210', 'http://127.0.0.1:3210'], ['mira.example', 'https://mira.example']]);
const request = (patch: Partial<IncomingMessage> = {}) => ({ method: 'GET', url: '/api/browser/stream', rawHeaders: ['Host', 'mira.example', 'Origin', 'https://mira.example'], headers: { host: 'mira.example', origin: 'https://mira.example' }, ...patch }) as IncomingMessage;
test('browser upgrade requires canonical path and exact configured origin/host', () => {
  assert.equal(trustedBrowserUpgrade(request(), origins), true);
  for (const patch of [
    { url: '/api/browser/stream?ticket=secret' }, { url: '/api/%62rowser/stream' }, { method: 'POST' },
    { headers: { host: 'mira.example' } }, { headers: { host: 'attacker.example', origin: 'https://attacker.example' } },
    { headers: { host: 'mira.example', origin: 'http://mira.example' } },
    { headers: { host: 'mira.example', origin: 'https://mira.example', 'sec-fetch-site': 'cross-site' } },
    { rawHeaders: ['Host', 'mira.example', 'Host', 'mira.example'] },
    { rawHeaders: ['Origin', 'https://mira.example', 'origin', 'https://mira.example'] },
    { rawHeaders: ['Cookie', 'a', 'cookie', 'b'] },
    { rawHeaders: ['Sec-WebSocket-Protocol', 'mira-browser', 'sec-websocket-protocol', 'other'] },
  ]) assert.equal(trustedBrowserUpgrade(request(patch), origins), false);
});
test('browser input is a bounded projection, never arbitrary CDP or executable commands', () => {
  assert.deepEqual(browserInput({ type: 'input_mouse', eventType: 'mousePressed', x: 2, y: 3, button: 'left', clickCount: 1, command: 'evil', epoch: 4 }),
    { action: 'input_mouse', type: 'mousePressed', x: 2, y: 3, button: 'left', clickCount: 1, deltaX: 0, deltaY: 0, modifiers: 0 });
  assert.deepEqual(browserInput({ type: 'input_text', text: '中文粘贴' }),
    { action: 'inserttext', text: '中文粘贴' });
  assert.deepEqual(browserInput({ type: 'input_key', key: 'a', modifiers: 2 }), { action: 'press', key: 'Control+a' });
  assert.deepEqual(browserInput({ type: 'input_key', key: 'Enter' }), { action: 'press', key: 'Enter' });
  for (const value of [null, [], {}, { type: 'command', command: 'eval' }, { type: 'Input.insertText' },
    { type: 'input_text', text: 'x'.repeat(4097) },
    { type: 'input_text', text: null },
    { type: 'input_key', key: 'Enter', modifiers: 16 },
    { type: 'input_mouse', eventType: 'mousePressed', x: NaN, y: 2 },
    { type: 'input_mouse', eventType: 'mousePressed', x: -1, y: 2 },
    { type: 'input_mouse', eventType: 'mousePressed', x: 1, y: 2, button: 'evil' },
    { type: 'input_mouse', eventType: 'mouseWheel', x: 1, y: 2, deltaY: 10001 },
  ]) assert.equal(browserInput(value), null);
});

test('capture-time fence drops cached old frames arriving after tab/URL transitions', () => {
  const fence = new BrowserFrameFence();
  assert.equal(fence.accepts(100), false);
  assert.equal(fence.page('first-target', 'https://example.test/', 100), true);
  assert.equal(fence.accepts(99), true, 'initial seed belongs to established target');
  assert.equal(fence.page('first-target', 'https://example.test/', 110), false);
  assert.equal(fence.generation, 1);
  assert.equal(fence.url('https://example.test/next', 200), true);
  assert.equal(fence.accepts(150), false, 'late old frame must not get new generation');
  assert.equal(fence.accepts(200), false);
  assert.equal(fence.accepts(201), true);
  assert.equal(fence.page('first-target', 'https://example.test/next', 210), false, 'same URL tabs update is not a new transition');
  assert.equal(fence.url('https://example.test/next', 220), true, 'same URL reload is a new document boundary');
  assert.equal(fence.accepts(219), false);
  assert.equal(fence.accepts(221), true);
  assert.equal(fence.page('new-target', 'https://example.test/next', 300), true);
  assert.equal(fence.accepts(299), false);
  assert.equal(fence.accepts(301), true);
  for (const bad of [undefined, null, 0, NaN, Infinity, '999']) assert.equal(fence.accepts(bad), false);
});


test('delayed navigation delivery accepts a valid post-event static frame without accepting pre-event captures', () => {
  const fence = new BrowserFrameFence(); fence.page('target', 'https://example.test/', 1000);
  // Native navigation emission 2000; IPC/proxy processes the event at 2030.
  fence.url('https://example.test/static', 2000);
  assert.equal(fence.accepts(1999), false);
  assert.equal(fence.accepts(2010), true, 'post-event frame must not be compared with proxy receipt time 2030');
  fence.url('https://example.test/static', 3000);
  assert.equal(fence.accepts(2999), false, 'same URL reload retains document fencing');
  assert.equal(fence.accepts(3010), true);
});


test('stream identity verification buffers only bounded viewport traffic, never command/console contents', () => {
  for (const scenario of ['normal', 'count', 'bytes']) {
    execFileSync(process.execPath, ['tests/browser-stream-startup.mjs', scenario], { timeout: 15_000, stdio: 'pipe' });
  }
});

test('development HTTP and WebSocket proxy rewrite only the trusted local origin', () => {
  execFileSync(process.execPath, ['tests/browser-dev-proxy.mjs'], { timeout: 15_000, stdio: 'pipe' });
});
