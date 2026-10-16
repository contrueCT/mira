import { pnpmNodeShim as template } from '@mira/extension-host/package-bin-shims';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ArtifactStore } from '@mira/extension-host';
import { prepareExtensionPackage } from '../../scripts/prepare-extension-package.mts';
async function fixture(run: (root: string) => Promise<void>) { const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-package-prep-'))); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
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

test('runtime dependency trees reject undeclared external file/directory links before staging or copying', async () => fixture(async root => {
  const source = path.join(root, 'source'), dep = path.join(root, 'dep'), unrelated = path.join(root, 'unrelated-private');
  await pkg(source, { dependencies: { dep: '1' } }); await pkg(dep, {}); await link(source, 'dep', dep);
  await mkdir(unrelated); await writeFile(path.join(unrelated, 'credentials.json'), 'synthetic-private-sentinel');
  for (const target of [unrelated, path.join(unrelated, 'credentials.json'), root]) {
    await symlink(target, path.join(dep, 'undeclared-link'));
    await assert.rejects(prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs'), /escapes the declared closure/);
    await assert.rejects(realpath(path.join(root, 'prepared')), /ENOENT/); await rm(path.join(dep, 'undeclared-link'));
  }
  await mkdir(path.join(dep, 'node_modules', 'undeclared'), { recursive: true });
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs'), /escapes the declared closure/);
}));

test('runtime dependency internal aliases and links into an explicitly declared closure remain stageable', async () => fixture(async root => {
  const source = path.join(root, 'source'), a = path.join(root, 'a'), b = path.join(root, 'b');
  await pkg(source, { dependencies: { a: '1' } }); await pkg(a, { dependencies: { b: '1' } }); await pkg(b, {});
  await link(source, 'a', a); await link(a, 'b', b);
  await symlink(path.join(a, 'index.mjs'), path.join(a, 'internal-alias.mjs'));
  await symlink(b, path.join(a, 'declared-alias'));
  const prepared = await prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs');
  const store = new ArtifactStore(path.join(root, 'artifacts'));
  await store.stage(prepared.directory, prepared.entryRelative);
}));

test('dependency manifests cannot follow a link outside the selected package before closure validation', async () => fixture(async root => {
  const source = path.join(root, 'source'), dep = path.join(root, 'dep');
  await pkg(source, { dependencies: { dep: '1' } }); await pkg(dep, {}); await link(source, 'dep', dep);
  await writeFile(path.join(root, 'unrelated.json'), '{"private":"synthetic"}');
  await rm(path.join(dep, 'package.json')); await symlink(path.join(root, 'unrelated.json'), path.join(dep, 'package.json'));
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs'), /manifest must be an ordinary file/);
  await assert.rejects(realpath(path.join(root, 'prepared')), /ENOENT/);
}));


for (const variant of ['entry-link', 'imported-file-link', 'imported-directory-link']) test(`preparation rejects ${variant} before writing instead of changing valid Node import resolution`, async () => fixture(async root => {
  const source = path.join(root, 'source'); await pkg(source, {});
  await mkdir(path.join(source, 'lib/impl'), { recursive: true });
  await writeFile(path.join(source, 'lib/name.mjs'), "export default 'correct-location';");
  await writeFile(path.join(source, 'lib/impl/main.mjs'), "export { default } from '../name.mjs';");
  if (variant === 'entry-link') {
    await rm(path.join(source, 'index.mjs')); await symlink('lib/impl/main.mjs', path.join(source, 'index.mjs'));
  } else if (variant === 'imported-file-link') {
    await symlink(path.join(source, 'lib/impl/main.mjs'), path.join(source, 'alias.mjs'));
    await writeFile(path.join(source, 'index.mjs'), "export { default } from './alias.mjs';");
  } else {
    await symlink('lib/impl', path.join(source, 'alias'), 'dir');
    await writeFile(path.join(source, 'index.mjs'), "export { default } from './alias/main.mjs';");
  }
  assert.equal((await import(pathToFileURL(path.join(source, 'index.mjs')).href)).default, 'correct-location');
  const target = path.join(root, 'prepared');
  await assert.rejects(prepareExtensionPackage(source, target, 'index.mjs'), /Source package symlinks are unsupported/);
  await assert.rejects(realpath(target), /ENOENT/);
}));

test('nested authored installation and runtime declaration scopes fail before writes', async () => fixture(async root => {
  const source = path.join(root, 'source'), nested = path.join(source, 'src'), target = path.join(root, 'prepared');
  await pkg(source, { dependencies: { dep: '1' } }); await pkg(path.join(source, 'node_modules/dep'), {}, "export default 'root';");
  await mkdir(nested); await writeFile(path.join(nested, 'entry.mjs'), "export {default} from 'dep';");
  await pkg(path.join(nested, 'node_modules/dep'), {}, "export default 'nested';");
  assert.equal((await import(pathToFileURL(path.join(nested, 'entry.mjs')).href)).default, 'nested');
  await assert.rejects(prepareExtensionPackage(source, target, 'src/entry.mjs'), /Non-root authored node_modules/);
  await assert.rejects(realpath(target), /ENOENT/); await rm(path.join(nested, 'node_modules'), { recursive: true });
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    await writeFile(path.join(nested, 'package.json'), JSON.stringify({ type: 'module', [field]: { dep: '1' } }));
    await assert.rejects(prepareExtensionPackage(source, target, 'src/entry.mjs'), /Nested authored runtime/);
    await assert.rejects(realpath(target), /ENOENT/);
  }
  // Ordinary physical npm installation and type/import-only nested scopes retain semantics.
  await writeFile(path.join(nested, 'package.json'), JSON.stringify({ type: 'module', imports: { '#dep': 'dep' } }));
  await writeFile(path.join(nested, 'entry.mjs'), "export {default} from '#dep';");
  const prepared = await prepareExtensionPackage(source, target, 'src/entry.mjs');
  const store = new ArtifactStore(path.join(root, 'artifacts')); const artifact = await store.stage(prepared.directory, prepared.entryRelative);
  const receipt = await store.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', "if((await import('./entry.mjs')).default !== 'root') throw Error('changed scope');"] });
  assert.equal(receipt.passed, true, receipt.stderr);
}));

test('dependency overlap with copied source and destination is rejected without mutation', async () => fixture(async root => {
  const source = path.join(root, 'source'), dep = path.join(source, 'dep'), target = path.join(root, 'prepared');
  await pkg(source, { dependencies: { dep: '1' } }, "import a from './dep/index.mjs'; import b from 'dep'; export default a===b;");
  await pkg(dep, {}, 'export default {};'); await link(source, 'dep', dep);
  assert.equal((await import(pathToFileURL(path.join(source, 'index.mjs')).href)).default, true);
  await assert.rejects(prepareExtensionPackage(source, target, 'index.mjs'), /overlaps copied/); await assert.rejects(realpath(target), /ENOENT/);
  const external = path.join(root, 'external'); await pkg(external, {}); await rm(path.join(source, 'node_modules/dep')); await link(source, 'dep', external);
  const original = await readFile(path.join(external, 'index.mjs'), 'utf8');
  await assert.rejects(prepareExtensionPackage(source, path.join(external, 'prepared'), 'index.mjs'), /runtime dependencies must not contain/);
  await assert.rejects(realpath(path.join(external, 'prepared')), /ENOENT/); assert.equal(await readFile(path.join(external, 'index.mjs'), 'utf8'), original);
  const insideDependency = path.join(external, 'source'); await pkg(insideDependency, { dependencies: { dep: '1' } }); await link(insideDependency, 'dep', external);
  await assert.rejects(prepareExtensionPackage(insideDependency, target, 'index.mjs'), /overlaps copied/); await assert.rejects(realpath(target), /ENOENT/);
}));

test('entry URL metacharacters and excluded trees are rejected before workspace writes', async () => fixture(async root => {
  const source = path.join(root, 'source'), target = path.join(root, 'prepared'); await pkg(source, {});
  for (const filename of ['index%2Emjs', 'index#literal.mjs', 'index?literal.mjs']) {
    await writeFile(path.join(source, filename), "export default 'literal';");
    assert.equal((await import(pathToFileURL(path.join(source, filename)).href)).default, 'literal');
    await assert.rejects(prepareExtensionPackage(source, target, filename), /normalized/); await assert.rejects(realpath(target), /ENOENT/);
  }
  for (const directory of ['.git', 'node_modules']) {
    await mkdir(path.join(source, directory)); await writeFile(path.join(source, directory, 'entry.mjs'), 'export default {};');
    await assert.rejects(prepareExtensionPackage(source, target, `${directory}/entry.mjs`), /excluded tree/); await assert.rejects(realpath(target), /ENOENT/);
  }
}));

test('all control characters in entries are rejected before writes', async () => fixture(async root => {
  const source = path.join(root, 'source'), target = path.join(root, 'prepared'); await pkg(source, {}, "export default 'stripped';");
  for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
    const entry = `index${String.fromCharCode(code)}.mjs`;
    if (code) await writeFile(path.join(source, entry), "export default 'literal';");
    await assert.rejects(prepareExtensionPackage(source, target, entry), /normalized/); await assert.rejects(realpath(target), /ENOENT/);
  }
}));

