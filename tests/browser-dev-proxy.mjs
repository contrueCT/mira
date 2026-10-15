// Exercise the real development config without listening on a socket.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../package.json', import.meta.url));
const ts = require('typescript');
const compiled = ts.transpileModule(fs.readFileSync('apps/web/vite.config.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mod = { exports: {} };
new Function('require', 'exports', 'module', compiled)(name => name === 'vite' ? { defineConfig: config => config } : require(name), mod.exports, mod);
const proxy = mod.exports.default.server.proxy['/api'];
assert.equal(proxy.ws, true);
assert.equal(proxy.changeOrigin, true);
assert.equal(proxy.target, 'http://127.0.0.1:3210');
const handlers = new Map();
proxy.configure({ on: (event, callback) => handlers.set(event, callback) });
for (const event of ['proxyReq', 'proxyReqWs']) {
  for (const [host, origin, expected] of [
    ['127.0.0.1:5173', 'http://127.0.0.1:5173', 'http://127.0.0.1:3210'],
    ['attacker.test', 'http://127.0.0.1:5173', undefined],
    ['127.0.0.1:5173', 'https://attacker.test', undefined],
    ['127.0.0.1:5173', undefined, undefined],
  ]) {
    const headers = new Map();
    handlers.get(event)({ setHeader: (key, value) => headers.set(key, value) }, { headers: { host, origin } });
    assert.equal(headers.get('origin'), expected);
  }
}
