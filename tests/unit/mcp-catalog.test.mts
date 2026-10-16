import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionHost } from '@mira/extension-host';
import { allowLocalTestHttp } from '../deny-model-network.mts';

const pause = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) { if (await check()) return; await pause(); }
  assert.fail('Timed out waiting for catalog fixture');
}

// Synthetic legacy HTTP wire peer; the production plugin uses the real official
// SDK, including its notification handling, transport and request cancellation.
async function catalogFixture(dialect?: string) {
  let revision = 1, lists = 0, active = 0, maximum = 0, calls = 0;
  let stream: http.ServerResponse | undefined;
  let release: (() => void) | undefined;
  let heldClosed = false;
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') {
      stream = res; res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return;
    }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    const message = body ? JSON.parse(body) : {};
    const reply = (result: unknown) => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    };
    if (message.method === 'initialize') {
      reply({ protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'catalog-order-fixture', version: '1' } }); return;
    }
    if (message.method === 'tools/list') {
      const number = ++lists, captured = revision;
      maximum = Math.max(maximum, ++active);
      res.once('close', () => { active--; if (number === 2) heldClosed = true; });
      const result = { tools: [
        {
          name: captured === -6 ? 42 : 'echo', description: `revision ${captured}`,
          inputSchema: {
            ...([-9, -16, -17].includes(captured)
              ? { $schema: captured === -9 ? null : captured === -16 ? 42 : false }
              : dialect ? { $schema: dialect } : {}),
            type: 'object',
            properties: captured === -5 ? 42 : { [`revision${captured}`]: { type: captured === -1 ? 'invalid-type' : 'string' } },
          },
          outputSchema: {
            type: 'object',
            ...(captured === -18 ? { $async: true } : {}),
            ...([-12, -13, -14, -15].includes(captured)
              ? { $schema: captured === -12 ? 'https://synthetic.invalid/unsupported' : captured === -13 ? null : captured === -14 ? 42 : false }
              : {}),
            properties: { value: captured === -11 ? { $ref: '#/$defs/missing' } : { type: 'string', ...(captured === -10 ? { pattern: '[' } : {}) } },
          },
        },
        { name: captured === -2 ? 'echo' : captured === -3 ? 'bad/name' : captured === -4 ? 'x'.repeat(65) : `only_v${Math.abs(captured)}`, inputSchema: { type: 'object' } },
      ] };
      if (number === 2) release = () => reply(result);
      else reply(result);
      return;
    }
    if (message.method === 'tools/call') { calls++; reply({ content: [{ type: 'text', text: 'catalog echo' }], structuredContent: { value: 'ok' } }); return; }
    res.writeHead(202); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`, revoke = allowLocalTestHttp(origin);
  return {
    url: origin + '/mcp', calls: () => calls, lists: () => lists, maximum: () => maximum, held: () => Boolean(release), heldClosed: () => heldClosed,
    ready: () => Boolean(stream), release: () => release?.(),
    change(value: number, notifications = 1) {
      revision = value;
      for (let count = 0; count < notifications; count++) stream?.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n\n`);
    },
    async close() { release?.(); server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); revoke(); },
  };
}
async function installation(reservedToolNames: string[] = [], dialect?: string) {
  const fixture = await catalogFixture(dialect);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-mcp-catalog-')));
  const entries = [{ id: 'remote', path: path.resolve('packages/mcp-plugin/src/index.ts'), config: { transport: 'http', url: fixture.url, protocol: 'legacy' } }];
  const configurationFile = path.join(root, 'extensions.json');
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const host = new ExtensionHost({ entries, configurationFile, reservedToolNames, receive: async () => 'inserted' });
  return { fixture, host, async close() { fixture.release(); await host.close(); await fixture.close(); await rm(root, { recursive: true, force: true }); } };
}

