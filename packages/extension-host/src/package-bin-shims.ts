import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import template from './pnpm-node-shim.ts';
export { default as pnpmNodeShim } from './pnpm-node-shim.ts';
const inside = (root: string, child: string) => { const relative = path.relative(root, child); return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type Shim = { relative: string };
/** Only the complete pinned POSIX Node template is eligible for relocation. */
function matchPackageBinShim(file: string, bytes: string, packageRoot: string, target: string): Shim | null {
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
  return bytes === expected ? { relative } : null;
}
/** Keep executable/shebang/symlink semantics. The template's NODE_PATH entries
 * duplicate Node's ordinary ancestor lookup in the captured sparse topology.
 * Clear them rather than encoding runtime paths (which may contain delimiters). */
export function capturedPackageBinShim(shim: Shim): string {
  return template.replaceAll('@@TARGET@@', shim.relative).replaceAll('@@RELATIVE@@', shim.relative)
    .replace('if [ -z "$NODE_PATH" ]; then\n  export NODE_PATH="@@NODE_PATH@@"\nelse\n  export NODE_PATH="@@NODE_PATH@@:$NODE_PATH"\nfi', 'unset NODE_PATH');
}

/** Inspect only this launcher's claimed declaration. Unused bin metadata is not
 * runtime code. Preparation rejects unmatched .bin files; staging preserves
 * ordinary files and relocates only a positive complete-template match. */
export async function findPackageBinShim(file: string, bytes: string, packages: Iterable<string>): Promise<Shim | null> {
  const markers = [...bytes.matchAll(/^# cmd-shim-target=(.+)$/gm)];
  if (markers.length !== 1 || !path.isAbsolute(markers[0]![1]!)) return null;
  const target = markers[0]![1]!, name = path.basename(file);
  for (const root of packages) {
    if (!inside(root, target) || path.relative(root, target).split(path.sep).some(part => part === 'node_modules' || part === '.git')) continue;
    try {
      const manifest: unknown = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
      if (!object(manifest)) continue;
      const relative = typeof manifest.bin === 'string' && typeof manifest.name === 'string' && manifest.name.split('/').at(-1) === name
        ? manifest.bin : object(manifest.bin) ? manifest.bin[name] : undefined;
      if (typeof relative !== 'string' || path.isAbsolute(relative) || await realpath(path.resolve(root, relative)) !== target || !(await lstat(target)).isFile()) continue;
      const matched = matchPackageBinShim(file, bytes, root, target);
      if (matched) return matched;
    } catch { /* An ineligible optional launcher remains ordinary captured bytes. */ }
  }
  return null;
}