test('standard file URL encoding preserves a trailing-space entry through movable artifact staging', async () => fixture(async root => {
  const source = path.join(root, 'source # with spaces'), target = path.join(root, 'prepared % with spaces');
  await pkg(source, {}); await writeFile(path.join(source, 'entry'), "export default 'wrong';"); await writeFile(path.join(source, 'entry '), "export default 'literal';");
  assert.equal((await import(pathToFileURL(path.join(source, 'entry ')).href)).default, 'literal');
  const prepared = await prepareExtensionPackage(source, target, 'entry ');
  const store = new ArtifactStore(path.join(root, 'artifacts')); const artifact = await store.stage(prepared.directory, prepared.entryRelative);
  const receipt = await store.test(artifact, { command: process.execPath, args: ['--input-type=module', '-e', "if((await import('./entry.mjs')).default !== 'literal') throw Error('entry identity changed');"] });
  assert.equal(receipt.passed, true, receipt.stderr);
}));

test('pnpm bin shims admit only declared captured targets and preserve all external-link fences', async () => fixture(async root => {
  const source = path.join(root, 'source'), dep = path.join(root, 'dep'), executable = path.join(root, 'executable');
  await pkg(source, { dependencies: { dep: '1' } });
  await pkg(dep, { dependencies: { executable: '1' } });
  await pkg(executable, { name: 'executable', bin: { demo: 'run.mjs' } });
  await writeFile(path.join(executable, 'run.mjs'), 'console.log("synthetic");');
  await link(source, 'dep', dep); await link(dep, 'executable', executable);
  const bin = path.join(dep, 'node_modules', '.bin'); await mkdir(bin);
  const shim = path.join(bin, 'demo'); const target = path.join(executable, 'run.mjs');
  const valid = template.replaceAll('@@TARGET@@', target).replaceAll('@@RELATIVE@@', path.relative(bin, target)).replaceAll('@@NODE_PATH@@', path.join(executable, 'node_modules'));
  await writeFile(shim, valid);
  const prepared = await prepareExtensionPackage(source, path.join(root, 'good'), 'index.mjs');
  await new ArtifactStore(path.join(root, 'artifacts')).stage(prepared.directory, prepared.entryRelative);
  for (const content of ['#!/bin/sh\nexit 0\n', `#!/bin/sh\n# cmd-shim-target=${path.join(root, 'unrelated')}\n`, `#!/bin/sh\n# cmd-shim-target=${target}\n# cmd-shim-target=${target}\n`, `#!/bin/sh\n# cmd-shim-target=${target}\nexec /arbitrary/external/executable \"$@\"\n`, valid + 'echo injected\n', valid.replace('exec node  ', 'exec /external/node  '), valid.replace(path.join(executable, 'node_modules'), '/external/node_modules')]) {
    await writeFile(shim, content); await assert.rejects(prepareExtensionPackage(source, path.join(root, 'bad'), 'index.mjs'), /escapes the declared closure/);
    await assert.rejects(realpath(path.join(root, 'bad')), /ENOENT/);
  }
  await writeFile(shim, valid);
  await writeFile(path.join(bin, 'undeclared'), `#!/bin/sh\n# cmd-shim-target=${target}\n`);
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'bad'), 'index.mjs'), /escapes the declared closure/);
  await rm(path.join(bin, 'undeclared'));
  await mkdir(path.join(root, 'unrelated')); await writeFile(path.join(root, 'unrelated', 'secret'), 'synthetic-private');
  await symlink(path.join(root, 'unrelated'), path.join(bin, 'nested'));
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'bad'), 'index.mjs'), /escapes the declared closure/);
  await rm(path.join(bin, 'nested')); await rm(shim); await symlink(path.join(root, 'unrelated', 'secret'), shim);
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'bad'), 'index.mjs'), /escapes the declared closure/);
  await rm(bin, { recursive: true }); await symlink(path.join(root, 'unrelated'), bin);
  await assert.rejects(prepareExtensionPackage(source, path.join(root, 'bad'), 'index.mjs'), /must not be a link/);
}));