test('official SDK catalog notifications and manual refresh serialize held old lists and coalesce bursts', { timeout: 10_000 }, async () => {
  const { fixture, host, close } = await installation();
  try {
    await host.start(); await until(fixture.ready);
    const old = (await host.prepare()).find(item => item.tool.name === 'echo')!;
    assert.match(old.tool.description, /revision 1$/);
    fixture.change(2); await until(fixture.held);
    fixture.change(3, 20);
    const settings = (await host.extensionSettings('remote'))!;
    const operation = await host.startSettingsAction('remote', 'refresh', settings.revision);
    // Give the actual SDK time to consume the burst while the old HTTP response
    // is held. Neither its notifications nor the manual action may bypass it.
    await pause(100);
    assert.equal(fixture.lists(), 2);
    assert.equal(fixture.maximum(), 1);
    fixture.release();
    await until(async () => (await host.extensionSettings('remote'))?.operation?.state === 'succeeded');
    await until(async () => (await host.prepare()).some(item => item.tool.description.endsWith('revision 3')));
    await pause(100);
    const next = await host.prepare();
    const echo = next.find(item => item.tool.name === old.tool.name)!;
    assert.match(echo.tool.description, /revision 3$/);
    assert.deepEqual(echo.tool.parameters.properties, { revision3: { type: 'string' } });
    assert.ok(next.some(item => item.tool.name === 'only_v3'));
    assert.ok(!next.some(item => ['only_v1', 'only_v2'].some(name => item.tool.name === name)));
    assert.notEqual(echo.toolRevision, old.toolRevision);
    assert.equal((await old.tool.execute({}, { callId: 'stale', signal: new AbortController().signal })).isError, true);
    assert.equal((await host.extensionSettings('remote'))?.operation?.id, operation.operation?.id);
    assert.equal(fixture.maximum(), 1);
    assert.ok(fixture.lists() >= 3 && fixture.lists() <= 4, 'A burst is coalesced, with at most one extra automatic list plus manual refresh');
  } finally { await close(); }
});

for (const retirement of ['disconnect', 'disable'] as const) test(`held catalog is cancelled during ${retirement} without deadlock or late publication`, { timeout: 10_000 }, async () => {
  const { fixture, host, close } = await installation();
  try {
    await host.start(); await until(fixture.ready);
    fixture.change(2); await until(fixture.held);
    fixture.change(3, 20);
    if (retirement === 'disconnect') {
      const settings = (await host.extensionSettings('remote'))!;
      await host.startSettingsAction('remote', 'disconnect', settings.revision);
      await until(async () => (await host.extensionSettings('remote'))?.operation?.state === 'succeeded');
      assert.equal((await host.extensionSettings('remote'))?.status.state, 'disconnected');
    } else await host.requestChange('remote', { action: 'disable' });
    await until(fixture.heldClosed);
    fixture.release(); await pause(100);
    assert.ok(!(await host.prepare()).some(item => item.tool.name === 'echo'));
    assert.equal(fixture.lists(), 2, 'Queued notifications cannot start discovery after retirement');
  } finally { await close(); }
});

// A valid notification after a rejected candidate updates declarations
// and the same protected connection state, rather than leaving active error UI.
test('catalog recovery restores connected settings and actions with the new tools', { timeout: 10_000 }, async () => {
  const { fixture, host, close } = await installation();
  try {
    await host.start(); await until(fixture.ready);
    const previous = await host.prepare();
    fixture.change(-1); await until(fixture.held); fixture.release();
    await until(async () => (await host.extensionSettings('remote'))?.status.state === 'error');
    assert.deepEqual(await host.prepare(), previous);
    fixture.change(3);
    await until(async () => (await host.prepare()).some(item => item.tool.description.endsWith('revision 3')));
    const status = (await host.extensionSettings('remote'))!.status;
    assert.equal(status.state, 'connected'); assert.equal(status.code, undefined);
    assert.deepEqual(status.visibleActions, ['refresh', 'disconnect']);
  } finally { await close(); }
});

