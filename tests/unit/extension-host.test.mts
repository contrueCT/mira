import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ExtensionHost, type ExtensionHostOptions, type RegisteredTool } from '@mira/extension-host';
import { defineExtension, serviceKey, type ExtensionEvent, type Json } from '@mira/extension-sdk';

const sdkUrl = import.meta.resolve('@mira/extension-sdk');
const received: ExtensionHostOptions['receive'] = async () => 'inserted';
const execution = { callId: 'offline-call', signal: new AbortController().signal };
const toolSource = (name: string, expression: string) => `ctx.registerTool({
  name: ${JSON.stringify(name)}, description: 'Offline extension test tool',
  parameters: { type: 'object', properties: { value: { type: 'string' } } },
  async execute(args) { return { text: String(${expression}) }; }
});`;

async function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-host-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function fixture<T>(directory: string, name: string, source: string): Promise<{ path: string; state: T }> {
  const file = path.join(directory, `${name}.mjs`);
  await writeFile(file, `import { defineExtension } from ${JSON.stringify(sdkUrl)};\n${source}\n`);
  const module = await import(pathToFileURL(file).href) as { state: T };
  return { path: file, state: module.state };
}
function named(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find(item => item.tool.name === name);
  assert.ok(tool, `Expected registered tool ${name}`);
  return tool;
}
async function execute(tool: RegisteredTool, args: Json = null): Promise<string> {
  return (await tool.tool.execute(args, execution)).text;
}
async function until(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await delay(5);
  assert.ok(predicate(), message);
}

// These fixtures are trusted local code in independent temporary directories.
// No sockets, database, model provider, or production workspace are used.
test('SDK maps declared dependencies and loads a configured trusted extension through its public contract', async () => {
  assert.equal(serviceKey('weather.v1'), 'mira.extension.weather.v1');
  assert.throws(() => serviceKey(''), /Invalid extension service name/);
  const definition = defineExtension({ name: 'consumer', requires: ['weather.v1'], apply() {} });
  assert.deepEqual(definition.inject, ['mira.extension.weather.v1']);
  await withDirectory(async directory => {
    const entry = await fixture<{ ids: string[]; applied: number; cleaned: number }>(directory, 'configured', `
      export const state = { ids: [], applied: 0, cleaned: 0 };
      export default defineExtension({ name: 'untrusted-plugin-declared-name', apply(ctx, config) {
        state.ids.push(ctx.id); state.applied++;
        ctx.onCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 5)); state.cleaned++; });
        ${toolSource('greet', "config.greeting + ':' + ctx.id + ':' + args.value")}
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'trusted-entry', path: entry.path, config: { greeting: 'hello' } }], receive: received });
    try {
      await host.start();
      assert.equal(host.hmrEnabled, false);
      const first = await host.prepare();
      const greet = named(first, 'greet');
      assert.equal(greet.extensionId, 'trusted-entry');
      assert.ok(greet.activation);
      assert.equal(await execute(greet, { value: 'world' }), 'hello:trusted-entry:world');
      assert.deepEqual(entry.state.ids, ['trusted-entry']);
      assert.deepEqual(host.inspect().map(item => [item.id, item.status, item.tools]), [['trusted-entry', 'active', ['greet']]]);
      // Tool parameter snapshots and inspection results cannot mutate the registry.
      greet.tool.parameters.properties!['extra'] = { type: 'number' };
      host.inspect()[0]!.tools.length = 0;
      const second = await host.prepare();
      assert.equal(named(second, 'greet').activation, greet.activation);
      assert.equal(named(second, 'greet').tool.parameters.properties!['extra'], undefined);
      assert.equal(entry.state.applied, 1);
      await host.finish();
      assert.equal(entry.state.cleaned, 0);
    } finally { await host.close(); }
    assert.equal(entry.state.cleaned, 1);
    await host.close();
    assert.equal(entry.state.cleaned, 1);
  });
});

test('configuration rejects ambiguous identities, non-absolute entries, unknown targets, and lifecycle misuse', async () => {
  assert.throws(() => new ExtensionHost({ entries: [{ id: 'same', path: '/tmp/one' }, { id: 'same', path: '/tmp/two' }], receive: received }), /duplicate extension ID/);
  assert.throws(() => new ExtensionHost({ entries: [{ id: '../escape', path: '/tmp/one' }], receive: received }), /extension ID/);
  assert.throws(() => new ExtensionHost({ entries: [{ id: 'valid', path: 'relative.mjs' }], receive: received }), /must be absolute/);
  const host = new ExtensionHost({ entries: [], receive: received });
  try {
    await assert.rejects(host.prepare(), /not running/);
    await host.start();
    await assert.rejects(host.start(), /cannot be started twice/);
    await assert.rejects(() => host.requestChange('unknown', { action: 'enable' }), /Unknown configured extension/);
    assert.deepEqual(host.changeStatus(), []);
  } finally { await host.close(); }
  await assert.rejects(host.prepare(), /not running/);
  await assert.rejects(host.finish(), /not running/);
  await assert.rejects(host.start(), /cannot be started twice/);
});

test('extension tool names enforce the portable model contract without automatic renaming', async () => {
  for (const name of ['', 'fixture.echo', 'x'.repeat(65), '工具', 'valid\n', 'has space', 'path/tool', '0', '-', '0tool', '-tool']) await withDirectory(async directory => {
    const entry = await fixture<Record<string, never>>(directory, 'invalid-name', `
      export const state = {};
      export default defineExtension({ name: 'invalid-name', apply(ctx) { ${toolSource(name, "'must not execute'")} } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'invalid-name', path: entry.path }], receive: received });
    try {
      await host.start();
      assert.deepEqual(await host.prepare(), []);
      assert.equal(host.inspect()[0]!.status, 'failed');
      assert.match(host.inspect()[0]!.diagnostic ?? '', /Invalid extension tool name: use 1-64 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore/);
      assert.deepEqual(host.inspect()[0]!.tools, []);
    } finally { await host.close(); }
  });
  await withDirectory(async directory => {
    const names = ['a', '_', '_0-', 'Tool-0', 'A0_-'.repeat(16)];
    const entry = await fixture<Record<string, never>>(directory, 'valid-names', `
      export const state = {};
      export default defineExtension({ name: 'valid-names', apply(ctx) { ${names.map(name => toolSource(name, JSON.stringify(name))).join('\n')} } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'valid-names', path: entry.path }], receive: received });
    try {
      await host.start();
      const registered = await host.prepare();
      assert.deepEqual(registered.map(item => item.tool.name), names);
      for (const name of names) assert.equal(await execute(named(registered, name)), name);
    } finally { await host.close(); }
  });
});

test('reserved and duplicate tools fail activation and unwind partial registrations and async resources', async () => {
  for (const collision of ['reserved', 'duplicate']) await withDirectory(async directory => {
    const owner = await fixture<{ applied: number }>(directory, 'owner', `
      export const state = { applied: 0 };
      export default defineExtension({ name: 'owner', apply(ctx) { state.applied++; ${toolSource('occupied', "(ctx.publish('collision-ping', null), 'owner')")} } });
    `);
    const failing = await fixture<{ cleaned: number; ticks: number; events: number }>(directory, 'failing', `
      export const state = { cleaned: 0, ticks: 0, events: 0 };
      export default defineExtension({ name: 'failing', apply(ctx) {
        ctx.interval(() => { state.ticks++; }, 2);
        ctx.onEvent('collision-ping', () => { state.events++; });
        ctx.onCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 5)); state.cleaned++; });
        ${toolSource('partial', "'must disappear'")}
        ${toolSource('occupied', "'must not replace owner'")}
      } });
    `);
    const host = new ExtensionHost({
      entries: [...(collision === 'duplicate' ? [{ id: 'owner', path: owner.path }] : []), { id: 'failing', path: failing.path }],
      reservedToolNames: collision === 'reserved' ? ['occupied'] : [], receive: received,
    });
    try {
      await host.start();
      const tools = await host.prepare();
      const status = host.inspect().find(item => item.id === 'failing')!;
      assert.equal(status.status, 'failed');
      assert.match(status.diagnostic ?? '', /Duplicate registered tool: occupied/);
      assert.deepEqual(status.tools, []);
      assert.equal(failing.state.cleaned, 1);
      assert.equal(tools.some(item => item.tool.name === 'partial'), false);
      if (collision === 'duplicate') assert.equal(await execute(named(tools, 'occupied')), 'owner');
      else assert.deepEqual(tools, []);
      const stoppedTicks = failing.state.ticks;
      await delay(15);
      assert.equal(failing.state.ticks, stoppedTicks);
      assert.equal(failing.state.events, 0);
    } finally { await host.close(); }
    assert.equal(failing.state.cleaned, 1);
  });
});

test('missing service waits; provider enable, disable, and recovery drive dependent lifecycles', async () => {
  await withDirectory(async directory => {
    const consumer = await fixture<{ applied: number; cleaned: number }>(directory, 'consumer', `
      export const state = { applied: 0, cleaned: 0 };
      export default defineExtension({ name: 'consumer', requires: ['source'], apply(ctx) {
        state.applied++;
        const source = ctx.service('source');
        ctx.onCleanup(async () => { await Promise.resolve(); state.cleaned++; });
        ${toolSource('consume', 'source.read()')}
      } });
    `);
    const provider = await fixture<{ applied: number; cleaned: number }>(directory, 'provider', `
      export const state = { applied: 0, cleaned: 0 };
      export default defineExtension({ name: 'provider', apply(ctx) {
        const version = ++state.applied; let live = true;
        ctx.provideService('source', { read() { if (!live) throw Error('provider disposed'); return version; } });
        ctx.onCleanup(async () => { await Promise.resolve(); live = false; state.cleaned++; });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'consumer', path: consumer.path }, { id: 'provider', path: provider.path, enabled: false }], receive: received });
    try {
      await host.start();
      assert.deepEqual(host.inspect().map(item => item.status), ['waiting', 'disabled']);
      assert.deepEqual(await host.prepare(), []);
      assert.equal(consumer.state.applied, 0);
      const enable = await host.requestChange('provider', { action: 'enable' });
      assert.equal(enable.status, 'applied');
      const first = named(await host.prepare(), 'consume');
      assert.equal(await execute(first), '1');
      assert.deepEqual(host.inspect().map(item => item.status), ['active', 'active']);
      assert.equal(host.changeStatus().find(item => item.id === enable.id)!.status, 'applied');
      const disable = await host.requestChange('provider', { action: 'disable' });
      assert.equal(disable.status, 'applied');
      assert.equal(((await first.tool.execute(null, execution)).details as { executed: boolean }).executed, false);
      assert.equal(provider.state.cleaned, 1);
      assert.deepEqual(await host.prepare(), []);
      assert.deepEqual(host.inspect().map(item => item.status), ['waiting', 'disabled']);
      assert.equal(consumer.state.cleaned, 1);
      assert.equal(provider.state.cleaned, 1);
      assert.equal(host.changeStatus().find(item => item.id === disable.id)!.status, 'applied');
      await host.requestChange('provider', { action: 'enable' });
      const recovered = named(await host.prepare(), 'consume');
      assert.equal(await execute(recovered), '2');
      assert.notEqual(recovered.activation, first.activation);
      assert.equal(consumer.state.applied, 2);
    } finally { await host.close(); }
    assert.equal(consumer.state.cleaned, 2);
    assert.equal(provider.state.cleaned, 2);
  });
});

