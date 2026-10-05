// Run in a separate --expose-internals process. The extension modules must be
// dynamically loaded: a module statically linked to this entry is an HMR external
// and Cordis intentionally exits instead of replacing it.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Resolve the real pinned packages in their owning workspace, without copying
// Cordis, changing its internals, or adding test-only root production dependencies.
const requireHost = createRequire(new URL('../../../packages/extension-host/package.json', import.meta.url));
const { Context } = await import(pathToFileURL(requireHost.resolve('cordis')).href);
const { default: Loader } = await import(pathToFileURL(requireHost.resolve('@cordisjs/plugin-loader')).href);
const { default: Hmr } = await import(pathToFileURL(requireHost.resolve('@cordisjs/plugin-hmr')).href);
const { default: Timer } = await import(pathToFileURL(requireHost.resolve('@cordisjs/plugin-timer')).href);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const scenario = process.argv[2];
const dir = await mkdtemp(path.join(os.tmpdir(), 'mira-official-hmr-'));
const ctx = new Context();
ctx.baseUrl = pathToFileURL(`${dir}/`).href;
const fixture = globalThis.fixture = { events: [], active: undefined, gate: undefined, cleanup: undefined };
const releases = [];
const logs = [];
let reloadCount = 0;
let finalResult;
const until = async (condition, label) => {
  const deadline = Date.now() + 5_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; events=${JSON.stringify(fixture.events)}; logs=${logs.join('\n')}`);
    await sleep(10);
  }
};
const file = (name) => path.join(dir, name);
const url = (name) => pathToFileURL(file(name)).href;
const put = (name, contents) => writeFile(file(name), contents);
const count = (event) => fixture.events.filter((item) => item === event).length;
const hold = () => { const gate = deferred(); releases.push(gate.resolve); return gate; };
const source = (imports, value = 'value', grouped = false, failure = false) => `${imports}
export default ${failure ? 'async ' : ''}function plugin(ctx) {
  const revision = ${value};
  const f = globalThis.fixture;
  f.events.push('apply:' + revision);
  f.active = revision;
  ${grouped ? 'ctx.effect(function* () { yield ' : ''}ctx.provide('hmrFixture', { value: revision });
  ${grouped ? 'yield ' : ''}ctx.on('fixture/ping', () => f.events.push('ping:' + revision));
  ${grouped ? 'yield ' : ''}ctx.setInterval(() => f.events.push('tick:' + revision), 20);
  ${grouped ? 'yield async () => {' : 'ctx.effect(() => async () => {'}
    f.events.push('dispose:start:' + revision);
    if (f.cleanup) await f.cleanup;
    f.events.push('dispose:end:' + revision);
    if (f.active === revision) f.active = undefined;
  ${grouped ? '}; });' : '});'}
  ${failure ? 'await Promise.resolve(); throw new Error("fixture-apply-rejected");' : ''}
}
plugin.inject = ['timer'];`;
const watch = (...names) => names.map((name) => ctx.hmr.watch(file(name), async () => {
  fixture.events.push(`watch:${name}`);
  if (fixture.gate) await fixture.gate;
}));
const load = async () => {
  const id = await ctx.loader.create({ name: url('entry.mjs') });
  await ctx.loader.await();
  // loader.await() settles its tasks; the fiber surfaces an apply failure.
  await ctx.loader.resolve(id).fiber.await();
  assert.equal(fixture.active, 'one');
  assert.equal(ctx.hmrFixture.value, 'one');
  // Public watch() has no per-file ready promise. Allow chokidar's initial scan
  // to attach before changing a file; subsequent waits require observed events.
  await sleep(200);
  return id;
};
const expectReplacement = async (oldValue, newValue, expectedReloadCount) => {
  await until(() => fixture.active === newValue && reloadCount === expectedReloadCount, `replacement ${newValue}`);
  await ctx.loader.await();
  assert.equal(ctx.hmrFixture.value, newValue);
  assert.equal(count(`dispose:start:${oldValue}`), 1);
  assert.equal(count(`dispose:end:${oldValue}`), 1);
  assert.ok(fixture.events.indexOf(`dispose:end:${oldValue}`) < fixture.events.indexOf(`apply:${newValue}`));
  const oldTicks = count(`tick:${oldValue}`);
  const oldPings = count(`ping:${oldValue}`);
  ctx.emit('fixture/ping');
  await until(() => count(`tick:${newValue}`) > 0, `new timer ${newValue}`);
  await sleep(50);
  assert.equal(count(`tick:${oldValue}`), oldTicks, 'old timer was removed');
  assert.equal(count(`ping:${oldValue}`), oldPings, 'old listener was removed');
  assert.ok(count(`ping:${newValue}`) > 0, 'new listener is active');
};
try {
  ctx.logger.exporter({ export: (message) => logs.push(message.args.map((arg) => arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)).join(' ')) });
  await ctx.plugin(Loader, { baseUrl: ctx.baseUrl });
  await ctx.plugin(Timer);
  await ctx.plugin(Hmr, { root: [], ignored: ['**'], debounce: 10 });
  assert.ok(ctx.loader.internal, 'real source HMR requires Node internals');
  ctx.on('hmr/reload', () => { reloadCount++; fixture.events.push('reloaded'); });
  ctx.on('hmr/change', (changed) => fixture.events.push(`change:${changed}`));

  if (scenario === 'esm-source-and-transitive') {
    await put('leaf.mjs', 'export default "one";');
    await put('middle.mjs', 'export { default } from "./leaf.mjs";');
    await put('entry.mjs', source('import value from "./middle.mjs";'));
    watch('entry.mjs', 'middle.mjs', 'leaf.mjs');
    await load();
    assert.deepEqual(await ctx.hmr.getLinked(url('entry.mjs')), [url('middle.mjs')]);
    assert.deepEqual(await ctx.hmr.getLinked(url('middle.mjs')), [url('leaf.mjs')]);
    await put('leaf.mjs', 'export default "two";');
    await expectReplacement('one', 'two', 1);
    await put('entry.mjs', source('import value from "./middle.mjs";', 'value + ":source"'));
    await expectReplacement('two', 'two:source', 2);
  } else if (scenario === 'esm-imported-cjs') {
    await put('leaf.cjs', 'module.exports = "one";');
    await put('middle.mjs', 'export { default } from "./leaf.cjs";');
    await put('entry.mjs', source('import value from "./middle.mjs";'));
    watch('entry.mjs', 'middle.mjs', 'leaf.cjs');
    await load();
    assert.deepEqual(await ctx.hmr.getLinked(url('middle.mjs')), [url('leaf.cjs')]);
    await put('leaf.cjs', 'module.exports = "two";');
    await expectReplacement('one', 'two', 1);
  } else if (scenario === 'cjs-require-limit') {
    await put('leaf.cjs', 'module.exports = "one";');
    await put('middle.cjs', 'module.exports = require("./leaf.cjs");');
    await put('entry.mjs', source('import value from "./middle.cjs";'));
    watch('entry.mjs', 'middle.cjs', 'leaf.cjs');
    await load();
    assert.deepEqual(await ctx.hmr.getLinked(url('entry.mjs')), [url('middle.cjs')]);
    assert.deepEqual(await ctx.hmr.getLinked(url('middle.cjs')), []);
    await put('leaf.cjs', 'module.exports = "two";');
    // The observed change event is the official non-module branch, not merely
    // a delay with no activity. A transitive require edge is not in loadCache.
    await until(() => fixture.events.includes(`change:${url('leaf.cjs')}`), 'non-ESM CJS change event');
    await sleep(100);
    assert.equal(reloadCount, 0);
    assert.equal(ctx.hmrFixture.value, 'one');
    assert.equal(count('dispose:start:one'), 0);
  } else if (scenario === 'watch-gate-and-async-cleanup') {
    await put('entry.mjs', source('', '"one"'));
    watch('entry.mjs');
    await load();
    const gate = hold(); fixture.gate = gate.promise;
    await put('entry.mjs', source('', '"two"'));
    await until(() => count('watch:entry.mjs') === 1, 'watch callback entered');
    const oldTicks = count('tick:one');
    ctx.emit('fixture/ping');
    await until(() => count('tick:one') > oldTicks, 'old timer remains live behind watch gate');
    await sleep(50);
    assert.equal(ctx.hmrFixture.value, 'one');
    assert.equal(count('ping:one'), 1);
    assert.equal(count('dispose:start:one'), 0);
    assert.equal(reloadCount, 0);
    const cleanup = hold(); fixture.cleanup = cleanup.promise;
    gate.resolve(); fixture.gate = undefined;
    await until(() => count('dispose:start:one') === 1, 'old async disposer starts');
    assert.equal(ctx.hmrFixture, undefined, 'ungrouped native service disappears before async cleanup completes');
    assert.equal(count('apply:two'), 0, 'new apply waits for old async disposal');
    const ticksDuringCleanup = count('tick:one');
    ctx.emit('fixture/ping');
    await sleep(60);
    assert.equal(count('ping:one'), 1);
    assert.equal(count('tick:one'), ticksDuringCleanup);
    cleanup.resolve(); fixture.cleanup = undefined;
    await expectReplacement('one', 'two', 1);
  } else if (scenario === 'grouped-resource-lease') {
    await put('entry.mjs', source('', '"one"', true));
    watch('entry.mjs');
    await load();
    const captured = ctx.hmrFixture;
    const cleanup = hold(); fixture.cleanup = cleanup.promise;
    await put('entry.mjs', source('', '"two"', true));
    await until(() => count('dispose:start:one') === 1, 'grouped cleanup starts');
    const oldTicks = count('tick:one');
    ctx.emit('fixture/ping');
    await until(() => count('tick:one') > oldTicks, 'grouped old timer remains live');
    assert.equal(ctx.hmrFixture.value, 'one', 'grouped provide disposer is held');
    assert.equal(captured.value, 'one', 'captured service remains available');
    assert.equal(count('ping:one'), 1, 'grouped event disposer is held');
    assert.equal(count('apply:two'), 0);
    cleanup.resolve(); fixture.cleanup = undefined;
    await expectReplacement('one', 'two', 1);
  } else if (scenario === 'import-vs-apply-failure') {
    await put('entry.mjs', source('', '"one"'));
    watch('entry.mjs');
    const id = await load();
    for (const [broken, expectedError] of [
      ['export default function (', 'SyntaxError'],
      ['throw new Error("fixture-import-rejected"); export default function() {}', 'fixture-import-rejected'],
      ['export default 42;', 'invalid plugin'],
    ]) {
      const logStart = logs.length;
      // Keep separate edits outside chokidar's rapid-change coalescing window.
      await sleep(150);
      await put('entry.mjs', broken);
      await until(() => logs.slice(logStart).some((line) => line.includes(expectedError)), expectedError);
      assert.equal(ctx.hmrFixture.value, 'one', 'import/validation failure preserves live old plugin');
      assert.equal(count('dispose:start:one'), 0);
      assert.equal(reloadCount, 0);
      const tickStart = count('tick:one');
      await until(() => count('tick:one') > tickStart, 'old timer survives failed import');
    }
    await sleep(150);
    await put('entry.mjs', source('', '"two"'));
    await expectReplacement('one', 'two', 1);
    await sleep(150);
    await put('entry.mjs', source('', '"broken"', false, true));
    await until(() => logs.some((line) => line.includes('fixture-apply-rejected')) && count('dispose:end:broken') === 1, 'failed apply cleanup');
    await ctx.loader.await();
    await assert.rejects(ctx.loader.resolve(id).fiber.await(), /fixture-apply-rejected/);
    assert.equal(ctx.hmrFixture, undefined);
    assert.equal(fixture.active, undefined);
    assert.equal(count('dispose:end:two'), 1, 'old generation was already removed');
    assert.equal(count('apply:two'), 1, 'apply failure does not automatically restore old generation');
    const oldPings = count('ping:two');
    ctx.emit('fixture/ping');
    assert.equal(count('ping:two'), oldPings);
    assert.equal(count('ping:broken'), 0, 'failed candidate listener was cleaned');
    const failedTicks = count('tick:broken');
    await sleep(60);
    assert.equal(count('tick:broken'), failedTicks, 'failed candidate timer was cleaned');
    await sleep(150);
    await put('entry.mjs', source('', '"recovered"'));
    await until(() => fixture.active === 'recovered', 'recovery after failed apply');
    await ctx.loader.resolve(id).fiber.await();
    assert.equal(ctx.hmrFixture.value, 'recovered');
  } else {
    throw new Error(`Unknown HMR scenario: ${scenario}`);
  }
  finalResult = { scenario, reloadCount, events: fixture.events.filter((event) => !event.startsWith('tick:')), sourceHmr: true };
} finally {
  for (const release of releases) release();
  fixture.gate = undefined;
  fixture.cleanup = undefined;
  await ctx.fiber.dispose();
  await rm(dir, { recursive: true, force: true });
  delete globalThis.fixture;
}
// Success is emitted only after assertions AND teardown. loader.exit() can return
// exit code zero, so the parent must require this exact completion record too.
console.log(`MIRA_OFFICIAL_HMR_RESULT:${JSON.stringify(finalResult)}`);