// The valid notification is delivered before the held invalid response fails.
test('a failed in-flight catalog does not discard an already received newer notification', { timeout: 10_000 }, async () => {
  const { fixture, host, close } = await installation();
  try {
    await host.start(); await until(fixture.ready);
    fixture.change(-1); await until(fixture.held);
    fixture.change(3);
    // Official SDK notification debounce must run while list #2 is still held.
    await pause(1200);
    assert.equal(fixture.lists(), 2);
    fixture.release();
    await until(async () => (await host.prepare()).some(item => item.tool.description.endsWith('revision 3')));
    assert.equal(fixture.lists(), 3);
    assert.equal(fixture.maximum(), 1);
    const status = (await host.extensionSettings('remote'))!.status;
    assert.equal(status.state, 'connected');
    assert.equal(status.code, undefined);
    assert.deepEqual(status.visibleActions, ['refresh', 'disconnect']);
  } finally { await close(); }
});

for (const [revision, detail] of [[-2, /Duplicate tool name/], [-3, /Invalid tool name/], [-4, /Invalid tool name/], [-5, /Invalid MCP tool catalog/], [-6, /Invalid MCP tool catalog/], ...[-9, -10, -11, -12, -13, -14, -15, -16, -17, -18].map(revision => [revision, /Invalid MCP tool catalog/] as const)] as const) {
  test(`invalid catalog declarations (${revision}) retain the original published toolset atomically`, { timeout: 10_000 }, async () => {
    const { fixture, host, close } = await installation();
    try {
      await host.start(); await until(fixture.ready);
      const previous = await host.prepare();
      const echo = previous.find(item => item.tool.name === 'echo')!.tool;
      assert.equal((await echo.execute({}, { callId: 'before', signal: new AbortController().signal })).isError, false);
      fixture.change(revision); await until(fixture.held); fixture.release();
      await until(async () => (await host.extensionSettings('remote'))?.status.state === 'error');
      const status = (await host.extensionSettings('remote'))!.status;
      assert.equal(status.code, 'configuration');
      assert.match(status.details![0]!.value, detail);
      assert.deepEqual(await host.prepare(), previous);
      assert.equal((await echo.execute({}, { callId: 'after-rejection', signal: new AbortController().signal })).isError, false);
      assert.equal(fixture.calls(), 2, 'The old exact declaration remains executable after rejection');
      fixture.change(3);
      await until(async () => (await host.extensionSettings('remote'))?.status.state === 'connected');
      assert.ok((await host.prepare()).some(item => item.tool.name === 'only_v3'));
    } finally { await close(); }
  });
}

test('catalog refresh refuses a built-in collision atomically and allows an explicit retry', { timeout: 10_000 }, async () => {
  const { fixture, host, close } = await installation(['only_v2']);
  try {
    await host.start(); await until(fixture.ready);
    const previous = await host.prepare();
    fixture.change(2); await until(fixture.held); fixture.release();
    await until(async () => (await host.extensionSettings('remote'))?.status.state === 'error');
    const rejected = (await host.extensionSettings('remote'))!;
    assert.match(rejected.status.details![0]!.value, /Duplicate tool name/);
    assert.deepEqual(await host.prepare(), previous);
    assert.deepEqual(rejected.status.visibleActions, ['refresh', 'disconnect']);
    await host.startSettingsAction('remote', 'refresh', rejected.revision);
    await until(async () => (await host.extensionSettings('remote'))?.operation?.state === 'failed');
    assert.deepEqual(await host.prepare(), previous);
    fixture.change(3);
    await until(async () => (await host.extensionSettings('remote'))?.status.state === 'connected');
    assert.ok((await host.prepare()).some(item => item.tool.name === 'only_v3'));
  } finally { await close(); }
});

for (const dialect of ['https://json-schema.org/draft-07/schema#', 'http://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft/2020-12/schema#']) {
  test(`official SDK catalogs preserve alternate schema dialect ${dialect}`, { timeout: 10_000 }, async () => {
    const { host, close } = await installation([], dialect);
    try {
      await host.start();
      assert.equal((await host.extensionSettings('remote'))?.status.state, 'connected');
      const echo = (await host.prepare()).find(item => item.tool.name === 'echo')!;
      assert.equal(echo.tool.parameters['$schema'], dialect);
      assert.deepEqual(echo.tool.parameters.properties, { revision1: { type: 'string' } });
    } finally { await close(); }
  });
}
