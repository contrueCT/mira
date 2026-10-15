import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import template from './pnpm-node-shim.ts';
export { default as pnpmNodeShim } from './pnpm-node-shim.ts';
const inside = (root: string, child: string) => { const relative = path.relative(root, child); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type Bins = Map<string, Map<string, string>>;
/** Inspect declared targets without running package-manager or dependency code. */
export async function declaredPackageBins(roots: Iterable<string>): Promise<Bins> {
  const bins: Bins = new Map();
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
  return bins;
}
type Shim = { target: string; relative: string; nodePaths: string[] };
/** Only the complete pinned POSIX Node template is eligible for relocation. */
export function matchPackageBinShim(file: string, bytes: string, bins: Bins): Shim | null {
  const markers = [...bytes.matchAll(/^# cmd-shim-target=(.+)$/gm)];
  if (markers.length !== 1) return null;
  const target = markers[0]![1]!;
  const packageRoot = bins.get(path.basename(file))?.get(target);
  if (!packageRoot) return null;
  const relative = path.relative(path.dirname(file), target).split(path.sep).join('/');
  const safe = (value: string) => !/["\\$`\r\n:]/u.test(value);
  const nodePaths = [path.join(packageRoot, 'node_modules')];
  let modules = path.dirname(packageRoot);
  if (path.basename(modules).startsWith('@')) modules = path.dirname(modules);
  if (path.basename(modules) === 'node_modules') {
    nodePaths.push(modules);
    const store = path.dirname(path.dirname(modules));
    if (path.basename(store) === '.pnpm') nodePaths.push(path.join(store, 'node_modules'));
  }
  if (![target, relative, ...nodePaths].every(safe)) return null;
  const expected = template.replaceAll('@@TARGET@@', target).replaceAll('@@RELATIVE@@', relative).replaceAll('@@NODE_PATH@@', nodePaths.join(':'));
  return bytes === expected ? { target, relative, nodePaths } : null;
}
/** Keep the original executable/shebang/symlink semantics, but bind resolution
 * to the captured sparse topology. Never inherit ambient original NODE_PATH. */
export function capturedPackageBinShim(shim: Shim, file: string, base: string): string {
  const nodePaths = shim.nodePaths.filter(directory => inside(base, directory))
    .map(directory => `$basedir/${path.relative(path.dirname(file), directory).split(path.sep).join('/')}`).join(':');
  return template.replaceAll('@@TARGET@@', shim.relative).replaceAll('@@RELATIVE@@', shim.relative)
    .replace('if [ -z "$NODE_PATH" ]; then\n  export NODE_PATH="@@NODE_PATH@@"\nelse\n  export NODE_PATH="@@NODE_PATH@@:$NODE_PATH"\nfi', `export NODE_PATH="${nodePaths}"`);
}
