import { readFile, readdir, realpath } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

type Rule = { path: string; allow: string[]; external: string[] };
type Manifest = {
  name: string;
  private?: boolean;
  type?: string;
  exports?: Record<string, unknown>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  imports?: unknown;
};
const builtins = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));
const sourcePattern = /\.(?:[cm]?[jt]sx?)$/;
const supportedSourcePattern = /\.(?:ts|mts|tsx)$/;
const excludedTrees = new Set(['node_modules', 'dist', '.git']);
const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};

export function importsFrom(source: string, filename: string): { imports: string[]; references: string[]; typeReferences: string[]; errors: string[] } {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  const imports: string[] = [];
  const errors: string[] = [];
  const add = (node: ts.Node | undefined): void => {
    if (node && ts.isStringLiteralLike(node)) imports.push(node.text);
    else errors.push('non-literal module loading is not allowed');
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) add(node.moduleSpecifier);
    } else if (ts.isModuleDeclaration(node) && ts.isStringLiteral(node.name)) {
      // External-module declarations/augmentations must obey the same boundaries.
      add(node.name);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
      else errors.push('non-literal import type is not allowed');
    } else if (ts.isImportEqualsDeclaration(node)) {
      errors.push('CommonJS import-equals is not allowed in ESM packages');
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0]);
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        errors.push('require is not allowed in ESM packages');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {
    imports,
    references: file.referencedFiles.map((reference) => reference.fileName),
    typeReferences: file.typeReferenceDirectives.map((reference) => reference.fileName),
    errors,
  };
}

function accessibleExport(value: unknown): boolean {
  if (typeof value === 'string') return value.startsWith('./');
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [condition, target] of Object.entries(value)) {
      if (condition === 'import' || condition === 'default') return typeof target === 'string' && target.startsWith('./');
    }
  }
  return false;
}

function supportedExport(value: unknown): boolean {
  if (value === null || typeof value === 'string') return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.some(([key]) => key === 'import' || key === 'default') && entries.every(([key, target]) => ['types', 'import', 'default'].includes(key) && (target === null || typeof target === 'string'));
}

function packageRoot(specifier: string): string {
  return specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/');
}

async function filesBelow(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excludedTrees.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`symlinks are not allowed in checked package trees: ${full}`);
    if (entry.isDirectory()) result.push(...await filesBelow(full));
    else if (sourcePattern.test(entry.name)) result.push(full);
  }
  return result;
}

