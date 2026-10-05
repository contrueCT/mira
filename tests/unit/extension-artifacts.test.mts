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
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-artifacts-'));
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

test('standalone external TypeScript file links retain their resolved filename and syntax support', async () => {
  await withWorkspace(async (source, store, root) => {
    const target = path.join(root, 'typed-constants.ts');
    await writeFile(target, 'export const value: number = 42;');
    await symlink(target, path.join(source, 'linked.ts'));
    await writeFile(path.join(source, 'entry.mjs'), 'export { value } from "./linked.ts";');
    assert.equal((await import(pathToFileURL(path.join(source, 'entry.mjs')).href) as { value: number }).value, 42);
    const artifact = await store.stage(source, 'entry.mjs');
    await rm(source, { recursive: true });
    await rm(target);
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
    assert.equal(await realpath(path.join(artifact.directory, 'node_modules', 'local')), path.join(artifact.directory, 'packages', 'local'));
    assert.deepEqual(await readdir(path.join(path.dirname(artifact.directory), 'dependencies')), []);
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
    const relocatedSource = path.join(root, 'relocated', 'workspace');
    const relocatedBundle = path.join(root, 'relocated', 'bundle');
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