test('configure and restart receipts reflect failed activation without claiming rollback, then recover', async () => {
  await withDirectory(async directory => {
    const entry = await fixture<{ applied: string[]; cleaned: string[]; failRestart: boolean }>(directory, 'configurable', `
      export const state = { applied: [], cleaned: [], failRestart: false };
      export default defineExtension({ name: 'configurable', apply(ctx, config) {
        state.applied.push(config.label);
        ctx.onCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 5)); state.cleaned.push(config.label); });
        ${toolSource('configured', 'config.label')}
        if (config.fail || state.failRestart) throw Error('activation rejected ' + config.label);
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'configured', path: entry.path, config: { label: 'initial' } }], receive: received });
    try {
      await host.start();
      const initial = named(await host.prepare(), 'configured');
      const config = { label: 'updated' };
      const changing = host.requestChange('configured', { action: 'configure', config });
      config.label = 'mutated-after-request';
      const change = await changing;
      assert.equal(change.status, 'applied');
      assert.deepEqual((await initial.tool.execute(null, execution)).details, { status: 'stale', executed: false, extensionId: 'configured', activation: initial.activation, toolName: 'configured' });
      const updated = named(await host.prepare(), 'configured');
      assert.equal(await execute(updated), 'updated');
      assert.notEqual(updated.activation, initial.activation);
      assert.deepEqual(entry.state.cleaned, ['initial']);
      assert.equal(change.status, 'applied');
      const receipts = host.changeStatus();
      assert.equal(receipts.find(item => item.id === change.id)!.status, 'applied');
      receipts[0]!.status = 'failed';
      assert.equal(host.changeStatus()[0]!.status, 'applied');
      const bad = await host.requestChange('configured', { action: 'configure', config: { label: 'bad', fail: true } });
      assert.deepEqual(await host.prepare(), []);
      assert.equal(host.inspect()[0]!.status, 'failed');
      assert.deepEqual(host.inspect()[0]!.tools, []);
      assert.deepEqual(entry.state.cleaned, ['initial', 'updated', 'bad']);
      const failed = host.changeStatus().find(item => item.id === bad.id)!;
      assert.equal(failed.status, 'failed');
      assert.match(failed.error ?? '', /activation rejected bad/);
      await host.requestChange('configured', { action: 'configure', config: { label: 'recovered' } });
      assert.equal(await execute(named(await host.prepare(), 'configured')), 'recovered');
      assert.equal(host.inspect()[0]!.diagnostic, null);
      entry.state.failRestart = true;
      const restart = await host.requestChange('configured', { action: 'reload' });
      assert.deepEqual(await host.prepare(), []);
      assert.equal(host.changeStatus().find(item => item.id === restart.id)!.status, 'failed');
      assert.equal(host.inspect()[0]!.status, 'failed');
      entry.state.failRestart = false;
      const retry = await host.requestChange('configured', { action: 'reload' });
      assert.equal(await execute(named(await host.prepare(), 'configured')), 'recovered');
      assert.equal(host.changeStatus().find(item => item.id === retry.id)!.status, 'applied');
      assert.equal(host.inspect()[0]!.status, 'active');
    } finally { await host.close(); }
    assert.equal(entry.state.cleaned.length, entry.state.applied.length);
  });
});

test('event-only emission binds configured identity and cannot create an implicit wake', async () => {
  await withDirectory(async directory => {
    const calls: Array<{ source: string; event: ExtensionEvent; wake: unknown }> = [];
    const entry = await fixture<{ event: ExtensionEvent & { source: string } }>(directory, 'events', `
      export const state = { event: { id: 'event-only', type: 'note', occurredAt: '2026-10-05T00:00:00.000Z', payload: { value: 1 }, source: 'user' } };
      export default defineExtension({ name: 'spoofed-name', apply(ctx) {
        ctx.registerTool({ name: 'emit', description: 'Emit a fact', parameters: { type: 'object' },
          async execute() { return { text: await ctx.emitEvent(state.event) }; } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'configured-source', path: entry.path }], receive: async (source, event, wake) => { calls.push({ source, event, wake }); return 'inserted'; } });
    try {
      await host.start();
      assert.equal(await execute(named(await host.prepare(), 'emit')), 'inserted');
      assert.equal(calls.length, 1);
      assert.equal(calls[0]!.source, 'configured-source');
      assert.equal(calls[0]!.wake, undefined);
      assert.deepEqual(calls[0]!.event, { id: 'event-only', type: 'note', occurredAt: '2026-10-05T00:00:00.000Z', payload: { value: 1 } });
      (entry.state.event.payload as { value: number }).value = 99;
      assert.deepEqual(calls[0]!.event.payload, { value: 1 });
      await host.finish();
      assert.equal(calls.length, 1);
    } finally { await host.close(); }
  });
});

test('explicit wake preserves stable IDs and delegates idempotence to the fake receiver', async () => {
  await withDirectory(async directory => {
    const inserted = new Set<string>();
    const calls: Array<{ source: string; event: ExtensionEvent; wake?: { id: string; reason: string } }> = [];
    const entry = await fixture<{ request: { id: string; reason: string; event: ExtensionEvent } }>(directory, 'wake', `
      export const state = { request: { id: 'wake-once', reason: 'explicit test request', event: { id: 'wake-event', type: 'wake-test', occurredAt: '2026-10-05T00:00:00.000Z', payload: null } } };
      export default defineExtension({ name: 'wake', apply(ctx) {
        ctx.registerTool({ name: 'wake', description: 'Explicit wake', parameters: { type: 'object' },
          async execute() { return { text: await ctx.requestWake(state.request) }; } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'waker', path: entry.path }], receive: async (source, event, wake) => {
      calls.push({ source, event, ...(wake ? { wake } : {}) });
      const key = `${source}/${wake?.id ?? event.id}`;
      if (inserted.has(key)) return 'duplicate';
      inserted.add(key); return 'inserted';
    } });
    try {
      await host.start();
      const tool = named(await host.prepare(), 'wake');
      assert.equal(await execute(tool), 'inserted');
      assert.equal(await execute(tool), 'duplicate');
      assert.equal(inserted.size, 1);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], calls[1]);
      assert.deepEqual(calls[0]!.wake, { id: 'wake-once', reason: 'explicit test request' });
      assert.equal(calls[0]!.source, 'waker');
      assert.equal(calls[0]!.event.id, 'wake-event');
      entry.state.request.id = '';
      await assert.rejects(execute(tool), /stable ID and reason/);
      entry.state.request.id = 'wake-valid';
      entry.state.request.event.occurredAt = 'invalid';
      await assert.rejects(execute(tool), /stable ID, type and timestamp/);
      assert.equal(calls.length, 2);
    } finally { await host.close(); }
  });
});

test('repeated reloads and disable cycles clean async resources, timers, and listeners without leaks', async () => {
  await withDirectory(async directory => {
    interface Run { ticks: number; events: number; cleaned: boolean }
    const entry = await fixture<{ runs: Run[]; cleanupStarts: number; cleanupEnds: number }>(directory, 'resources', `
      export const state = { runs: [], cleanupStarts: 0, cleanupEnds: 0 };
      export default defineExtension({ name: 'resources', apply(ctx) {
        const run = { ticks: 0, events: 0, cleaned: false }; state.runs.push(run);
        ctx.interval(() => { run.ticks++; }, 2);
        ctx.onEvent('tick', () => { run.events++; });
        ctx.onCleanup(async () => { state.cleanupStarts++; await new Promise(resolve => setTimeout(resolve, 5)); run.cleaned = true; state.cleanupEnds++; });
      } });
    `);
    const publisher = await fixture<Record<string, never>>(directory, 'publisher', `
      export const state = {};
      export default defineExtension({ name: 'publisher', apply(ctx) {
        ctx.registerTool({ name: 'publish', description: 'Publish test event', parameters: { type: 'object' },
          async execute() { ctx.publish('tick', { value: 1 }); return { text: 'published' }; } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'resources', path: entry.path }, { id: 'publisher', path: publisher.path }], receive: received });
    try {
      await host.start();
      for (let cycle = 0; cycle < 3; cycle++) {
        let publish = named(await host.prepare(), 'publish');
        const current = entry.state.runs.at(-1)!;
        await until(() => current.ticks > 0, 'Cordis interval should run');
        await execute(publish);
        assert.equal(current.events, 1);
        await host.requestChange('resources', { action: 'reload' });
        publish = named(await host.prepare(), 'publish');
        assert.equal(current.cleaned, true);
        const ticks = current.ticks;
        const replacement = entry.state.runs.at(-1)!;
        await until(() => replacement.ticks > 0, 'Replacement interval should run');
        await execute(publish);
        assert.equal(replacement.events, 1);
        assert.equal(current.events, 1);
        assert.equal(current.ticks, ticks);
        await host.requestChange('resources', { action: 'disable' });
        publish = named(await host.prepare(), 'publish');
        const stopped = entry.state.runs.map(run => ({ ...run }));
        await execute(publish);
        await delay(15);
        assert.deepEqual(entry.state.runs, stopped);
        assert.equal(entry.state.cleanupStarts, entry.state.runs.length);
        assert.equal(entry.state.cleanupEnds, entry.state.runs.length);
        if (cycle < 2) await host.requestChange('resources', { action: 'enable' });
      }
    } finally { await host.close(); }
    assert.equal(entry.state.runs.length, 6);
    assert.equal(entry.state.cleanupEnds, 6);
    const closed = structuredClone(entry.state);
    await delay(15);
    assert.deepEqual(entry.state, closed);
  });
});

test('management waits only for executing calls and old declarations are known not-executed after replacement', async () => {
  await withDirectory(async directory => {
    const entry = await fixture<{ applied: number; cleaned: number[]; entered: number; release: (() => void) | null }>(directory, 'execution', `
      export const state = { applied: 0, cleaned: [], entered: 0, release: null };
      export default defineExtension({ name: 'execution', apply(ctx) {
        const generation = ++state.applied; let resourceOpen = true;
        ctx.onCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 10)); resourceOpen = false; state.cleaned.push(generation); });
        ctx.registerTool({ name: 'resource', description: 'Read execution-leased resource', parameters: { type: 'object' },
          async execute(args) {
            state.entered++;
            if (args?.wait) await new Promise(resolve => { state.release = resolve; });
            if (!resourceOpen) throw Error('resource closed');
            return { text: String(generation) };
          } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'execution', path: entry.path }], receive: received });
    let reloading: ReturnType<ExtensionHost['requestChange']> | undefined;
    try {
      await host.start();
      const first = named(await host.prepare(), 'resource');
      const executing = execute(first, { wait: true });
      reloading = host.requestChange('execution', { action: 'reload' });
      await until(() => host.inspect()[0]!.status === 'unloading', 'Reload must begin without a request boundary');
      assert.equal(entry.state.applied, 1);
      assert.deepEqual(entry.state.cleaned, []);
      assert.deepEqual(host.changeStatus(), [], 'No accepted receipt is published while management is in progress');
      const stale = await first.tool.execute(null, execution);
      assert.deepEqual(stale.details, { status: 'stale', executed: false, extensionId: 'execution', activation: first.activation, toolName: 'resource' });
      assert.equal(entry.state.entered, 1, 'A sibling must not enter the unloading closure');
      entry.state.release!();
      assert.equal(await executing, '1', 'The actual in-flight execution keeps its resource alive');
      const reload = await reloading;
      assert.equal(reload.status, 'applied');
      assert.equal(reload.runtime!.status, 'active');
      assert.deepEqual(entry.state.cleaned, [1]);
      const second = named(await host.prepare(), 'resource');
      assert.notEqual(second.activation, first.activation);
      assert.equal(await execute(second), '2');
      assert.deepEqual((await first.tool.execute(null, execution)).details, stale.details, 'Never redirect an old declaration into replacement code');
      const disable = await host.requestChange('execution', { action: 'disable' });
      assert.equal(disable.status, 'applied');
      assert.equal(disable.runtime!.status, 'disabled');
      assert.deepEqual(entry.state.cleaned, [1, 2]);
      assert.match(await execute(second), /was not executed.*stale/);
      assert.equal(entry.state.entered, 2);
      assert.deepEqual(await host.prepare(), []);
      await host.finish();
      assert.deepEqual(entry.state.cleaned, [1, 2]);
    } finally {
      entry.state.release?.();
      await reloading;
      await host.close();
    }
  });
});

test('disabled entries do not apply until enabled, and syntax failures report import-failed honestly', async () => {
  await withDirectory(async directory => {
    const dormant = await fixture<{ applied: number; cleaned: number }>(directory, 'dormant', `
      export const state = { applied: 0, cleaned: 0 };
      export default defineExtension({ name: 'dormant', apply(ctx) {
        state.applied++; ctx.onCleanup(() => { state.cleaned++; });
        ${toolSource('dormant', "'enabled'")}
      } });
    `);
    const invalid = path.join(directory, 'invalid.mjs');
    await writeFile(invalid, 'export default { this is a syntax error };');
    const host = new ExtensionHost({ entries: [{ id: 'dormant', path: dormant.path, enabled: false }, { id: 'invalid', path: invalid }], receive: received });
    try {
      await host.start();
      assert.deepEqual(await host.prepare(), []);
      assert.equal(dormant.state.applied, 0);
      assert.deepEqual(host.inspect().map(item => item.status), ['disabled', 'import-failed']);
      assert.ok(host.inspect()[1]!.diagnostic);
      const reload = await host.requestChange('invalid', { action: 'reload' });
      assert.deepEqual(await host.prepare(), []);
      assert.equal(host.changeStatus().find(item => item.id === reload.id)!.status, 'failed');
      assert.equal(host.inspect()[1]!.status, 'import-failed');
      const enable = await host.requestChange('dormant', { action: 'enable' });
      assert.equal(await execute(named(await host.prepare(), 'dormant')), 'enabled');
      assert.equal(host.changeStatus().find(item => item.id === enable.id)!.status, 'applied');
      assert.equal(dormant.state.applied, 1);
    } finally { await host.close(); }
    assert.equal(dormant.state.cleaned, 1);
  });
});

test('a failed startup can be closed without leaking already applied extension resources', async () => {
  await withDirectory(async directory => {
    const entry = await fixture<{ cleaned: number }>(directory, 'first', `
      export const state = { cleaned: 0 };
      export default defineExtension({ name: 'first', apply(ctx) {
        ctx.onCleanup(async () => { await Promise.resolve(); state.cleaned++; });
        ctx.interval(() => {}, 5);
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'first', path: entry.path }, { id: 'missing', path: path.join(directory, 'missing.mjs') }], receive: received });
    try { await assert.rejects(host.start(), /ENOENT/); } finally { await host.close(); }
    assert.equal(entry.state.cleaned, 1);
    const directoryHost = new ExtensionHost({ entries: [{ id: 'directory', path: directory }], receive: received });
    try { await assert.rejects(directoryHost.start(), /not a file/); } finally { await directoryHost.close(); }
  });
});

test('management awaits async cleanup and concurrent boundaries observe its settled result', async () => {
  await withDirectory(async directory => {
    const entry = await fixture<{ applied: number; cleanupEntered: boolean; cleaned: number; release: (() => void) | null }>(directory, 'blocking-cleanup', `
      export const state = { applied: 0, cleanupEntered: false, cleaned: 0, release: null };
      export default defineExtension({ name: 'blocking-cleanup', apply(ctx) {
        const generation = ++state.applied;
        ctx.onCleanup(async () => {
          if (generation === 1) {
            state.cleanupEntered = true;
            await new Promise(resolve => { state.release = resolve; });
          }
          state.cleaned++;
        });
        ${toolSource('blocking', 'generation')}
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'blocking', path: entry.path }], receive: received });
    let advancing: Promise<RegisteredTool[]> | undefined;
    let changing: ReturnType<ExtensionHost['requestChange']> | undefined;
    try {
      await host.start();
      await host.prepare();
      changing = host.requestChange('blocking', { action: 'reload' });
      advancing = host.prepare();
      await until(() => entry.state.cleanupEntered, 'Cleanup should have started at the boundary');
      assert.equal(entry.state.cleaned, 0);
      assert.equal(entry.state.applied, 1);
      let finished = false;
      const finishing = host.finish().then(() => { finished = true; });
      await delay(10);
      assert.equal(finished, false);
      entry.state.release!();
      assert.equal(await execute(named(await advancing, 'blocking')), '2');
      assert.equal((await changing).status, 'applied');
      await finishing;
      assert.equal(finished, true);
      assert.equal(entry.state.cleaned, 1);
    } finally {
      entry.state.release?.();
      await changing?.catch(() => {});
      await advancing?.catch(() => {});
      await host.close();
    }
    assert.equal(entry.state.cleaned, 2);
  });
});

test('configuration accepts plain JSON and rejects executable expressions and non-JSON values before applying', async () => {
  const invalid: Array<{ value: Json; error: RegExp }> = [
    { value: { __jsExpr: 'globalThis.__miraConfigExecuted = true' }, error: /Executable Cordis config/ },
    { value: { nested: [{ __jsExpr: '1 + 1' }] }, error: /Executable Cordis config/ },
    { value: Number.NaN, error: /plain finite JSON/ },
    { value: Number.POSITIVE_INFINITY, error: /plain finite JSON/ },
    { value: new Date() as unknown as Json, error: /plain finite JSON/ },
    { value: { callback: () => {} } as unknown as Json, error: /plain finite JSON/ },
    { value: [undefined] as unknown as Json, error: /plain finite JSON/ },
  ];
  for (const { value, error } of invalid) {
    assert.throws(() => new ExtensionHost({ entries: [{ id: 'config', path: '/tmp/not-loaded.mjs', config: value }], receive: received }), error);
  }
  await withDirectory(async directory => {
    const entry = await fixture<Record<string, never>>(directory, 'plain-config', `
      export const state = {};
      export default defineExtension({ name: 'plain-config', apply(ctx, config) {
        ${toolSource('config', 'JSON.stringify(config)')}
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'config', path: entry.path, config: { finite: 3, values: [true, null, 'text'] } }], receive: received });
    try {
      await host.start();
      const first = named(await host.prepare(), 'config');
      assert.equal(await execute(first), '{"finite":3,"values":[true,null,"text"]}');
      for (const { value, error } of invalid) await assert.rejects(() => host.requestChange('config', { action: 'configure', config: value }), error);
      assert.deepEqual(host.changeStatus(), []);
      const second = named(await host.prepare(), 'config');
      assert.equal(second.activation, first.activation);
      assert.equal(await execute(second), await execute(first));
    } finally { await host.close(); }
  });
});

test('actual source HMR preserves executing calls while fencing stale declarations without a request boundary', { timeout: 15_000 }, async () => {
  await withDirectory(async home => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env['PATH'], HOME: home, TMPDIR: home,
      XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
      NODE_OPTIONS: `--import=${fileURLToPath(new URL('../deny-model-network.mts', import.meta.url))}`,
    };
    const child = spawn(process.execPath, ['--expose-internals', fileURLToPath(new URL('./fixtures/extension-host-hmr-probe.mjs', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
    let status: { code: number | null; signal: NodeJS.Signals | null };
    try {
      status = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal }));
      });
    } finally { clearTimeout(timeout); }
    assert.equal(status.signal, null, `HMR child was interrupted\n${stdout}\n${stderr}`);
    assert.equal(status.code, 0, `HMR child failed\n${stdout}\n${stderr}`);
    assert.equal(stdout.split('\n').filter(line => line === 'MIRA_HOST_HMR_RESULT:passed').length, 1, 'A silent HMR exit is not a passing test');
  });
});

test('services require declared dependencies while preserving valid falsy values and self-provided services', async () => {
  await withDirectory(async directory => {
    const provider = await fixture<Record<string, never>>(directory, 'falsy-provider', `
      export const state = {};
      export default defineExtension({ name: 'falsy-provider', apply(ctx) {
        ctx.provideService('zero', 0); ctx.provideService('false', false);
        ctx.provideService('empty', ''); ctx.provideService('null', null);
        ctx.provideService('unavailable', undefined);
        ${toolSource('own-service', "ctx.service('zero')")}
      } });
    `);
    const consumer = await fixture<Record<string, never>>(directory, 'falsy-consumer', `
      export const state = {};
      export default defineExtension({ name: 'falsy-consumer', requires: ['zero', 'false', 'empty', 'null', 'unavailable'], apply(ctx) {
        ${toolSource('falsy-services', "JSON.stringify([ctx.service('zero'), ctx.service('false'), ctx.service('empty'), ctx.service('null')])")}
        ${toolSource('unavailable-service', "ctx.service('unavailable')")}
      } });
    `);
    const undeclared = await fixture<Record<string, never>>(directory, 'undeclared-consumer', `
      export const state = {};
      export default defineExtension({ name: 'undeclared-consumer', apply(ctx) {
        ${toolSource('undeclared-service', "ctx.service('zero')")}
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'provider', path: provider.path }, { id: 'consumer', path: consumer.path }, { id: 'undeclared', path: undeclared.path }], receive: received });
    try {
      await host.start();
      const tools = await host.prepare();
      assert.equal(await execute(named(tools, 'own-service')), '0');
      assert.equal(await execute(named(tools, 'falsy-services')), '[0,false,"",null]');
      assert.equal(await execute(named(tools, 'falsy-services')), '[0,false,"",null]', 'cached falsy values remain usable');
      await assert.rejects(execute(named(tools, 'unavailable-service')), /Required service unavailable: unavailable/);
      await assert.rejects(execute(named(tools, 'undeclared-service')), /Declare required service: zero/);
    } finally { await host.close(); }
  });
});

for (const action of ['disable', 'reload', 'close'] as const) test(`provider resources outlive dependent asynchronous cleanup on ${action}`, async () => {
  await withDirectory(async directory => {
    const provider = await fixture<{ live: boolean; listeners: number; trace: string[] }>(directory, 'ordered-provider', `
      export const state = { live: false, listeners: 0, trace: [] };
      export default defineExtension({ name: 'ordered-provider', apply(ctx) {
        state.live = true;
        ctx.provideService('ordered-service', {
          subscribe() { state.listeners++; return () => { if (!state.live) throw Error('provider closed too early'); state.listeners--; state.trace.push('consumer-cleanup'); }; }
        });
        ctx.onCleanup(() => { state.trace.push('provider-close'); state.live = false; });
      } });
    `);
    const consumer = await fixture(directory, 'ordered-consumer', `
      export const state = {};
      export default defineExtension({ name: 'ordered-consumer', requires: ['ordered-service'], apply(ctx) {
        const service = ctx.service('ordered-service');
        const unsubscribe = service.subscribe();
        ctx.onCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 10)); unsubscribe(); });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'provider', path: provider.path }, { id: 'consumer', path: consumer.path }], receive: received });
    try {
      await host.start(); await host.prepare();
      assert.equal(provider.state.listeners, 1);
      if (action === 'close') await host.close();
      else { await host.requestChange('provider', { action }); await host.finish(); }
      assert.deepEqual(provider.state.trace.slice(0, 2), ['consumer-cleanup', 'provider-close']);
      assert.equal(provider.state.listeners, action === 'reload' ? 1 : 0);
      if (action !== 'close') assert.equal(host.inspect().find(item => item.id === 'consumer')!.diagnostic, null);
    } finally { await host.close(); }
    assert.equal(provider.state.listeners, 0);
  });
});

