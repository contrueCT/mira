import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArtifactStore } from '@mira/extension-host';

async function withWorkspace(run: (source: string, store: ArtifactStore, root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-extension-artifacts-')));
  try {
    const source = path.join(root, 'external-workspace');
    await mkdir(source);
    await run(source, new ArtifactStore(path.join(root, 'artifacts')), root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
async function entry(source: string): Promise<void> {
  await writeFile(path.join(source, 'entry.mjs'), 'export default { name: "synthetic", apply() {} };\n');
}

// These fixtures are known synthetic code. Staging itself only copies files;
// explicit test/import operations execute on this same OS account, without a
// claimed security sandbox, registry access, installation or package scripts.
test('staging snapshots complete ordinary workspaces without imports or package scripts', async () => {
  await withWorkspace(async (source, store, root) => {
    const sentinel = path.join(root, 'must-not-run');
    await writeFile(path.join(source, 'entry.mjs'), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'imported'); export default {};\n`);
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ scripts: { prepare: `touch ${sentinel}`, test: `touch ${sentinel}` } }));
    await mkdir(path.join(source, 'assets'));
    await mkdir(path.join(source, 'empty'));
    await writeFile(path.join(source, 'assets', 'bytes.bin'), Buffer.from([0, 1, 2, 255]));
    await writeFile(path.join(source, '.hidden'), 'included');
    const artifact = await store.stage(source, 'entry.mjs');
    assert.match(artifact.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(await readFile(path.join(artifact.directory, 'assets', 'bytes.bin')), Buffer.from([0, 1, 2, 255]));
    assert.equal(await readFile(path.join(artifact.directory, '.hidden'), 'utf8'), 'included');
    assert.equal((await lstat(path.join(artifact.directory, 'empty'))).isDirectory(), true);
    await assert.rejects(lstat(sentinel), { code: 'ENOENT' });
    assert.deepEqual(await store.read(artifact.digest), artifact);
    assert.deepEqual(await store.list(), [artifact]);
    assert.equal(await store.testResult(artifact), undefined);
    assert.deepEqual(await store.stage(source, 'entry.mjs', artifact.digest), artifact);
    assert.deepEqual(await readdir(path.join(store.root, 'staging')), []);
    await assert.rejects(store.stage(source, 'entry.mjs', '0'.repeat(64)), /digest mismatch/);
    await writeFile(path.join(source, 'assets', 'bytes.bin'), 'changed');
    const changed = await store.stage(source, 'entry.mjs');
    assert.notEqual(changed.digest, artifact.digest);
    assert.deepEqual(await readFile(path.join(artifact.directory, 'assets', 'bytes.bin')), Buffer.from([0, 1, 2, 255]));
  });
});

test('entry selection, file names, executable modes, and dependency bytes participate in identity', async () => {
  await withWorkspace(async (source, store, root) => {
    await entry(source);
    await writeFile(path.join(source, 'other.mjs'), 'export default {};');
    await mkdir(path.join(source, 'node_modules'));
    const dependency = path.join(root, 'local-dependency');
    await mkdir(dependency);
    await writeFile(path.join(dependency, 'value.mjs'), 'export default 1;');
    await symlink(dependency, path.join(source, 'node_modules', 'local'));
    const initial = await store.stage(source, 'entry.mjs');
    assert.notEqual((await store.stage(source, 'other.mjs')).digest, initial.digest);
    await chmod(path.join(source, 'entry.mjs'), 0o744);
    const executable = await store.stage(source, 'entry.mjs');
    assert.notEqual(executable.digest, initial.digest);
    await writeFile(path.join(dependency, 'value.mjs'), 'export default 2;');
    const updated = await store.stage(source, 'entry.mjs');
    assert.notEqual(updated.digest, executable.digest);
    await writeFile(path.join(dependency, 'extra'), 'included');
    assert.notEqual((await store.stage(source, 'entry.mjs')).digest, updated.digest);
    assert.equal(await readFile(path.join(initial.directory, 'node_modules', 'local', 'value.mjs'), 'utf8'), 'export default 1;');
  });
});

test('a local symlinked TypeScript SDK resolves privately outside node_modules after source removal', async () => {
  await withWorkspace(async (source, store) => {
    const sdk = path.dirname(path.dirname(fileURLToPath(import.meta.resolve('@mira/extension-sdk'))));
    await mkdir(path.join(source, 'node_modules', '@mira'), { recursive: true });
    await symlink(sdk, path.join(source, 'node_modules', '@mira', 'extension-sdk'));
    await writeFile(path.join(source, 'entry.mjs'), `import { defineExtension } from '@mira/extension-sdk'; export default defineExtension({ name: 'private-sdk', apply() {} });\n`);
    const artifact = await store.stage(source, 'entry.mjs');
    const privateSdk = await realpath(path.join(artifact.directory, 'node_modules', '@mira', 'extension-sdk'));
    assert.ok(privateSdk.startsWith(path.dirname(artifact.directory) + path.sep));
    assert.ok(!privateSdk.split(path.sep).includes('node_modules'));
    await rm(source, { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    const module = await import(pathToFileURL(fresh.entry).href) as { default: { name: string; apply: unknown } };
    assert.equal(module.default.name, 'private-sdk');
    assert.equal(typeof module.default.apply, 'function');
  });
});

test('workspace-internal TypeScript file links retain their resolved filename and syntax support', async () => {
  await withWorkspace(async (source, store, root) => {
    const target = path.join(source, 'typed-constants.ts');
    await writeFile(target, 'export const value: number = 42;');
    await symlink(target, path.join(source, 'linked.ts'));
    await writeFile(path.join(source, 'entry.mjs'), 'export { value } from "./linked.ts";');
    assert.equal((await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { value: number }).value, 42);
    const artifact = await store.stage(source, 'entry.mjs');
    await rm(source, { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    assert.equal(path.basename(await realpath(path.join(fresh.directory, 'linked.ts'))), 'typed-constants.ts');
    assert.equal((await import(pathToFileURL(fresh.entry).href) as { value: number }).value, 42);
  });
});

test('workspace package symlinks keep their sibling imports in the original snapshot layout', async () => {
  await withWorkspace(async (source, store) => {
    await mkdir(path.join(source, 'packages', 'local'), { recursive: true });
    await mkdir(path.join(source, 'node_modules'));
    await writeFile(path.join(source, 'packages', 'shared.mjs'), 'export const value = 42;');
    await writeFile(path.join(source, 'packages', 'local', 'package.json'), JSON.stringify({ name: 'local', type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(source, 'packages', 'local', 'index.mjs'), 'export { value } from "../shared.mjs";');
    await symlink('../packages/local', path.join(source, 'node_modules', 'local'));
    await writeFile(path.join(source, 'entry.mjs'), 'export { value } from "local";');
    assert.equal((await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { value: number }).value, 42);
    const artifact = await store.stage(source, 'entry.mjs');
    assert.equal(await realpath(path.join(artifact.directory, 'node_modules', 'local')), await realpath(path.join(artifact.directory, 'packages', 'local')));
    assert.deepEqual(await readdir(path.join(path.dirname(artifact.directory), 'dependencies', 'tree')), [path.basename(source)]);
    await rm(source, { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    assert.equal((await import(pathToFileURL(fresh.entry).href) as { value: number }).value, 42);
  });
});

test('links into a materialized external dependency retain its parent and sibling files', async () => {
  await withWorkspace(async (source, store, root) => {
    const dependency = path.join(root, 'external-bundle');
    await mkdir(path.join(dependency, 'packages', 'local'), { recursive: true });
    await writeFile(path.join(dependency, 'shared.mjs'), 'export const value = 42;');
    await writeFile(path.join(dependency, 'packages', 'local', 'package.json'), JSON.stringify({ name: 'local', type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(dependency, 'packages', 'local', 'index.mjs'), 'export { value } from "../../shared.mjs";');
    await mkdir(path.join(source, '.deps'));
    await mkdir(path.join(source, 'node_modules'));
    await symlink(dependency, path.join(source, '.deps', 'bundle'));
    await symlink(path.join(dependency, 'packages', 'local'), path.join(source, 'node_modules', 'local'));
    await writeFile(path.join(source, 'entry.mjs'), 'export { value } from "local";');
    assert.equal((await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { value: number }).value, 42);
    const artifact = await store.stage(source, 'entry.mjs');
    assert.equal(await realpath(path.join(artifact.directory, 'node_modules', 'local')), await realpath(path.join(artifact.directory, '.deps', 'bundle', 'packages', 'local')));
    assert.equal((await readdir(path.join(path.dirname(artifact.directory), 'dependencies'))).length, 1);
    await rm(source, { recursive: true });
    await rm(dependency, { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    assert.equal((await import(pathToFileURL(fresh.entry).href) as { value: number }).value, 42);
  });
});

test('child-first overlapping external aliases share one complete tree and module instance', async () => {
  await withWorkspace(async (source, store, root) => {
    const bundle = path.join(root, 'external-bundle');
    const create = async (workspace: string, dependency: string): Promise<void> => {
      await mkdir(path.join(dependency, 'packages', 'local'), { recursive: true });
      await writeFile(path.join(dependency, 'shared.mjs'), 'export const value = 42;');
      await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'z-bundle', type: 'module', exports: { './local': './packages/local/index.mjs' } }));
      await writeFile(path.join(dependency, 'packages', 'local', 'package.json'), JSON.stringify({ name: 'a-local', type: 'module', exports: './index.mjs' }));
      await writeFile(path.join(dependency, 'packages', 'local', 'index.mjs'), 'import { value } from "../../shared.mjs"; let count = 0; export const read = () => [value, ++count];');
      await mkdir(path.join(workspace, 'node_modules'), { recursive: true });
      await symlink(path.join(dependency, 'packages', 'local'), path.join(workspace, 'node_modules', 'a-local'));
      await symlink(dependency, path.join(workspace, 'node_modules', 'z-bundle'));
      await writeFile(path.join(workspace, 'entry.mjs'), 'import * as child from "a-local"; import * as parent from "z-bundle/local"; export const same = child === parent; export const values = [child.read(), parent.read()];');
    };
    await create(source, bundle);
    const original = await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { same: boolean; values: number[][] };
    assert.equal(original.same, true);
    assert.deepEqual(original.values, [[42, 1], [42, 2]]);
    const artifact = await store.stage(source, 'entry.mjs');
    assert.equal(await realpath(path.join(artifact.directory, 'node_modules', 'a-local')), await realpath(path.join(artifact.directory, 'node_modules', 'z-bundle', 'packages', 'local')));
    assert.equal((await readdir(path.join(path.dirname(artifact.directory), 'dependencies'))).length, 1);
    const relocatedSource = path.join(root, 'relocated', 'external-workspace');
    const relocatedBundle = path.join(root, 'relocated', 'external-bundle');
    await create(relocatedSource, relocatedBundle);
    assert.equal((await store.stage(relocatedSource, 'entry.mjs')).digest, artifact.digest);
    await rm(source, { recursive: true });
    await rm(bundle, { recursive: true });
    await rm(path.join(root, 'relocated'), { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    const restored = await import(pathToFileURL(fresh.entry).href) as { same: boolean; values: number[][] };
    assert.equal(restored.same, true);
    assert.deepEqual(restored.values, [[42, 1], [42, 2]]);
  });
});

test('store root and ancestor directory aliases preserve private linked artifact verification', async () => {
  await withWorkspace(async (source, store, root) => {
    await mkdir(path.join(source, 'packages', 'local'), { recursive: true });
    await mkdir(path.join(source, 'node_modules'));
    await writeFile(path.join(source, 'packages', 'local', 'package.json'), JSON.stringify({ name: 'local', type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(source, 'packages', 'local', 'index.mjs'), 'export const value = 42;');
    await symlink('../packages/local', path.join(source, 'node_modules', 'local'));
    await writeFile(path.join(source, 'entry.mjs'), 'export { value } from "local";');
    await mkdir(store.root);
    const rootAlias = path.join(root, 'alias-store');
    const parentAlias = path.join(root, 'alias-parent');
    await symlink(store.root, rootAlias);
    await symlink(root, parentAlias);
    let digest: string | undefined;
    for (const directory of [rootAlias, path.join(parentAlias, 'artifacts')]) {
      const aliased = new ArtifactStore(directory);
      const artifact = await aliased.stage(source, 'entry.mjs', digest);
      digest = artifact.digest;
      await aliased.verify(artifact);
      assert.deepEqual(await aliased.read(artifact.digest), artifact);
      const result = await aliased.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', 'import { value } from "./entry.mjs"; if (value !== 42) throw Error("wrong linked artifact");'] });
      assert.equal(result.passed, true);
      assert.equal(result.unchanged, true);
      assert.equal((await aliased.testResult(artifact))!.passed, true);
      const fresh = await aliased.prepareFreshActivation(artifact);
      assert.equal((await import(pathToFileURL(fresh.entry).href) as { value: number }).value, 42);
    }
    assert.ok(digest);
    const artifact = await store.read(digest);
    await store.verify(artifact);
    const release = path.dirname(artifact.directory);
    await rename(release, `${release}-moved`);
    await symlink(`${path.basename(release)}-moved`, release);
    await assert.rejects(store.verify(artifact), /release cannot be a symlink/);
  });
});

test('separately supplied sibling roots retain relative imports and shared module identity', async () => {
  await withWorkspace(async (source, store, root) => {
    const local = path.join(root, 'local'), shared = path.join(root, 'shared');
    await mkdir(local); await mkdir(shared); await mkdir(path.join(source, 'node_modules'));
    await writeFile(path.join(local, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(shared, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(shared, 'index.mjs'), 'export const value = { number: 42 };');
    await writeFile(path.join(local, 'index.mjs'), 'export { value } from "../shared/index.mjs";');
    await symlink(local, path.join(source, 'node_modules', 'local'));
    await symlink(shared, path.join(source, 'node_modules', 'shared'));
    await writeFile(path.join(source, 'entry.mjs'), 'import { value as local } from "local"; import { value as shared } from "shared"; export const result = [local === shared, local.number];');
    assert.deepEqual((await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { result: unknown }).result, [true, 42]);
    const artifact = await store.stage(source, 'entry.mjs');
    await rm(source, { recursive: true }); await rm(local, { recursive: true }); await rm(shared, { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    assert.deepEqual((await import(pathToFileURL(fresh.entry).href) as { result: unknown }).result, [true, 42]);
  });
});

async function hoistedFixture(source: string, root: string, supplyExact: boolean): Promise<{ local: string; exact: string }> {
  const local = path.join(root, 'bundle', 'packages', 'local');
  const exact = path.join(root, 'versions', 'helper-42'), other = path.join(root, 'versions', 'helper-99');
  await mkdir(local, { recursive: true }); await mkdir(exact, { recursive: true }); await mkdir(other);
  await mkdir(path.join(root, 'bundle', 'node_modules')); await mkdir(path.join(source, 'node_modules'));
  for (const [directory, value] of [[exact, 42], [other, 99]] as const) {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'helper', type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(directory, 'index.mjs'), `export const state = { value: ${value}, count: 0 }; export const next = () => ++state.count;`);
  }
  await writeFile(path.join(local, 'package.json'), JSON.stringify({ name: 'local', type: 'module', exports: './index.mjs', dependencies: { helper: '*' }, optionalDependencies: { 'absent-optional': '*' }, peerDependencies: { 'absent-peer': '*' }, devDependencies: { 'unused-build-tool': '*' } }));
  await writeFile(path.join(local, 'index.mjs'), 'export { state, next } from "helper";');
  await mkdir(path.join(root, 'bundle', 'node_modules', 'unused-build-tool'));
  await writeFile(path.join(root, 'bundle', 'node_modules', 'unused-build-tool', 'package.json'), '{}');
  await symlink(exact, path.join(root, 'bundle', 'node_modules', 'helper'));
  await symlink(local, path.join(source, 'node_modules', 'local'));
  await symlink(other, path.join(source, 'node_modules', 'helper'));
  if (supplyExact) await symlink(exact, path.join(source, 'node_modules', 'exact-helper'));
  await writeFile(path.join(source, 'entry.mjs'), 'import * as local from "local"; import * as exact from "exact-helper"; import * as workspace from "helper"; export const result = [local.state === exact.state, local.state.value, workspace.state.value, local.next(), exact.next()];');
  return { local, exact };
}

test('declared hoisted dependencies retain the exact original version and module identity', async () => {
  await withWorkspace(async (source, store, root) => {
    const fixture = await hoistedFixture(source, root, true);
    assert.deepEqual((await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { result: unknown }).result, [true, 42, 99, 1, 2]);
    const artifact = await store.stage(source, 'entry.mjs');
    // A package-local dependency must keep precedence over the ancestor alias.
    await mkdir(path.join(fixture.local, 'node_modules'));
    const shadow = path.join(fixture.local, 'node_modules', 'helper');
    await mkdir(shadow);
    await writeFile(path.join(shadow, 'package.json'), JSON.stringify({ type: 'module', exports: './index.mjs' }));
    await writeFile(path.join(shadow, 'index.mjs'), 'export const state = { value: 7 }; export const next = () => 7;');
    const shadowed = await store.stage(source, 'entry.mjs');
    await rm(source, { recursive: true }); await rm(path.join(root, 'bundle'), { recursive: true }); await rm(path.join(root, 'versions'), { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    assert.deepEqual((await import(pathToFileURL(fresh.entry).href) as { result: unknown }).result, [true, 42, 99, 1, 2]);
    const latest = await store.prepareFreshActivation(shadowed);
    assert.deepEqual((await import(pathToFileURL(latest.entry).href) as { result: unknown }).result, [false, 7, 99, 7, 1]);
    const tested = await store.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', 'import { result } from "./entry.mjs"; if (JSON.stringify(result) !== "[true,42,99,1,2]") throw Error("wrong dependency closure");'] });
    assert.equal(tested.passed, true);
  });
});

test('an originally resolved runtime dependency outside the explicit closure cannot bind another workspace version', async () => {
  await withWorkspace(async (source, store, root) => {
    await hoistedFixture(source, root, false);
    await assert.rejects(store.stage(source, 'entry.mjs'), /Missing dependency closure for helper/);
    assert.deepEqual(await store.list(), []);
  });
});

test('standalone external files and inherited package scopes require the containing package directory', async () => {
  await withWorkspace(async (source, store, root) => {
    const external = path.join(root, 'external-package');
    await mkdir(path.join(external, 'lib'), { recursive: true });
    await writeFile(path.join(external, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(path.join(external, 'lib', 'probe.js'), 'if (typeof module !== "undefined") throw Error("package scope changed");');
    await symlink(path.join(external, 'lib', 'probe.js'), path.join(source, 'probe.js'));
    await writeFile(path.join(source, 'entry.mjs'), 'import "./probe.js"; export const value = 42;');
    assert.equal((await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { value: number }).value, 42);
    await assert.rejects(store.stage(source, 'entry.mjs'), /External file link.*containing package directory/);
    await symlink(path.join(external, 'lib'), path.join(source, 'linked-lib'));
    await assert.rejects(store.stage(source, 'entry.mjs'), /Inherited package scope.*containing package directory/);
    await symlink(external, path.join(source, 'complete-package'));
    const artifact = await store.stage(source, 'entry.mjs');
    await rm(source, { recursive: true }); await rm(external, { recursive: true });
    const fresh = await store.prepareFreshActivation(artifact);
    assert.equal((await import(pathToFileURL(fresh.entry).href) as { value: number }).value, 42);
  });
});

test('the release scope barrier prevents the artifact store ancestors from changing module type', async () => {
  await withWorkspace(async (source, _store, root) => {
    await writeFile(path.join(source, 'probe.js'), 'module.exports = 42;');
    await writeFile(path.join(source, 'entry.mjs'), 'export { default as value } from "./probe.js";');
    const parent = path.join(root, 'store-parent'); await mkdir(parent);
    await writeFile(path.join(parent, 'package.json'), JSON.stringify({ type: 'module' }));
    const store = new ArtifactStore(path.join(parent, 'store'));
    const artifact = await store.stage(source, 'entry.mjs');
    assert.equal(await readFile(path.join(path.dirname(artifact.directory), 'package.json'), 'utf8'), '{}\n');
    const fresh = await store.prepareFreshActivation(artifact);
    assert.equal((await import(pathToFileURL(fresh.entry).href) as { value: number }).value, 42);
  });
});

test('the mirror preserves an original node_modules TypeScript restriction', async () => {
  await withWorkspace(async (_source, store, root) => {
    const source = path.join(root, 'node_modules', 'generated'); await mkdir(source, { recursive: true });
    await writeFile(path.join(source, 'typed.ts'), 'export const value: number = 42;');
    await writeFile(path.join(source, 'entry.mjs'), 'export { value } from "./typed.ts";');
    await assert.rejects(import(pathToFileURL(path.join(source, 'entry.mjs')).href), { code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' });
    const artifact = await store.stage(source, 'entry.mjs');
    const fresh = await store.prepareFreshActivation(artifact);
    await assert.rejects(import(pathToFileURL(fresh.entry).href), { code: 'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING' });
  });
});

async function absentDependencyFixture(source: string, root: string, field = 'optionalDependencies'): Promise<{ store: ArtifactStore; host: string; marker: string }> {
  const host = path.join(root, 'store-parent');
  await mkdir(host);
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ [field]: { 'synthetic-optional': '*' } }));
  await writeFile(path.join(source, 'entry.cjs'), 'try { module.exports = require("synthetic-optional").count; } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; module.exports = "absent"; }');
  return { store: new ArtifactStore(path.join(host, 'store')), host, marker: `__miraAmbient_${path.basename(root)}` };
}
async function ambientPackage(parent: string, marker: string): Promise<void> {
  const directory = path.join(parent, 'node_modules', 'synthetic-optional');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'synthetic-optional', main: './index.cjs' }));
  await writeFile(path.join(directory, 'index.cjs'), `globalThis[${JSON.stringify(marker)}] = (globalThis[${JSON.stringify(marker)}] ?? 0) + 1; module.exports = { count: globalThis[${JSON.stringify(marker)}] };`);
}
const ambientValue = (marker: string): unknown => (globalThis as unknown as Record<string, unknown>)[marker];
const escapedDependency = /Artifact declared dependency synthetic-optional resolves outside its private tree/;

test('staging rejects ambient host packages for runtime, optional, peer, and workspace-dev declarations without importing them', async () => {
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    await withWorkspace(async (source, _store, root) => {
      const fixture = await absentDependencyFixture(source, root, field);
      assert.equal((await import(pathToFileURL(path.join(source, 'entry.cjs')).href) as { default: unknown }).default, 'absent');
      await ambientPackage(fixture.host, fixture.marker);
      await assert.rejects(fixture.store.stage(source, 'entry.cjs'), escapedDependency);
      assert.equal(ambientValue(fixture.marker), undefined);
      assert.deepEqual(await fixture.store.list(), []);
    });
  }
});

test('read, verify, and activation reject a host optional package that appears after staging', async () => {
  await withWorkspace(async (source, _store, root) => {
    const fixture = await absentDependencyFixture(source, root);
    const artifact = await fixture.store.stage(source, 'entry.cjs');
    await ambientPackage(fixture.host, fixture.marker);
    await assert.rejects(fixture.store.read(artifact.digest), escapedDependency);
    await assert.rejects(fixture.store.verify(artifact), escapedDependency);
    await assert.rejects(fixture.store.prepareFreshActivation(artifact), escapedDependency);
    assert.equal(ambientValue(fixture.marker), undefined);
    await rm(path.join(fixture.host, 'node_modules'), { recursive: true });
    await fixture.store.verify(artifact);
    const fresh = await fixture.store.prepareFreshActivation(artifact);
    assert.equal((await import(pathToFileURL(fresh.entry).href) as { default: unknown }).default, 'absent');
  });
});

test('a passed test cannot authorize an ambient peer package introduced afterward', async () => {
  await withWorkspace(async (source, _store, root) => {
    const fixture = await absentDependencyFixture(source, root, 'peerDependencies');
    const artifact = await fixture.store.stage(source, 'entry.cjs');
    const result = await fixture.store.test(artifact, { command: process.execPath, args: ['-e', 'if (require("./entry.cjs") !== "absent") throw Error("unexpected host dependency");'] });
    assert.equal(result.passed, true);
    await ambientPackage(fixture.host, fixture.marker);
    await assert.rejects(fixture.store.testResult(artifact), escapedDependency);
    await assert.rejects(fixture.store.prepareFreshActivation(artifact), escapedDependency);
    assert.equal(ambientValue(fixture.marker), undefined);
  });
});

test('fresh-copy verification rejects dependencies visible only from the activation parent', async () => {
  await withWorkspace(async (source, _store, root) => {
    const fixture = await absentDependencyFixture(source, root);
    const artifact = await fixture.store.stage(source, 'entry.cjs');
    const activationParent = path.join(fixture.store.root, 'activations');
    await ambientPackage(activationParent, fixture.marker);
    await fixture.store.verify(artifact); // The release has no such ancestor package.
    await assert.rejects(fixture.store.prepareFreshActivation(artifact), escapedDependency);
    assert.equal(ambientValue(fixture.marker), undefined);
    assert.deepEqual(await readdir(activationParent), ['node_modules']);
  });
});

const bareFileDependency = /Declared bare-file dependency synthetic-file-dep.*containing package directory.*explicit relative import/;

test('original declared exact and CJS-suffixed bare files require an explicit supported layout', async () => {
  for (const suffix of ['', '.js', '.json', '.node']) {
    await withWorkspace(async (source, store, root) => {
      await mkdir(path.join(root, 'node_modules'));
      await writeFile(path.join(root, 'node_modules', `synthetic-file-dep${suffix}`), suffix === '.json' ? '{}' : 'Known fixture bytes; never imported');
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { 'synthetic-file-dep': '*' } }));
      await entry(source);
      await assert.rejects(store.stage(source, 'entry.mjs'), bareFileDependency);
      assert.deepEqual(await store.list(), []);
    });
  }
});

test('late host exact and CJS-suffixed files are rejected after a clean stage and test', async () => {
  for (const suffix of ['', '.js', '.json', '.node']) {
    await withWorkspace(async (source, _store, root) => {
      const host = path.join(root, 'store-parent'); await mkdir(host);
      const store = new ArtifactStore(path.join(host, 'store'));
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ optionalDependencies: { 'synthetic-file-dep': '*' } }));
      await writeFile(path.join(source, 'entry.cjs'), 'try { module.exports = require("synthetic-file-dep"); } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; module.exports = "absent"; }');
      const artifact = await store.stage(source, 'entry.cjs');
      const result = await store.test(artifact, { command: process.execPath, args: ['-e', 'if (require("./entry.cjs") !== "absent") throw Error("unexpected dependency");'] });
      assert.equal(result.passed, true);
      await mkdir(path.join(host, 'node_modules'));
      await writeFile(path.join(host, 'node_modules', `synthetic-file-dep${suffix}`), suffix === '.json' ? '{}' : 'Known fixture bytes; never imported');
      await assert.rejects(store.verify(artifact), bareFileDependency);
      await assert.rejects(store.read(artifact.digest), bareFileDependency);
      await assert.rejects(store.testResult(artifact), bareFileDependency);
      await assert.rejects(store.prepareFreshActivation(artifact), bareFileDependency);
    });
  }
});

test('declared directories with same-name local or ancestor CJS suffix files are rejected as ambiguous', async () => {
  await withWorkspace(async (source, store, root) => {
    const directory = path.join(source, 'node_modules', 'synthetic-file-dep');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ main: './index.cjs' }));
    await writeFile(path.join(directory, 'index.cjs'), 'module.exports = 42;');
    await writeFile(`${directory}.js`, 'module.exports = 99;');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { 'synthetic-file-dep': '*' } }));
    await entry(source);
    await assert.rejects(store.stage(source, 'entry.mjs'), bareFileDependency);
    await rm(`${directory}.js`);
    await rm(path.join(directory, 'index.cjs'));
    await mkdir(path.join(root, 'node_modules'));
    await writeFile(path.join(root, 'node_modules', 'synthetic-file-dep.js'), 'module.exports = 99;');
    await assert.rejects(store.stage(source, 'entry.mjs'), bareFileDependency);
  });
});

async function completeHelper(directory: string, value = 42): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'helper', main: './index.cjs' }));
  await writeFile(path.join(directory, 'index.cjs'), `module.exports = { value: ${value} };`);
}

test('an empty nearer package cannot hide an uncaptured valid ancestor package', async () => {
  await withWorkspace(async (source, store, root) => {
    await mkdir(path.join(source, 'node_modules', 'helper'), { recursive: true });
    const ancestor = path.join(root, 'node_modules', 'helper');
    await completeHelper(ancestor);
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { helper: '*' } }));
    await writeFile(path.join(source, 'entry.cjs'), 'module.exports = require("helper").value;');
    assert.equal((await import(pathToFileURL(path.join(source, 'entry.cjs')).href) as { default: number }).default, 42);
    await assert.rejects(store.stage(source, 'entry.cjs'), /Missing dependency closure for helper/);
    await symlink(ancestor, path.join(source, 'captured-ancestor'));
    const separate = await mkdtemp(path.join(os.tmpdir(), 'mira-detached-artifact-store-'));
    try {
      const detached = new ArtifactStore(separate);
      const artifact = await detached.stage(source, 'entry.cjs');
      await rm(source, { recursive: true }); await rm(path.join(root, 'node_modules'), { recursive: true });
      const fresh = await detached.prepareFreshActivation(artifact);
      assert.equal((await import(pathToFileURL(fresh.entry).href) as { default: number }).default, 42);
    } finally { await rm(separate, { recursive: true, force: true }); }
  });
});

test('ambient farther packages are rejected after a passed test even with an empty or complete nearer package', async () => {
  for (const complete of [false, true]) {
    await withWorkspace(async (source, _store, root) => {
      const nearest = path.join(source, 'node_modules', 'helper');
      if (complete) await completeHelper(nearest, 1); else await mkdir(nearest, { recursive: true });
      await writeFile(path.join(source, 'package.json'), JSON.stringify({ optionalDependencies: { helper: '*' } }));
      await writeFile(path.join(source, 'entry.cjs'), 'try { module.exports = require("helper").value; } catch (error) { if (error.code !== "MODULE_NOT_FOUND") throw error; module.exports = "absent"; }');
      const host = path.join(root, 'store-parent'); await mkdir(host);
      const store = new ArtifactStore(path.join(host, 'store'));
      const artifact = await store.stage(source, 'entry.cjs');
      const expected = complete ? 1 : 'absent';
      const tested = await store.test(artifact, { command: process.execPath, args: ['-e', `if (require("./entry.cjs") !== ${JSON.stringify(expected)}) throw Error("unexpected helper");`] });
      assert.equal(tested.passed, true);
      const ancestor = path.join(host, 'node_modules', 'helper');
      await completeHelper(ancestor);
      await writeFile(path.join(ancestor, 'subpath.js'), 'module.exports = 42;');
      await assert.rejects(store.verify(artifact), /Artifact declared dependency helper resolves outside/);
      await assert.rejects(store.testResult(artifact), /Artifact declared dependency helper resolves outside/);
      await assert.rejects(store.prepareFreshActivation(artifact), /Artifact declared dependency helper resolves outside/);
      await writeFile(path.join(ancestor, 'index.cjs'), 'module.exports = { value: 99 };');
      await assert.rejects(store.read(artifact.digest), /Artifact declared dependency helper resolves outside/);
    });
  }
});

test('an uncaptured ancestor subpath cannot hide behind a complete nearer bare package', async () => {
  await withWorkspace(async (source, store, root) => {
    await completeHelper(path.join(source, 'node_modules', 'helper'), 1);
    const ancestor = path.join(root, 'node_modules', 'helper');
    await completeHelper(ancestor, 2);
    await writeFile(path.join(ancestor, 'subpath.js'), 'module.exports = 42;');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { helper: '*' } }));
    await writeFile(path.join(source, 'entry.cjs'), 'module.exports = require("helper/subpath");');
    assert.equal((await import(pathToFileURL(path.join(source, 'entry.cjs')).href) as { default: number }).default, 42);
    await assert.rejects(store.stage(source, 'entry.cjs'), /Missing dependency closure for helper/);
    await symlink(ancestor, path.join(source, 'captured-ancestor'));
    const separate = await mkdtemp(path.join(os.tmpdir(), 'mira-detached-artifact-store-'));
    try {
      const detached = new ArtifactStore(separate);
      const artifact = await detached.stage(source, 'entry.cjs');
      await rm(source, { recursive: true }); await rm(path.join(root, 'node_modules'), { recursive: true });
      const fresh = await detached.prepareFreshActivation(artifact);
      assert.equal((await import(pathToFileURL(fresh.entry).href) as { default: number }).default, 42);
    } finally { await rm(separate, { recursive: true, force: true }); }
  });
});

test('captured complete CJS packages and import-only exports retain fresh independent module state', async () => {
  await withWorkspace(async (source, store) => {
    const helper = path.join(source, 'node_modules', 'helper');
    await completeHelper(helper);
    await writeFile(path.join(helper, 'index.cjs'), 'let count = 0; module.exports = { next: () => ++count };');
    const only = path.join(source, 'node_modules', 'import-only'); await mkdir(only);
    await writeFile(path.join(only, 'package.json'), JSON.stringify({ exports: { '.': { import: './index.mjs' } } }));
    await writeFile(path.join(only, 'index.mjs'), 'export const value = 42;');
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ dependencies: { helper: '*', 'import-only': '*' } }));
    await writeFile(path.join(source, 'entry.mjs'), 'import helper from "helper"; import { value } from "import-only"; export const result = [helper.next(), value];');
    const artifact = await store.stage(source, 'entry.mjs');
    await rm(source, { recursive: true });
    for (let index = 0; index < 2; index++) {
      const fresh = await store.prepareFreshActivation(artifact);
      assert.deepEqual((await import(pathToFileURL(fresh.entry).href) as { result: number[] }).result, [1, 42]);
    }
  });
});

test('fresh activation and rollback reload ESM and nested CJS dependency state', async () => {
  await withWorkspace(async (source, store) => {
    await writeFile(path.join(source, 'entry.mjs'), `import { value, increment } from './dependency.mjs'; import nested from './nested.cjs'; export const result = [value, increment(), nested];\n`);
    await writeFile(path.join(source, 'dependency.mjs'), 'export const value = "v1"; let count = 0; export const increment = () => ++count;');
    await writeFile(path.join(source, 'nested.cjs'), 'module.exports = require("./deep.cjs");');
    await writeFile(path.join(source, 'deep.cjs'), 'module.exports = "cjs-v1";');
    const first = await store.stage(source, 'entry.mjs');
    const load = async (digest: string): Promise<unknown> => {
      const fresh = await store.prepareFreshActivation(await store.read(digest));
      return (await import(pathToFileURL(fresh.entry).href) as { result: unknown }).result;
    };
    assert.deepEqual(await load(first.digest), ['v1', 1, 'cjs-v1']);
    assert.deepEqual(await load(first.digest), ['v1', 1, 'cjs-v1']);
    await writeFile(path.join(source, 'dependency.mjs'), 'export const value = "v2"; let count = 8; export const increment = () => ++count;');
    await writeFile(path.join(source, 'deep.cjs'), 'module.exports = "cjs-v2";');
    const second = await store.stage(source, 'entry.mjs');
    assert.deepEqual(await load(second.digest), ['v2', 9, 'cjs-v2']);
    assert.deepEqual(await load(first.digest), ['v1', 1, 'cjs-v1']);
  });
});

test('explicit test receipts bind successful exit to unchanged full artifact content', async () => {
  await withWorkspace(async (source, store) => {
    await entry(source);
    const artifact = await store.stage(source, 'entry.mjs');
    const successful = await store.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', 'import extension from "./entry.mjs"; if (extension.name !== "synthetic") throw Error("unexpected"); console.log("checked");'] });
    assert.equal(successful.passed, true);
    assert.equal(successful.unchanged, true);
    assert.equal(successful.afterDigest, artifact.digest);
    assert.equal(successful.exitCode, 0);
    assert.equal(successful.stdout, 'checked\n');
    assert.deepEqual(await store.testResult(artifact), successful);
    await writeFile(path.join(store.root, 'tests', `${artifact.digest}.json`), JSON.stringify({ digest: artifact.digest, passed: true, unchanged: true }));
    await assert.rejects(store.testResult(artifact), /Invalid artifact test receipt/);
    await writeFile(path.join(store.root, 'tests', `${artifact.digest}.json`), JSON.stringify(successful));
    const failed = await store.test(artifact, { command: process.execPath, args: ['-e', 'process.exitCode = 4'] });
    assert.equal(failed.exitCode, 4);
    assert.equal(failed.unchanged, true);
    assert.equal(failed.passed, false);
    const modified = await store.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', 'import { writeFileSync } from "node:fs"; writeFileSync("entry.mjs", "export default null;");'] });
    assert.equal(modified.exitCode, 0);
    assert.equal(modified.unchanged, false);
    assert.equal(modified.passed, false);
    assert.notEqual(modified.afterDigest, artifact.digest);
    assert.match(modified.error ?? '', /modified/);
    await store.verify(artifact);
    assert.deepEqual(await readdir(path.join(store.root, 'activations')), []);
  });
});

test('test receipts report command launch errors and signals rather than a false pass', async () => {
  await withWorkspace(async (source, store, root) => {
    await entry(source);
    const artifact = await store.stage(source, 'entry.mjs');
    const missing = await store.test(artifact, { command: path.join(root, 'no-such-executable') });
    assert.equal(missing.passed, false);
    assert.match(missing.error ?? '', /ENOENT/);
    const signalled = await store.test(artifact, { command: process.execPath, args: ['-e', 'process.kill(process.pid, "SIGTERM")'] });
    assert.equal(signalled.signal, 'SIGTERM');
    assert.equal(signalled.passed, false);
    assert.equal(signalled.exitCode, null);
    assert.equal(signalled.unchanged, true);
  });
});

test('mutated release bytes or links cannot be activated or silently replaced', async () => {
  await withWorkspace(async (source, store, root) => {
    await entry(source);
    const artifact = await store.stage(source, 'entry.mjs');
    await writeFile(artifact.entry, 'export default "changed";');
    await assert.rejects(store.verify(artifact), /content changed/);
    await assert.rejects(store.read(artifact.digest), /content changed/);
    await assert.rejects(store.prepareFreshActivation(artifact), /content changed/);
    await assert.rejects(store.stage(source, 'entry.mjs'), /content changed/);
    await rm(artifact.entry);
    await symlink(path.join(source, 'entry.mjs'), artifact.entry);
    await assert.rejects(store.verify(artifact), /escapes/);
    await assert.rejects(store.verify({ ...artifact, directory: root }), /does not belong/);
  });
});

test('invalid entries, recursive sources, source links into store, and symlink cycles are rejected', async () => {
  await withWorkspace(async (source, store) => {
    await entry(source);
    for (const relative of ['../entry.mjs', '/entry.mjs', './entry.mjs', 'nested/../entry.mjs', 'nested\\entry.mjs', '']) {
      await assert.rejects(store.stage(source, relative), /workspace-relative/);
    }
    await assert.rejects(store.stage(source, 'missing.mjs'), /ENOENT/);
    await assert.rejects(new ArtifactStore(path.join(source, 'artifacts')).stage(source, 'entry.mjs'), /must not contain/);
    await rm(path.join(source, 'artifacts'), { recursive: true });
    await symlink(source, path.join(source, 'cycle'));
    await assert.rejects(store.stage(source, 'entry.mjs'), /Cyclic/);
    await rm(path.join(source, 'cycle'));
    await symlink(store.root, path.join(source, 'store'));
    await assert.rejects(store.stage(source, 'entry.mjs'), /release store/);
    await assert.rejects(store.read('../../elsewhere'), /SHA-256/);
  });
});


test('native artifact CLI stages, reports status, and tests only its explicit command', async () => {
  await withWorkspace(async (source, store) => {
    await entry(source);
    const execute = promisify(execFile);
    const script = fileURLToPath(new URL('../../scripts/extension-artifact.mts', import.meta.url));
    const staged = JSON.parse((await execute(process.execPath, [script, 'stage', store.root, source, 'entry.mjs'])).stdout) as { digest: string };
    const status = JSON.parse((await execute(process.execPath, [script, 'status', store.root, staged.digest])).stdout) as Array<{ test: unknown }>;
    assert.equal(status[0]!.test, null);
    const tested = JSON.parse((await execute(process.execPath, [script, 'test', store.root, staged.digest, '--', process.execPath, '--input-type=module', '-e', 'import extension from "./entry.mjs"; if (extension.name !== "synthetic") throw Error("wrong artifact");'])).stdout) as { passed: boolean; digest: string };
    assert.equal(tested.passed, true);
    assert.equal(tested.digest, staged.digest);
    await assert.rejects(execute(process.execPath, [script, 'test', store.root, staged.digest, '--', process.execPath, '-e', 'process.exit(5)']), { code: 1 });
    assert.equal((await store.testResult(await store.read(staged.digest)))!.exitCode, 5);
    await assert.rejects(execute(process.execPath, [script, 'test', store.root, staged.digest]), /Usage:/);
  });
});

test('optional bin relocation leaves unrelated scripts and unbuilt declarations stageable', async () => {
  await withWorkspace(async (source, store) => {
    await entry(source);
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: 'artifact-fixture', bin: { actual: 'run.cjs', unbuilt: 'dist/cli.js' } }));
    await writeFile(path.join(source, 'run.cjs'), "console.log('captured declared executable');");
    const bin = path.join(source, 'node_modules', '.bin'); await mkdir(bin, { recursive: true });
    const ordinary = '#!/bin/sh\nprintf ordinary\\n\n'; await writeFile(path.join(bin, 'ordinary-script'), ordinary);
    const nested = path.join(source, 'test', 'unbuilt-package'); await mkdir(nested, { recursive: true });
    await writeFile(path.join(nested, 'package.json'), JSON.stringify({ name: 'unbuilt-package', bin: 'dist/cli.js' }));
    const { pnpmNodeShim } = await import('@mira/extension-host/package-bin-shims');
    const target = path.join(source, 'run.cjs');
    const shim = pnpmNodeShim.replaceAll('@@TARGET@@', target).replaceAll('@@RELATIVE@@', '../../run.cjs').replaceAll('@@NODE_PATH@@', path.join(source, 'node_modules'));
    await writeFile(path.join(bin, 'actual'), shim);
    const artifact = await store.stage(source, 'entry.mjs');
    assert.equal(await readFile(path.join(artifact.directory, 'node_modules/.bin/ordinary-script'), 'utf8'), ordinary);
    assert.ok(!(await readFile(path.join(artifact.directory, 'node_modules/.bin/actual'), 'utf8')).includes(target));
    const executed = await store.test(artifact, { command: '/bin/sh', args: ['node_modules/.bin/actual'] });
    assert.equal(executed.passed, true, executed.stderr); assert.equal(executed.unchanged, true);
    assert.match(executed.stdout, /captured declared executable/);
  });
});
