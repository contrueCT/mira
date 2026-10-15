import pnpmNodeShim from './fixtures/pnpm-node-shim.mts';
import { cp, lstat, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const inside = (root: string, child: string) => { const relative = path.relative(root, child); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code));
async function optionalRealpath(value: string): Promise<string | null> { try { return await realpath(value); } catch (error) { if (missing(error)) return null; throw error; } }
const packageName = /^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/u;
/** Capture every installed candidate in Node's declared namespace; artifact staging
 * preserves their original topology. Do not flatten versions or run a resolver/install. */
async function candidates(directory: string, name: string): Promise<string[]> {
  if (!packageName.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid declared dependency name');
  const found: string[] = [];
  for (let current = directory; ; current = path.dirname(current)) {
    if (path.basename(current) !== 'node_modules') {
      const candidate = path.join(current, 'node_modules', name);
      for (const suffix of ['.js', '.json', '.node']) if (await optionalRealpath(candidate + suffix)) throw new Error(`Bare-file dependency layout is unsupported: ${name}`);
      const target = await optionalRealpath(candidate);
      if (target) { if (!(await lstat(target)).isDirectory()) throw new Error(`Dependency must be a package directory: ${name}`); if (!found.includes(target)) found.push(target); }
    }
    if (current === path.dirname(current)) return found;
  }
}
async function dependencies(directory: string): Promise<Map<string, boolean>> {
  const manifestPath = path.join(directory, 'package.json');
  if (!(await lstat(manifestPath)).isFile()) throw new Error('Package manifest must be an ordinary file, not a link');
  const manifest: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!object(manifest)) throw new Error('A package.json object is required');
  const names = new Map<string, boolean>();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const entries = manifest[field]; if (entries === undefined) continue;
    if (!object(entries)) throw new Error(`Invalid ${field}`);
    for (const [name, version] of Object.entries(entries)) {
      if (typeof version !== 'string') throw new Error('Dependency specifier must be text');
      const meta = object(manifest.peerDependenciesMeta) ? manifest.peerDependenciesMeta[name] : null;
      const required = (field === 'dependencies' && !(object(manifest.optionalDependencies) && Object.hasOwn(manifest.optionalDependencies, name))) || (field === 'peerDependencies' && !(object(meta) && meta.optional === true));
      names.set(name, (names.get(name) ?? false) || required);
    }
  }
  return names;
}
async function validateSourceTree(root: string, directory: string, ancestors = new Set<string>()): Promise<void> {
  const actual = await realpath(directory);
  if (path.relative(root, actual).split(path.sep).some(part => part === 'node_modules' || part === '.git')) throw new Error('Source link enters an excluded dependency or Git tree');
  if (!inside(root, actual) || ancestors.has(actual)) throw new Error('Source package contains an external or cyclic link');
  const metadata = await lstat(actual);
  if ((await lstat(directory)).isSymbolicLink()) throw new Error('Source package symlinks are unsupported; use ordinary source files before preparation');
  if (metadata.isFile()) {
    if (path.basename(actual) === 'package.json' && path.dirname(actual) !== root && (await dependencies(path.dirname(actual))).size) throw new Error('Nested authored runtime dependency declarations are unsupported');
    return;
  }
  if (!metadata.isDirectory()) throw new Error('Source package contains a non-ordinary file');
  const next = new Set(ancestors).add(actual);
  for (const name of await readdir(actual)) {
    if (name === 'node_modules') { if (actual !== root) throw new Error('Non-root authored node_modules layouts are unsupported'); continue; }
    if (name !== '.git') await validateSourceTree(root, path.join(actual, name), next);
  }
}
/** ArtifactStore follows all authored links. Validate every dependency tree before
 * exposing it to staging, including nested package folders and non-imported links.
 * Only declared closure roots and their sparse namespace ancestors are eligible. */
