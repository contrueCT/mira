import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ArtifactStore } from '@mira/extension-host';
import { prepareExtensionPackage } from '../../scripts/prepare-extension-package.mts';
async function fixture(run: (root: string) => Promise<void>) { const root = await mkdtemp(path.join(os.tmpdir(), 'mira-package-prep-')); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function pkg(directory: string, manifest: object, body = 'export default {};') { await mkdir(directory, { recursive: true }); await writeFile(path.join(directory, 'package.json'), JSON.stringify({ type: 'module', main: 'index.mjs', ...manifest })); await writeFile(path.join(directory, 'index.mjs'), body); }
async function link(directory: string, name: string, target: string) { const destination = path.join(directory, 'node_modules', name); await mkdir(path.dirname(destination), { recursive: true }); await symlink(target, destination, 'dir'); }

test('package preparation captures only installed runtime closure, preserving pnpm cycles and private topology', async () => fixture(async root => {
  const source = path.join(root, 'source'); const a = path.join(root, 'pnpm/a/node_modules/a'); const b = path.join(root, 'pnpm/b/node_modules/b'); const dev = path.join(root, 'dev');
  await pkg(source, { dependencies: { a: '1' }, devDependencies: { dev: '1' } }, "import { value } from 'a'; export default {name:value};");
  await pkg(a, { dependencies: { b: '1' } }, "import { value as b } from 'b'; export const value = 'a'+b;");
  await pkg(b, { dependencies: { a: '1' } }, "export const value = 'b';");
  await pkg(dev, {}, "throw Error('dev dependency must never be imported');");
  await link(source, 'a', a); await link(source, 'dev', dev); await link(path.dirname(path.dirname(a)), 'b', b); await link(path.dirname(path.dirname(b)), 'a', a);
  const prepared = await prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs'); assert.equal(prepared.packages, 2);
  await assert.rejects(realpath(path.join(prepared.directory, 'package/node_modules/dev')), /ENOENT/);
  const store = new ArtifactStore(path.join(root, 'artifacts')); const artifact = await store.stage(prepared.directory, prepared.entryRelative);
  const receipt = await store.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', "const {default: value} = await import('./entry.mjs'); if(value.name !== 'ab') throw Error('incorrect closure');"] });
  assert.equal(receipt.passed, true, receipt.stderr); assert.equal(receipt.unchanged, true);
}));

test('missing required and peer dependencies fail before writing; absent optional peers and optional overrides are allowed', async () => fixture(async root => {
  const source = path.join(root, 'source'); await pkg(source, { dependencies: { missing: '1' } });
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'target'), 'index.mjs'), /not installed/); await assert.rejects(realpath(path.join(root, 'target')), /ENOENT/);
  await pkg(source, { peerDependencies: { missing: '1' } }); await assert.rejects(prepareExtensionPackage(source, path.join(root, 'target'), 'index.mjs'), /not installed/);
  await pkg(source, { dependencies: { optional: '1' }, optionalDependencies: { optional: '1' }, peerDependencies: { peer: '1' }, peerDependenciesMeta: { peer: { optional: true } } });
  assert.equal((await prepareExtensionPackage(source, path.join(root, 'target'), 'index.mjs')).packages, 0);
}));

test('multiple installed versions stay separate and ambiguous source-level fallback is explicitly rejected', async () => fixture(async root => {
  const source = path.join(root, 'source'); const a = path.join(root, 'pnpm/a/node_modules/a'); const b1 = path.join(root, 'pnpm/b1/node_modules/b'); const b2 = path.join(root, 'pnpm/b2/node_modules/b');
  await pkg(source, { dependencies: { a: '1', b: '1' } }); await pkg(a, { dependencies: { b: '2' } }); await pkg(b1, { version: '1.0.0' }); await pkg(b2, { version: '2.0.0' });
  await link(source, 'a', a); await link(source, 'b', b1); await link(path.dirname(path.dirname(a)), 'b', b2);
  assert.equal((await prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs')).packages, 3);
  await link(root, 'b', b2); await assert.rejects(prepareExtensionPackage(source, path.join(root, 'ambiguous'), 'index.mjs'), /Ambiguous root dependency/);
}));

test('package preparation rejects external source links, invalid paths and existing destinations without overwriting', async () => fixture(async root => {
  const source = path.join(root, 'source'); await pkg(source, {}); const outside = path.join(root, 'outside'); await writeFile(outside, 'unrelated'); await symlink(outside, path.join(source, 'linked'));
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'target'), 'index.mjs'), /external or cyclic/);
  await rm(path.join(source, 'linked')); await assert.rejects(prepareExtensionPackage(source, path.join(source, 'nested'), 'index.mjs'), /must not contain/);
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'target'), '../outside'), /normalized/);
  const target = path.join(root, 'target'); await mkdir(target); await writeFile(path.join(target, 'keep'), 'keep'); await assert.rejects(prepareExtensionPackage(source, target, 'index.mjs'), /EEXIST/); assert.equal(await readFile(path.join(target, 'keep'), 'utf8'), 'keep');
}));

test('source aliases cannot promote excluded node_modules or Git trees into the copied package', async () => fixture(async root => {
  const source = path.join(root, 'source'); await pkg(source, {});
  for (const excluded of ['node_modules', '.git']) {
    const target = path.join(source, excluded); await mkdir(target); await writeFile(path.join(target, 'private'), 'do not read as source');
    await symlink(target, path.join(source, 'alias'));
    await assert.rejects(prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs'), /excluded dependency or Git/);
    await assert.rejects(realpath(path.join(root, 'prepared')), /ENOENT/); await rm(path.join(source, 'alias'));
  }
}));
