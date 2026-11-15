import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BrowserFailure, nativeBrowserReason } from '../../apps/server/src/browser-failures.ts';
import { AgentBrowserDriver, type BrowserDriver } from '../../apps/server/src/browser-driver.ts';
import { BrowserManager, BrowserOperationError } from '../../apps/server/src/browser-manager.ts';
import { createBrowserTools } from '../../apps/server/src/browser-tools.ts';

const secret = 'synthetic-browser-secret';
function driverWithFailure(error: unknown): BrowserDriver {
  return { async open() { throw error; }, async command() { throw error; }, async close() {}, async dispose() {}, async humanInput() {}, async stream() { return ''; }, async pauseStream() {}, async resumeStream() {} };
}

test('missing dependency is an ordinary tool error with exact cause, closes its unused slot and never leaks a raw error', async () => {
  const manager = new BrowserManager({ driver: driverWithFailure(new BrowserFailure('dependency', 'cli_missing', 'not_started', 'not_needed')) });
  try {
    const open = createBrowserTools(manager, 'main').find(tool => tool.name === 'browser_open')!;
    for (let i = 0; i < 70; i++) {
      const result = await open.execute(`missing-${i}`, { url: 'https://example.test/' });
      assert.equal(result.isError, true);
      const value = JSON.parse((result.content[0] as { text: string }).text);
      assert.equal(value.status, 'not_executed'); assert.equal(value.diagnostic.reason, 'cli_missing');
      assert.equal(value.diagnostic.cleanup, 'not_needed'); assert.equal(manager.list().at(-1)!.state, 'closed');
    }
    assert.ok(manager.list().length <= 64, 'preflight failures must not exhaust live browser capacity');
  } finally { await manager.close(); }
});

test('untrusted or forged errors cannot claim no execution or leak upstream content into tool results', async () => {
  const spoofed = Object.assign(Object.create(BrowserFailure.prototype), { message: secret, diagnostic: { execution: 'not_started', reason: 'cli_missing' } });
  assert.equal(BrowserFailure.from(spoofed), undefined);
  const manager = new BrowserManager({ driver: driverWithFailure(spoofed) });
  try {
    const tool = createBrowserTools(manager, 'main').find(tool => tool.name === 'browser_open')!;
    const result = await tool.execute('spoofed-open', { url: 'https://example.test/' });
    const value = JSON.parse((result.content[0] as { text: string }).text);
    assert.equal(result.isError, true); assert.equal(value.status, 'unknown');
    assert.equal(value.diagnostic.execution, 'unknown'); assert.equal(value.diagnostic.reason, 'command_failed');
    assert.ok(!JSON.stringify([result, manager.list()]).includes(secret));
    assert.equal(manager.list()[0]!.state, 'unknown');
  } finally { await manager.close(); }
});

test('command failure preserves phase and cleanup uncertainty, locks the same owner and is not replayed', async () => {
  let calls = 0;
  const driver = driverWithFailure(new Error(secret)); driver.open = async () => ({});
  driver.command = async () => { calls++; throw new BrowserFailure('navigation', 'dns_failed', 'unknown', 'unknown'); };
  const manager = new BrowserManager({ driver });
  try {
    const owner = manager.bind('main'); const browser = await owner.open('https://example.test/');
    await assert.rejects(owner.command(browser.id, ['snapshot']), error => error instanceof BrowserOperationError && error.diagnostic.reason === 'dns_failed');
    assert.equal(manager.list()[0]!.lock, 'cleanup'); assert.equal(manager.list()[0]!.failure?.phase, 'navigation');
    await assert.rejects(owner.command(browser.id, ['snapshot']), /agent control/); assert.equal(calls, 1);
    assert.equal(manager.bind('other').list().length, 0);
    driver.close = async () => { throw Error(secret); };
    await assert.rejects(owner.close(browser.id), error => error instanceof BrowserOperationError && error.diagnostic.phase === 'cleanup');
    assert.equal(manager.list()[0]!.failure?.reason, 'dns_failed'); assert.equal(manager.list()[0]!.failure?.phase, 'navigation');
    assert.equal(manager.list()[0]!.failure?.cleanup, 'unknown');
    driver.close = async () => {};
  } finally { await manager.close(); }
});

test('native markers are reduced to fixed reasons without returning secrets, URL, stderr or selectors', () => {
  for (const [raw, expected] of [
    ['error while loading shared libraries: libmissing.so', 'native_dependencies_missing'],
    ["GLIBC_2.99' not found", 'native_dependencies_missing'],
    ['No usable sandbox!', 'sandbox_unavailable'],
    ['No browser found', 'browser_missing'],
    ['net::ERR_NAME_NOT_RESOLVED', 'dns_failed'],
    ['net::ERR_CONNECTION_REFUSED', 'connection_failed'],
    ['net::ERR_CERT_AUTHORITY_INVALID', 'tls_failed'],
    ['net::ERR_TIMED_OUT', 'timeout'],
    ['unrecognized upstream failure', 'command_failed'],
  ] as const) {
    const reason = nativeBrowserReason(`${raw} https://private.test/?token=${secret}`, 'command_failed');
    assert.equal(reason, expected);
    const error = new BrowserFailure('command', reason);
    assert.ok(!JSON.stringify(BrowserFailure.from(error)).includes(secret));
  }
});

test('actual resolver reports an unavailable explicit executable before spawning a browser', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mira-browser-failure-')));
  const driver = new AgentBrowserDriver({ executable: path.join(root, 'missing'), cwd: root, miraHome: root });
  try {
    await assert.rejects(driver.open(randomUUID(), 'https://example.test'), error => {
      const d = BrowserFailure.from(error); return d?.phase === 'dependency' && d.reason === 'executable_unavailable' && d.execution === 'not_started';
    });
  } finally { await driver.dispose(); await rm(root, { recursive: true, force: true }); }
});

test('native startup stderr identifies missing system libraries while cleanup cannot replace the original cause', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'mira-browser-stderr-'))); const binary = path.join(root, 'native');
  await writeFile(binary, `#!${process.execPath}\nif(process.argv.includes('--version')){console.log('agent-browser 0.39.1');process.exit(0);}process.stderr.write('error while loading shared libraries: libmissing.so ${secret}');process.exit(127);`);
  await chmod(binary, 0o700); const driver = new AgentBrowserDriver({ executable: binary, cwd: root, miraHome: root });
  try {
    await assert.rejects(driver.open(randomUUID(), 'https://example.test'), error => {
      const d = BrowserFailure.from(error); assert.equal(d?.phase, 'daemon_start'); assert.equal(d?.reason, 'native_dependencies_missing');
      assert.equal(d?.execution, 'unknown'); assert.ok(!JSON.stringify([error, d]).includes(secret)); return true;
    });
  } finally { await driver.dispose(); await rm(root, { recursive: true, force: true }); }
});