async function validateDependencyTrees(closure: Set<string>): Promise<void> {
  const roots = [...closure]; const visited = new Set<string>();
  // Recognize one pinned package-manager format, never a comment alone. Data
  // substitutions are path-only and every executable branch must match the
  // captured declared bin. Unknown shim versions fail closed. The template is
  // pnpm 11.28.4's Node POSIX shim (MIT, fixtures/LICENSE.pnpm).
  const template = pnpmNodeShim;
  const bins = new Map<string, Map<string, string>>();
  for (const root of roots) {
    const manifest: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
    if (!object(manifest)) throw new Error('Invalid runtime manifest');
    const entries = typeof manifest.bin === 'string' && typeof manifest.name === 'string'
      ? { [manifest.name.split('/').at(-1)!]: manifest.bin } : manifest.bin;
    if (entries === undefined) continue;
    if (!object(entries)) throw new Error('Invalid runtime bin declaration');
    for (const [name, relative] of Object.entries(entries)) {
      if (!/^[A-Za-z0-9_.-]+$/u.test(name) || name === '.' || name === '..' || typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid runtime bin declaration');
      const target = await realpath(path.resolve(root, relative));
      if (!inside(root, target) || path.relative(root, target).split(path.sep).some(part => part === 'node_modules' || part === '.git') || !(await lstat(target)).isFile()) throw new Error('Runtime bin escapes its declared package');
      const values = bins.get(name) ?? new Map<string, string>(); values.set(target, root); bins.set(name, values);
    }
  }
  const visit = async (input: string): Promise<void> => {
    if (path.basename(input) === '.bin' && (await lstat(input)).isSymbolicLink()) throw new Error('Runtime dependency .bin directory must not be a link');
    const actual = await realpath(input);
    const contained = roots.some(root => inside(root, actual) && !path.relative(root, actual).split(path.sep).some(part => part === 'node_modules' || part === '.git'));
    const namespace = roots.some(root => /^node_modules(?:\/@[^/]+)?$/u.test(path.relative(root, actual).split(path.sep).join('/')));
    const binParent = roots.find(root => path.dirname(actual) === path.join(root, 'node_modules', '.bin'));
    const binDirectory = roots.some(root => actual === path.join(root, 'node_modules', '.bin'));
    let shim = false;
    if (binParent && (await lstat(input)).isFile()) {
      const declared = bins.get(path.basename(actual));
      if (declared) {
        const bytes = await readFile(actual, 'utf8');
        const markers = [...bytes.matchAll(/^# cmd-shim-target=(.+)$/gm)];
        if (markers.length === 1) {
          const target = await optionalRealpath(markers[0]![1]!);
          const packageRoot = target && declared.get(target);
          if (target && packageRoot) {
            const relative = path.relative(path.dirname(actual), target).split(path.sep).join('/');
            // Do not interpolate shell syntax, even in an otherwise recognized
            // template. Unsupported path spelling must be prepared elsewhere.
            const safe = (value: string) => !/["\\$`\r\n:]/u.test(value);
            const nodePaths = [path.join(packageRoot, 'node_modules')];
            let modules = path.dirname(packageRoot);
            if (path.basename(modules).startsWith('@')) modules = path.dirname(modules);
            if (path.basename(modules) === 'node_modules') {
              nodePaths.push(modules);
              const store = path.dirname(path.dirname(modules));
              if (path.basename(store) === '.pnpm') nodePaths.push(path.join(store, 'node_modules'));
            }
            if ([target, relative, ...nodePaths].every(safe)) {
              const expected = template.replaceAll('@@TARGET@@', target).replaceAll('@@RELATIVE@@', relative).replaceAll('@@NODE_PATH@@', nodePaths.join(':'));
              shim = bytes === expected;
            }
          }
        }
      }
    }
    if (!contained && !namespace && !binDirectory && !shim) throw new Error('Runtime dependency link or directory escapes the declared closure');
    if (visited.has(actual)) return; visited.add(actual);
    const info = await lstat(actual);
    if (info.isFile()) return;
    if (!info.isDirectory()) throw new Error('Runtime dependency contains a non-ordinary file');
    for (const name of await readdir(actual)) await visit(path.join(actual, name));
  };
  for (const root of roots) await visit(root);
}
/** Prepare an external authoring workspace using only already-installed runtime
 * dependencies. Stage/test/install/activate remains the existing separate workflow. */
export async function prepareExtensionPackage(sourceRoot: string, destination: string, entryRelative = 'src/index.ts'): Promise<{ directory: string; entryRelative: 'entry.mjs'; packages: number }> {
  if (!path.isAbsolute(sourceRoot) || !path.isAbsolute(destination) || !entryRelative || path.isAbsolute(entryRelative) || /[\\\x00-\x1f\x7f%#?]/u.test(entryRelative) || entryRelative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Use absolute directories and a normalized package-relative entry');
  if (entryRelative.split('/').some(part => part === 'node_modules' || part === '.git')) throw new Error('Entry must reference copied authored source, not an excluded tree');
  const source = await realpath(sourceRoot); const target = path.join(await realpath(path.dirname(destination)), path.basename(destination));
  if (inside(source, target) || inside(target, source)) throw new Error('Prepared workspace and source must not contain one another');
  const entry = await realpath(path.join(source, entryRelative));
  if (!inside(source, entry) || !(await lstat(entry)).isFile()) throw new Error('Entry must be an ordinary file inside the source package');
  const closure = new Set<string>(); const rootLinks = new Map<string, string>(); const visited = new Set<string>();
  const visit = async (directory: string): Promise<void> => {
    if (visited.has(directory)) return; visited.add(directory);
    for (const [name, required] of await dependencies(directory)) {
      const installed = await candidates(directory, name);
      if (!installed.length && required) throw new Error(`Required dependency is not installed: ${name}`);
      if (directory === source && installed.length > 1) throw new Error(`Ambiguous root dependency candidates: ${name}; prepare an explicitly linked source package`);
      if (directory === source && installed[0]) rootLinks.set(name, installed[0]);
      for (const dependency of installed) { if (dependency === source) throw new Error('A runtime dependency points back into the source package'); closure.add(dependency); await visit(dependency); }
    }
  };
  await validateSourceTree(source, source);
  await visit(source);
  for (const dependency of closure) {
    // Root node_modules is excluded from the source copy, so ordinary npm installs
    // remain valid. A dependency in authored source would otherwise be copied twice.
    if (inside(dependency, source) || (inside(source, dependency) && path.relative(source, dependency).split(path.sep)[0] !== 'node_modules')) throw new Error('Runtime dependency overlaps copied authored source');
    if (inside(dependency, target) || inside(target, dependency)) throw new Error('Prepared workspace and runtime dependencies must not contain one another');
  }
  await validateDependencyTrees(closure);
  const workspaceUrl = pathToFileURL(target + path.sep).href;
  const entryUrl = pathToFileURL(path.join(target, 'package', entryRelative)).href;
  if (!entryUrl.startsWith(workspaceUrl)) throw new Error('Entry URL must remain inside the prepared workspace');
  const entrySpecifier = './' + entryUrl.slice(workspaceUrl.length);
  // No writes until the complete declared closure is known. The destination must be new.
  await mkdir(target);
  try {
    const copied = path.join(target, 'package');
    await cp(source, copied, { recursive: true, dereference: true, errorOnExist: true, force: false, filter: input => !path.relative(source, input).split(path.sep).some(segment => segment === 'node_modules' || segment === '.git') });
    await mkdir(path.join(target, '.deps'));
    let index = 0;
    for (const dependency of closure) await symlink(dependency, path.join(target, '.deps', `runtime-${index++}`), 'dir');
    for (const [name, dependency] of rootLinks) { const link = path.join(copied, 'node_modules', name); await mkdir(path.dirname(link), { recursive: true }); await symlink(dependency, link, 'dir'); }
    // Published source packages may declare authoring devDependencies. They are
    // not promoted to runtime dependencies by this small wrapper workspace.
    await writeFile(path.join(target, 'package.json'), '{"type":"module","private":true}\n');
    await writeFile(path.join(target, 'entry.mjs'), `export { default } from ${JSON.stringify(entrySpecifier)};\nexport * from ${JSON.stringify(entrySpecifier)};\n`);
    return { directory: target, entryRelative: 'entry.mjs', packages: closure.size };
  } catch (error) { await rm(target, { recursive: true, force: true }); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, destination, entry] = process.argv.slice(2);
  if (!source || !destination || process.argv.length > 5) throw new Error('Usage: node scripts/prepare-extension-package.mts /absolute/source-package /absolute/new-workspace [src/index.ts]');
  const result = await prepareExtensionPackage(source, destination, entry);
  console.log(JSON.stringify(result));
}