test('executable captured pnpm shims resolve only the captured closure after source mutation and removal', async () =>
  fixture(async sourceRoot => fixture(async storeRoot => fixture(async runtimeRoot => {
    // Separate roots prevent ordinary Node ancestor lookup from accidentally
    // finding the original installation during artifact execution.
    const source = path.join(sourceRoot, 'source with spaces');
    const modules = path.join(sourceRoot, 'node_modules');
    const dep = path.join(modules, 'dep');
    const executable = path.join(modules, 'executable');
    const declared = path.join(modules, 'declared');
    const outside = path.join(modules, 'outside');
    const ambient = path.join(runtimeRoot, 'ambient modules');
    const poisonBin = path.join(runtimeRoot, 'node_modules', '.bin');
    await pkg(source, { dependencies: { dep: '1' } }, "export {default} from 'dep';");
    await pkg(dep, { dependencies: { executable: '1' } },
      "import {fileURLToPath} from 'node:url'; export default fileURLToPath(new URL('./node_modules/.bin/demo', import.meta.url));");
    await pkg(executable, { name: 'executable', bin: { demo: 'run.cjs' }, dependencies: { declared: '1' } });
    await pkg(declared, { main: 'index.cjs' });
    await writeFile(path.join(declared, 'index.cjs'), "module.exports = 'captured declared value';");
    await pkg(outside, { main: 'index.cjs' });
    await writeFile(path.join(outside, 'index.cjs'), "module.exports = 'original undeclared value';");
    await pkg(path.join(ambient, 'ambient-only'), { main: 'index.cjs' });
    await writeFile(path.join(ambient, 'ambient-only', 'index.cjs'), "module.exports = 'ambient undeclared value';");
    await writeFile(path.join(executable, 'run.cjs'), [
      '#!/usr/bin/env node',
      "const resolve = name => { try { return require(name); } catch (error) { if (error.code === 'MODULE_NOT_FOUND') return 'NOT_CAPTURED'; throw error; } };",
      "console.log(JSON.stringify({ declared: resolve('declared'), outside: resolve('outside'), ambient: resolve('ambient-only'), args: process.argv.slice(2) }));",
      '',
    ].join('\n'));
    const bin = path.join(dep, 'node_modules', '.bin');
    await mkdir(bin, { recursive: true });
    const originalShim = path.join(bin, 'demo');
    const target = path.join(executable, 'run.cjs');
    await writeFile(originalShim, template
      .replaceAll('@@TARGET@@', target)
      .replaceAll('@@RELATIVE@@', path.relative(bin, target))
      .replaceAll('@@NODE_PATH@@', [path.join(executable, 'node_modules'), modules].join(':')));
    await chmod(originalShim, 0o755);
    await mkdir(poisonBin, { recursive: true });
    for (const helper of ['readlink', 'sed', 'uname', 'printf']) {
      const filename = path.join(poisonBin, helper);
      await writeFile(filename, '#!/bin/sh\necho hostile-PATH-helper >&2\nexit 91\n');
      await chmod(filename, 0o755);
    }
    const env = {
      PATH: [poisonBin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
      NODE_PATH: ambient,
      HOME: runtimeRoot,
    };
    const args = ['argument with spaces', '', '$HOME; echo not-a-command', 'quote"and\'quote', '--literal'];
    const run = (shim: string) => JSON.parse(execFileSync(shim, args, {
      cwd: runtimeRoot, env, encoding: 'utf8', timeout: 10_000,
    }));
    // Demonstrate both escape routes really exist in the original executable.
    assert.deepEqual(run(originalShim), {
      declared: 'captured declared value', outside: 'original undeclared value',
      ambient: 'ambient undeclared value', args,
    });
    const prepared = await prepareExtensionPackage(source, path.join(sourceRoot, 'prepared with spaces'), 'index.mjs');
    // A POSIX colon in the runtime base must not become a NODE_PATH delimiter.
    const colonEscape = path.join(storeRoot, 'ambient', 'outside');
    await pkg(colonEscape, { main: 'index.cjs' });
    await writeFile(path.join(colonEscape, 'index.cjs'), "module.exports = 'unhashed colon escape';");
    const store = new ArtifactStore(path.join(storeRoot, 'ambient:suffix', 'artifacts with spaces'));
    const artifact = await store.stage(prepared.directory, prepared.entryRelative);
    const stagedShim: string = (await import(pathToFileURL(artifact.entry).href)).default;
    const invocation = path.join(runtimeRoot, 'linked executable with spaces');
    await symlink(stagedShim, invocation);
    const expected = { declared: 'captured declared value', outside: 'NOT_CAPTURED', ambient: 'NOT_CAPTURED', args };
    assert.deepEqual(run(stagedShim), expected);
    assert.deepEqual(run(invocation), expected);
    await writeFile(path.join(declared, 'index.cjs'), "module.exports = 'mutated declared value';");
    await writeFile(path.join(outside, 'index.cjs'), "module.exports = 'mutated undeclared value';");
    await writeFile(path.join(colonEscape, 'index.cjs'), "module.exports = 'mutated unhashed colon escape';");
    assert.deepEqual(run(invocation), expected);
    await rm(sourceRoot, { recursive: true, force: true });
    assert.deepEqual(run(invocation), expected);
    // Fresh activation relocates the same captured shim once more.
    const fresh = await store.prepareFreshActivation(artifact);
    const freshShim: string = (await import(pathToFileURL(fresh.entry).href)).default;
    assert.deepEqual(run(freshShim), expected);
    await store.verify(artifact);
  }))));

for (const bin of [null, ['run.js'], { 'c++': 'run.js' }, { unused: 'missing/unbuilt.js' }]) {
  test(`unused bin metadata remains compatible without actual launchers: ${JSON.stringify(bin)}`, async () => fixture(async root => {
    const source = path.join(root, 'source'), dependency = path.join(root, 'dependency');
    await pkg(source, { dependencies: { dependency: '1' } });
    await pkg(dependency, { name: 'dependency', bin });
    await link(source, 'dependency', dependency);
    const prepared = await prepareExtensionPackage(source, path.join(root, 'prepared'), 'index.mjs');
    const store = new ArtifactStore(path.join(root, 'artifacts'));
    await store.verify(await store.stage(prepared.directory, prepared.entryRelative));
  }));
}