/** Structural dependency guard, not a sandbox for untrusted JavaScript. */
export async function checkBoundaries(root: string): Promise<string[]> {
  const errors: string[] = [];
  const policy = JSON.parse(await readFile(path.join(root, 'scripts/boundaries.json'), 'utf8')) as Record<string, Rule>;
  const manifests = new Map<string, Manifest>();
  const locations = new Set(Object.values(policy).map((rule) => rule.path));
  for (const parent of ['apps', 'packages']) {
    for (const entry of await readdir(path.join(root, parent), { withFileTypes: true })) {
      if (entry.isSymbolicLink()) errors.push(`${parent}/${entry.name}: package symlink is forbidden`);
      if (entry.isDirectory() && !locations.has(`${parent}/${entry.name}`)) errors.push(`${parent}/${entry.name}: package missing boundary policy`);
    }
  }
  for (const [name, rule] of Object.entries(policy)) {
    const directory = path.resolve(root, rule.path);
    if (!inside(root, directory) || !inside(root, await realpath(directory))) throw new Error(`invalid package path: ${rule.path}`);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as Manifest;
    manifests.set(name, manifest);
    if (manifest.name !== name || manifest.private !== true || manifest.type !== 'module') errors.push(`${name}: expected matching name, private=true, type=module`);
    if (!manifest.exports || Array.isArray(manifest.exports) || typeof manifest.exports !== 'object') errors.push(`${name}: explicit exports object required`);
    if (manifest.imports) errors.push(`${name}: package import aliases are not allowed`);
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      if ((key !== '.' && !key.startsWith('./')) || /[*%?#\\]/.test(key) || key.slice(2).split('/').some((part) => ['.', '..', 'node_modules', '.git'].includes(part.toLowerCase()))) errors.push(`${name}: exports must use explicit normalized subpath keys`);
      if (!supportedExport(value)) errors.push(`${name}: unsupported export form; use a path/null or flat types/import/default map`);
      const targets = (item: unknown): string[] => typeof item === 'string' ? [item] : item && typeof item === 'object' ? Object.values(item).flatMap(targets) : [];
      for (const target of targets(value)) {
        if (!target.startsWith('./') || !inside(directory, path.resolve(directory, target)) || /[*%?#\\]/.test(target) || target.slice(2).split('/').some((part) => ['.', '..', 'node_modules', '.git'].includes(part.toLowerCase()))) errors.push(`${name}: export target escapes package or uses unsupported path syntax: ${target}`);
      }
    }
    for (const [dependency, range] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) {
      if (policy[dependency]) {
        if (!rule.allow.includes(dependency)) errors.push(`${name}: forbidden dependency ${dependency}`);
        if (!range.startsWith('workspace:')) errors.push(`${name}: internal dependency must use workspace protocol: ${dependency}`);
      } else if (!rule.external.includes(dependency)) errors.push(`${name}: external dependency not allowed: ${dependency}`);
    }
  }
  for (const [name, rule] of Object.entries(policy)) {
    const directory = path.resolve(root, rule.path);
    const manifest = manifests.get(name)!;
    const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
    for (const file of await filesBelow(directory)) {
      const label = path.relative(root, file);
      if (!supportedSourcePattern.test(file)) {
        errors.push(`${label}: only TypeScript ESM source (.ts, .mts, .tsx) is supported`);
        continue;
      }
      const parsed = importsFrom(await readFile(file, 'utf8'), file);
      errors.push(...parsed.errors.map((error) => `${label}: ${error}`));
      const checkLocal = (specifier: string, reference = false): void => {
        let target: string;
        try {
          target = reference ? path.resolve(path.dirname(file), specifier) : fileURLToPath(new URL(specifier, pathToFileURL(file)));
        } catch {
          errors.push(`${label}: invalid local module URL ${specifier}`);
          return;
        }
        if (!inside(directory, target)) errors.push(`${label}: cross-package relative import ${specifier}`);
        else if (path.relative(directory, target).split(path.sep).some((part) => excludedTrees.has(part))) errors.push(`${label}: import enters excluded tree ${specifier}`);
      };
      for (const reference of parsed.references) checkLocal(reference, true);
      for (const reference of parsed.typeReferences) {
        if (reference.startsWith('.') || path.isAbsolute(reference)) {
          checkLocal(reference, true);
          continue;
        }
        // TS type directives can name bundled types or DefinitelyTyped packages.
        const rootName = packageRoot(reference);
        const suffix = reference.slice(rootName.length);
        const definitelyTyped = rootName.startsWith('@types/') ? reference : `@types/${rootName.replace(/^@/, '').replace('/', '__')}${suffix}`;
        parsed.imports.push(declared[rootName] ? reference : definitelyTyped);
      }
      for (const specifier of parsed.imports) {
        if (specifier.startsWith('.')) {
          checkLocal(specifier);
          continue;
        }
        if (specifier.startsWith('node:') || builtins.has(specifier)) {
          if (name === '@mira/life' || name === '@mira/context' || name.endsWith('-sdk')) errors.push(`${label}: platform-independent package cannot import ${specifier}`);
          if (specifier === 'node:module' || specifier === 'module') errors.push(`${label}: alternate module loaders are not allowed`);
          continue;
        }
        if (specifier.startsWith('#') || path.isAbsolute(specifier) || specifier.includes(':')) {
          errors.push(`${label}: aliases, URLs and absolute imports are not allowed: ${specifier}`);
          continue;
        }
        const dependency = packageRoot(specifier);
        if (!declared[dependency]) errors.push(`${label}: undeclared dependency ${dependency}`);
        const target = manifests.get(dependency);
        if (target) {
          if (!rule.allow.includes(dependency)) errors.push(`${label}: forbidden import ${dependency}`);
          const subpath = specifier === dependency ? '.' : `.${specifier.slice(dependency.length)}`;
          if (!Object.hasOwn(target.exports ?? {}, subpath) || !accessibleExport(target.exports?.[subpath])) errors.push(`${label}: non-public import ${specifier}`);
        } else if (!rule.external.includes(dependency)) errors.push(`${label}: external import not allowed ${dependency}`);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (name: string): void => {
    if (visiting.has(name)) { errors.push(`dependency cycle at ${name}`); return; }
    if (visited.has(name)) return;
    visiting.add(name);
    const manifest = manifests.get(name)!;
    for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies })) if (manifests.has(dependency)) visit(dependency);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of manifests.keys()) visit(name);
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = await checkBoundaries(process.cwd());
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Package boundaries verified');
}