test('actual HMR and concurrent close await consumers before releasing provider resources', () => {
  const child = spawnSync(process.execPath, ['--expose-internals', 'tests/unit/fixtures/extension-cleanup-order-probe.mjs'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, /DEPENDENT_HMR_CLEANUP_COMPLETE/);
});

for (const action of ['disable', 'reload', 'close'] as const) test(`provider timer and listener remain usable during dependent cleanup on ${action}`, async () => {
  await withDirectory(async directory => {
    const provider = await fixture<{ ticks: number; trace: string[] }>(directory, 'tick-provider', `
      export const state = { ticks: 0, trace: [] };
      export default defineExtension({ name: 'tick-provider', apply(ctx) {
        const pending = [];
        ctx.onEvent('provider-final-tick', () => { for (const resolve of pending.splice(0)) resolve(); });
        ctx.interval(() => { state.ticks++; ctx.publish('provider-final-tick', null); }, 5);
        ctx.provideService('tick-service', { nextTick() { return new Promise(resolve => pending.push(resolve)); } });
        ctx.onCleanup(() => { state.trace.push('provider-close'); });
      } });
    `);
    const consumer = await fixture<{ done: number }>(directory, 'tick-consumer', `
      export const state = { done: 0 };
      export default defineExtension({ name: 'tick-consumer', requires: ['tick-service'], apply(ctx) {
        const service = ctx.service('tick-service');
        ctx.onCleanup(async () => { await service.nextTick(); state.done++; });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'provider', path: provider.path }, { id: 'consumer', path: consumer.path }], receive: received });
    try {
      await host.start(); await host.prepare();
      if (action === 'close') await host.close();
      else { await host.requestChange('provider', { action }); await host.finish(); }
      assert.equal(consumer.state.done, 1);
      assert.deepEqual(provider.state.trace, ['provider-close']);
    } finally { await host.close(); }
    assert.equal(consumer.state.done, action === 'reload' ? 2 : 1);
    const ticks = provider.state.ticks; await delay(20); assert.equal(provider.state.ticks, ticks);
  });
});

for (const action of ['disable', 'reload', 'close'] as const) test(`retiring callback cannot register resources or publish orphan tools during ${action}`, async () => {
  await withDirectory(async directory => {
    const provider = await fixture<{ stopping: boolean; rejected: string[]; registered: string[]; cleanupCalls: number }>(directory, 'late-provider', `
      export const state = { stopping: false, rejected: [], registered: [], cleanupCalls: 0 };
      export default defineExtension({ name: 'late-provider', apply(ctx) {
        state.stopping = false; let attempted = false;
        ctx.provideService('late-source', { stopping() { state.stopping = true; } });
        ctx.onCleanup(() => { state.cleanupCalls++; });
        ctx.interval(() => {
          if (!state.stopping || attempted) return; attempted = true;
          for (const [name, register] of [
            ['tool', () => ctx.registerTool({ name: 'orphan', description: 'must not appear', parameters: { type: 'object' }, async execute() { return { text: 'orphan' }; } })],
            ['listener', () => ctx.onEvent('late-event', () => {})],
            ['timer', () => ctx.interval(() => {}, 1000)],
            ['service', () => ctx.provideService('orphan-service', {})],
            ['cleanup', () => ctx.onCleanup(() => {})],
          ]) {
            try { register(); state.registered.push(name); } catch { state.rejected.push(name); }
          }
        }, 1);
      } });
    `);
    const consumer = await fixture(directory, 'late-consumer', `
      export const state = {};
      export default defineExtension({ name: 'late-consumer', requires: ['late-source'], apply(ctx) {
        const source = ctx.service('late-source');
        ctx.onCleanup(async () => { source.stopping(); await new Promise(resolve => setTimeout(resolve, 15)); });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'provider', path: provider.path }, { id: 'consumer', path: consumer.path }], receive: received });
    try {
      await host.start(); await host.prepare();
      if (action === 'close') await host.close();
      else { await host.requestChange('provider', { action }); assert.deepEqual(await host.prepare(), []); }
      assert.deepEqual(provider.state.registered, []);
      assert.deepEqual(provider.state.rejected, ['tool', 'listener', 'timer', 'service', 'cleanup']);
      assert.equal(provider.state.cleanupCalls, 1);
      if (action !== 'close') assert.deepEqual(host.inspect().map(item => item.tools), [[], []]);
    } finally { await host.close(); }
    assert.deepEqual(provider.state.registered, []);
  });
});

test('shared module callbacks retain independent subscriptions for each configured activation', async () => {
  await withDirectory(async directory => {
    const shared = await fixture<{ calls: number }>(directory, 'shared-listener', `
      export const state = { calls: 0 };
      const onPing = () => { state.calls++; };
      export default defineExtension({ name: 'shared-listener', apply(ctx) {
        ctx.onEvent('shared-ping', onPing);
        ctx.registerTool({ name: ctx.id + '_publish', description: 'Publish shared ping', parameters: { type: 'object' }, async execute() { ctx.publish('shared-ping', null); return { text: 'published' }; } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'alpha', path: shared.path }, { id: 'beta', path: shared.path }], receive: received });
    try {
      await host.start();
      await execute(named(await host.prepare(), 'beta_publish'));
      assert.equal(shared.state.calls, 2);
      await host.requestChange('alpha', { action: 'disable' });
      const beta = named(await host.prepare(), 'beta_publish');
      await execute(beta);
      assert.equal(shared.state.calls, 3);
      assert.equal(host.inspect().find(item => item.id === 'beta')!.status, 'active');
      await host.requestChange('alpha', { action: 'enable' });
      await execute(named(await host.prepare(), 'beta_publish'));
      assert.equal(shared.state.calls, 5);
    } finally { await host.close(); }
  });
});

test('shared mutable tool definitions cannot change a registered cleanup key', async () => {
  await withDirectory(async directory => {
    const shared = await fixture<Record<string, never>>(directory, 'shared-tool', `
      export const state = {};
      const tool = { name: 'initial', description: 'Shared definition', parameters: { type: 'object' }, async execute() { return { text: 'shared' }; } };
      export default defineExtension({ name: 'shared-tool', apply(ctx) { tool.name = 'tool_' + ctx.id; ctx.registerTool(tool); } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'alpha', path: shared.path }, { id: 'beta', path: shared.path }], receive: received });
    try {
      await host.start();
      assert.deepEqual((await host.prepare()).map(item => item.tool.name).sort(), ['tool_alpha', 'tool_beta']);
      await host.requestChange('alpha', { action: 'disable' });
      assert.deepEqual((await host.prepare()).map(item => item.tool.name), ['tool_beta']);
      assert.deepEqual(host.inspect().find(item => item.id === 'alpha')!.tools, []);
      await host.requestChange('beta', { action: 'disable' });
      assert.deepEqual(await host.prepare(), []);
      await host.requestChange('alpha', { action: 'enable' });
      assert.deepEqual((await host.prepare()).map(item => item.tool.name), ['tool_alpha']);
    } finally { await host.close(); }
  });
});

test('class-based SDK tools preserve prototype metadata and private-field execute receivers', async () => {
  await withDirectory(async directory => {
    const entry = await fixture<Record<string, never>>(directory, 'class-tool', `
      export const state = {};
      class Tool {
        #value = 'private-value';
        get name() { return 'class_tool'; }
        get description() { return 'Prototype description'; }
        get parameters() { return { type: 'object' }; }
        async execute() { return { text: this.#value }; }
      }
      export default defineExtension({ name: 'class-tool', apply(ctx) { ctx.registerTool(new Tool()); } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'class', path: entry.path }], receive: received });
    try {
      await host.start();
      const registered = named(await host.prepare(), 'class_tool');
      assert.equal(registered.tool.description, 'Prototype description');
      assert.equal(await execute(registered), 'private-value');
      await host.requestChange('class', { action: 'disable' });
      assert.deepEqual(await host.prepare(), []);
    } finally { await host.close(); }
  });
});

test('independent activations are not pinned by another executing tool or a prepared declaration', async () => {
  await withDirectory(async directory => {
    const shared = await fixture<{ cleaned: string[]; release: (() => void) | null }>(directory, 'independent', `
      export const state = { cleaned: [], release: null };
      export default defineExtension({ name: 'independent', apply(ctx) {
        let alive = true;
        ctx.onCleanup(() => { alive = false; state.cleaned.push(ctx.id); });
        ctx.registerTool({ name: ctx.id + '_work', description: 'Independent resource', parameters: { type: 'object' }, async execute(args) {
          if (args?.wait) await new Promise(resolve => { state.release = resolve; });
          if (!alive) throw Error('resource closed');
          return { text: ctx.id };
        } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'alpha', path: shared.path }, { id: 'beta', path: shared.path }], receive: received });
    try {
      await host.start();
      const tools = await host.prepare();
      const alpha = named(tools, 'alpha_work');
      const beta = named(tools, 'beta_work');
      const executing = execute(alpha, { wait: true });
      const removed = await host.requestChange('beta', { action: 'remove' });
      assert.equal(removed.status, 'applied');
      assert.equal(removed.runtime, null);
      assert.deepEqual(shared.state.cleaned, ['beta']);
      assert.match(await execute(beta), /was not executed.*stale/);
      shared.state.release!();
      assert.equal(await executing, 'alpha');
      assert.equal(await execute(alpha), 'alpha');
    } finally { shared.state.release?.(); await host.close(); }
    assert.deepEqual(shared.state.cleaned, ['beta', 'alpha']);
  });
});

for (const ending of ['throw', 'abort', 'close'] as const) test(`all executing leases drain after ${ending} without early cleanup or deadlock`, async () => {
  await withDirectory(async directory => {
    const entry = await fixture<{ entered: number; cleaned: boolean; release: (() => void)[] }>(directory, 'lease-release', `
      export const state = { entered: 0, cleaned: false, release: [] };
      export default defineExtension({ name: 'lease-release', apply(ctx) {
        ctx.onCleanup(() => { state.cleaned = true; });
        ctx.registerTool({ name: 'leased', description: 'Await a controlled effect', parameters: { type: 'object' }, async execute(args, execution) {
          state.entered++;
          await new Promise((resolve, reject) => {
            state.release.push(resolve);
            if (args.abort) execution.signal.addEventListener('abort', () => reject(Error('synthetic abort')), { once: true });
          });
          if (state.cleaned) throw Error('resource closed early');
          if (args.fail) throw Error('synthetic failure');
          return { text: 'completed' };
        } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'leases', path: entry.path }], receive: received });
    const abort = new AbortController();
    let changing: Promise<unknown> | undefined;
    try {
      await host.start();
      const tool = named(await host.prepare(), 'leased');
      const first = tool.tool.execute({ fail: ending === 'throw', abort: ending === 'abort' }, { callId: 'first', signal: abort.signal });
      const firstOutcome = first.then(value => ({ value }), error => ({ error: String(error) }));
      const second = execute(tool, { fail: false, abort: false });
      assert.equal(entry.state.entered, 2);
      let settled = false;
      changing = (ending === 'close' ? host.close() : host.requestChange('leases', { action: 'disable' })).then(value => { settled = true; return value; });
      await delay(10);
      assert.equal(settled, false);
      assert.equal(entry.state.cleaned, false);
      assert.match(await execute(tool), /was not executed.*stale/);
      if (ending === 'abort') abort.abort(); else entry.state.release[0]!();
      const outcome = await firstOutcome;
      if (ending === 'close') assert.deepEqual(outcome, { value: { text: 'completed' } });
      else assert.match('error' in outcome ? outcome.error : '', /synthetic (abort|failure)/);
      await delay(5);
      assert.equal(settled, false, 'One completed/failed call cannot release a sibling lease');
      assert.equal(entry.state.cleaned, false);
      entry.state.release[1]!();
      assert.equal(await second, 'completed');
      await changing;
      assert.equal(settled, true);
      assert.equal(entry.state.cleaned, true);
    } finally {
      for (const release of entry.state.release) release();
      await changing;
      await host.close();
    }
  });
});


for (const action of ['disable', 'reload', 'remove'] as const) test(`a leased consumer can first read its injected service during provider ${action}`, async () => {
  await withDirectory(async directory => {
    const provider = await fixture<{ applied: number; closed: number[]; trace: string[] }>(directory, 'lazy-provider', `
      export const state = { applied: 0, closed: [], trace: [] };
      export default defineExtension({ name: 'lazy-provider', apply(ctx) {
        const generation = ++state.applied; let live = true;
        ctx.provideService('lazy-source', { read(label) {
          if (!live) throw Error('provider resource closed early');
          state.trace.push(label + ':' + generation); return generation;
        } });
        ctx.onCleanup(() => { live = false; state.closed.push(generation); state.trace.push('provider-close:' + generation); });
      } });
    `);
    const consumer = await fixture<{ release: (() => void) | null }>(directory, 'lazy-consumer', `
      export const state = { release: null };
      export default defineExtension({ name: 'lazy-consumer', requires: ['lazy-source'], apply(ctx) {
        ctx.onCleanup(() => { ctx.service('lazy-source').read('consumer-cleanup'); });
        ctx.registerTool({ name: 'lazy_consume', description: 'Read dependency for the first time after suspension', parameters: { type: 'object' }, async execute(args) {
          if (args?.wait) await new Promise(resolve => { state.release = resolve; });
          return { text: String(ctx.service('lazy-source').read('tool')) };
        } });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'provider', path: provider.path }, { id: 'consumer', path: consumer.path }], receive: received });
    let changing: ReturnType<ExtensionHost['requestChange']> | undefined;
    try {
      await host.start();
      const initial = named(await host.prepare(), 'lazy_consume');
      assert.deepEqual(provider.state.trace, [], 'Consumer does not read the service during apply');
      const executing = execute(initial, { wait: true });
      changing = host.requestChange('provider', { action });
      await until(() => host.inspect().find(item => item.id === 'consumer')!.status === 'unloading', 'Dependent teardown should start while its call runs');
      assert.deepEqual(provider.state.closed, []);
      consumer.state.release!();
      assert.equal(await executing, '1', 'First service access uses the pinned injected generation');
      assert.equal((await changing).status, 'applied');
      assert.deepEqual(provider.state.trace.slice(0, 3), ['tool:1', 'consumer-cleanup:1', 'provider-close:1']);
      assert.match(await execute(initial), /was not executed.*stale/);
      if (action === 'reload') {
        const replacement = named(await host.prepare(), 'lazy_consume');
        assert.notEqual(replacement.activation, initial.activation);
        assert.equal(await execute(replacement), '2', 'Replacement activation snapshots the new dependency');
      } else assert.deepEqual(await host.prepare(), []);
    } finally {
      consumer.state.release?.();
      await changing;
      await host.close();
    }
  });
});

for (const action of ['disable', 'reload', 'remove'] as const) test(`provider ${action} reports a transitive dependent cleanup failure in its own receipt`, async () => {
  await withDirectory(async directory => {
    const provider = await fixture<{ trace: string[] }>(directory, 'failure-provider', `
      export const state = { trace: [] };
      export default defineExtension({ name: 'failure-provider', apply(ctx) {
        ctx.provideService('failure-root', { record(label) { state.trace.push(label); } });
        ctx.onCleanup(() => { state.trace.push('provider-close'); });
      } });
    `);
    const bridge = await fixture(directory, 'failure-bridge', `
      export const state = {};
      export default defineExtension({ name: 'failure-bridge', requires: ['failure-root'], apply(ctx) {
        ctx.provideService('failure-branch', ctx.service('failure-root'));
        ctx.onCleanup(() => { ctx.service('failure-root').record('bridge-close'); });
      } });
    `);
    const consumer = await fixture(directory, 'failure-consumer', `
      export const state = {};
      export default defineExtension({ name: 'failure-consumer', requires: ['failure-branch'], apply(ctx) {
        ctx.onCleanup(() => {
          ctx.service('failure-branch').record('consumer-close');
          throw Error('synthetic dependent cleanup failure');
        });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'provider', path: provider.path }, { id: 'bridge', path: bridge.path }, { id: 'consumer', path: consumer.path }], receive: received });
    try {
      await host.start();
      const receipt = await host.requestChange('provider', { action });
      assert.equal(receipt.status, 'failed');
      assert.equal(receipt.cleanup, 'failed');
      assert.equal(receipt.persistence, 'not-required');
      assert.match(receipt.error!, /consumer: synthetic dependent cleanup failure/);
      assert.equal(receipt.runtime?.status ?? null, action === 'remove' ? null : action === 'disable' ? 'disabled' : 'active');
      assert.deepEqual(provider.state.trace, ['consumer-close', 'bridge-close', 'provider-close']);
      assert.deepEqual(host.changeStatus()[0], receipt);
    } finally { await host.close(); }
  });
});

test('earlier unrelated cleanup errors do not contaminate a new completed management receipt', async () => {
  await withDirectory(async directory => {
    const shared = await fixture(directory, 'cleanup-isolation', `
      export const state = {};
      export default defineExtension({ name: 'cleanup-isolation', apply(ctx) {
        ctx.onCleanup(() => { if (ctx.id === 'broken') throw Error('prior unrelated failure'); });
      } });
    `);
    const host = new ExtensionHost({ entries: [{ id: 'broken', path: shared.path }, { id: 'healthy', path: shared.path }], receive: received });
    try {
      await host.start();
      const failed = await host.requestChange('broken', { action: 'disable' });
      assert.equal(failed.status, 'failed');
      assert.equal(failed.cleanup, 'failed');
      assert.match(failed.error!, /prior unrelated failure/);
      for (const id of ['healthy', 'broken']) {
        const receipt = await host.requestChange(id, { action: 'disable' });
        assert.equal(receipt.status, 'applied');
        assert.equal(receipt.cleanup, undefined);
        assert.equal(receipt.error, undefined);
        assert.equal(receipt.runtime!.status, 'disabled');
      }
      assert.ok(host.diagnosticsLog().some(message => message.includes('prior unrelated failure')));
    } finally { await host.close(); }
  });
});

for (const action of ['disable', 'configure']) test(`actual HMR overlapping configuration save cannot override awaited ${action}`, { timeout: 30_000 }, () => {
  const child = spawnSync(process.execPath, ['--expose-internals', 'tests/unit/fixtures/extension-hmr-management-race-probe.mjs', action], { encoding: 'utf8', timeout: 25_000 });
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
  assert.match(child.stdout, new RegExp(`HMR_MANAGEMENT_RACE_COMPLETE:${action}`));
});

test('ordinary extension message projection is copied and validated under the configured identity', async () => {
  await withDirectory(async directory => {
    const entry = await fixture<{ send: (event: unknown) => Promise<unknown> }>(directory, 'messages', `
      export const state = {};
      export default defineExtension({ name: 'claimed-other-name', apply(ctx) { state.send = event => ctx.emitEvent(event); } });
    `);
    const received: Array<{ id: string; event: ExtensionEvent }> = [];
    const host = new ExtensionHost({ entries: [{ id: 'actual-weather', path: entry.path }], receive: async (id, event) => { received.push({ id, event }); return 'inserted'; } });
    try {
      await host.start();
      const event = { id: 'message', type: 'weather.message', occurredAt: '2026-10-15T00:00:00Z', payload: { sender: 'sensor' }, message: { direction: 'inbound', text: 'Rain', sourceLabel: 'Weather', raw: 'not-public' } };
      await entry.state.send(event); event.message.text = 'changed after reception';
      assert.equal(received[0]!.id, 'actual-weather');
      assert.deepEqual(received[0]!.event.message, { direction: 'inbound', text: 'Rain', sourceLabel: 'Weather' });
      await assert.rejects(entry.state.send({ ...event, message: { ...event.message, senderVerified: true } }), /Invalid extension message/);
      assert.equal(received.length, 1);
      await host.close(); await assert.rejects(entry.state.send(event));
    } finally { await host.close(); }
  });
});
