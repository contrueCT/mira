import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, symlink, readlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export interface ArtifactManifest {
  digest: string;
  /** Cwd for the snapshotted external workspace; dependencies are private siblings. */
  directory: string;
  entry: string;
  entryRelative: string;
}
export interface ArtifactTestCommand { command: string; args?: string[] }
export interface ArtifactTestResult {
  digest: string;
  command: string;
  args: string[];
  testedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  passed: boolean;
  unchanged: boolean;
  afterDigest: string | null;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
  error?: string;
}
interface StoredManifest { version: 1; digest: string; entryRelative: string }
const inside = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
};
function validateDigest(digest: string): void {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Artifact digest must be a SHA-256 hex string');
}
function validateEntry(entry: string): void {
  if (!entry || path.isAbsolute(entry) || /[\\\0]/.test(entry) || entry.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Artifact entry must be a normalized workspace-relative file path');
  }
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Ordinary local files, not a sandbox or an integrity boundary against the OS
 * account running extensions. Staging never imports code or runs package scripts.
 * Every load rechecks bytes; the main model chooses testing/import/execution from user intent. */
export class ArtifactStore {
  readonly root: string;
  constructor(root: string) {
    if (!path.isAbsolute(root)) throw new Error('Artifact store must be an absolute path');
    this.root = path.resolve(root);
  }

  private manifest(digest: string, entryRelative: string, container = path.join(this.root, 'releases', digest)): ArtifactManifest {
    const directory = path.join(container, 'workspace');
    return { digest, directory, entry: path.join(directory, entryRelative), entryRelative };
  }
  private async initialize(): Promise<string> {
    await mkdir(this.root, { recursive: true });
    const root = await realpath(this.root);
    for (const child of ['releases', 'manifests', 'activations', 'tests', 'staging']) {
      const directory = path.join(this.root, child);
      await mkdir(directory, { recursive: true });
      if ((await lstat(directory)).isSymbolicLink()) throw new Error(`Artifact store directory cannot be a symlink: ${child}`);
    }
    return root;
  }

  async stage(sourceRoot: string, entryRelative: string, expectedDigest?: string): Promise<ArtifactManifest> {
    validateEntry(entryRelative);
    if (expectedDigest !== undefined) validateDigest(expectedDigest);
    const source = await realpath(sourceRoot);
    if (!(await lstat(source)).isDirectory()) throw new Error('Artifact workspace must be a directory');
    const root = await this.initialize();
    if (inside(source, root) || inside(root, source)) throw new Error('Artifact store and source workspace must not contain one another');
    const temporary = path.join(this.root, 'staging', randomUUID());
    await mkdir(temporary);
    try {
      await snapshot(source, temporary, root);
      const digest = await contentDigest(temporary, entryRelative);
      if (expectedDigest !== undefined && digest !== expectedDigest) throw new Error(`Artifact digest mismatch: expected ${expectedDigest}, received ${digest}`);
      const artifact = this.manifest(digest, entryRelative);
      const release = path.dirname(artifact.directory);
      try { await rename(temporary, release); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        // Never replace an existing release, even if another writer published it.
        await this.verify(artifact);
      }
      await atomicJson(path.join(this.root, 'manifests', `${digest}.json`), { version: 1, digest, entryRelative } satisfies StoredManifest);
      return artifact;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  }

  async read(digest: string): Promise<ArtifactManifest> {
    validateDigest(digest);
    const stored: unknown = JSON.parse(await readFile(path.join(this.root, 'manifests', `${digest}.json`), 'utf8'));
    if (!stored || typeof stored !== 'object' || !('version' in stored) || stored.version !== 1 || !('digest' in stored) || stored.digest !== digest || !('entryRelative' in stored) || typeof stored.entryRelative !== 'string') {
      throw new Error(`Invalid artifact manifest: ${digest}`);
    }
    validateEntry(stored.entryRelative);
    const artifact = this.manifest(digest, stored.entryRelative);
    await this.verify(artifact);
    return artifact;
  }

  async list(): Promise<ArtifactManifest[]> {
    await this.initialize();
    const names = (await readdir(path.join(this.root, 'manifests'))).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).sort();
    return Promise.all(names.map(name => this.read(name.slice(0, -5))));
  }

  async verify(artifact: ArtifactManifest): Promise<void> {
    validateDigest(artifact.digest); validateEntry(artifact.entryRelative);
    const expected = this.manifest(artifact.digest, artifact.entryRelative);
    if (artifact.directory !== expected.directory || artifact.entry !== expected.entry) throw new Error('Artifact manifest path does not belong to this release store');
    const actual = await contentDigest(path.dirname(artifact.directory), artifact.entryRelative);
    if (actual !== artifact.digest) throw new Error(`Artifact content changed: expected ${artifact.digest}, received ${actual}`);
  }

  /** Unique filenames refresh the entire ESM/CJS dependency graph on every load,
   * including rollback. A URL query alone only refreshes the entry module. */
  async prepareFreshActivation(artifact: ArtifactManifest): Promise<ArtifactManifest> {
    await this.verify(artifact);
    await this.initialize();
    const directory = path.join(this.root, 'activations', `${artifact.digest}-${randomUUID()}`);
    try {
      await copyPrivateTree(path.dirname(artifact.directory), directory);
      const actual = await contentDigest(directory, artifact.entryRelative);
      if (actual !== artifact.digest) throw new Error('Artifact changed while preparing activation');
      return this.manifest(artifact.digest, artifact.entryRelative, directory);
    } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  }

  /** Explicit native command in a fresh workspace copy. No implicit npm scripts,
   * dependency installs, environment scrubbing or execution isolation is implied. */
  async test(artifact: ArtifactManifest, command: ArtifactTestCommand): Promise<ArtifactTestResult> {
    if (!command.command || command.command.includes('\0') || command.args?.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid artifact test command');
    const fresh = await this.prepareFreshActivation(artifact);
    const container = path.dirname(fresh.directory);
    const result: ArtifactTestResult = {
      digest: artifact.digest, command: command.command, args: [...command.args ?? []], testedAt: new Date().toISOString(),
      exitCode: null, signal: null, passed: false, unchanged: false, afterDigest: null,
      stdout: '', stderr: '', outputTruncated: false,
    };
    try {
      await new Promise<void>(resolve => {
        const child = spawn(command.command, result.args, { cwd: fresh.directory, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        const append = (stream: 'stdout' | 'stderr', data: Buffer): void => {
          const limit = 64 * 1024;
          const remaining = Math.max(0, limit - Buffer.byteLength(result[stream]));
          result[stream] += data.subarray(0, remaining).toString('utf8');
          if (data.length > remaining) result.outputTruncated = true;
        };
        child.stdout.on('data', (data: Buffer) => append('stdout', data));
        child.stderr.on('data', (data: Buffer) => append('stderr', data));
        child.once('error', error => { result.error = message(error); });
        child.once('close', (code, signal) => { result.exitCode = code; result.signal = signal; resolve(); });
      });
      try {
        result.afterDigest = await contentDigest(container, artifact.entryRelative);
        result.unchanged = result.afterDigest === artifact.digest;
        if (!result.unchanged) result.error = 'Test modified the artifact contents; its exit status does not verify the staged release';
      } catch (error) { result.error = `Cannot verify artifact after test: ${message(error)}`; }
      // A test can reach the release through ordinary OS permissions. Recheck it,
      // too, without claiming this detects transient edits or hostile code.
      try { await this.verify(artifact); } catch (error) { result.unchanged = false; result.error = message(error); }
      result.passed = result.exitCode === 0 && result.signal === null && result.unchanged && result.error === undefined;
      await atomicJson(path.join(this.root, 'tests', `${artifact.digest}.json`), result);
      return result;
    } finally { await rm(container, { recursive: true, force: true }); }
  }

  async testResult(artifact: ArtifactManifest): Promise<ArtifactTestResult | undefined> {
    validateDigest(artifact.digest);
    let text: string;
    try { text = await readFile(path.join(this.root, 'tests', `${artifact.digest}.json`), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object') throw new Error('Invalid artifact test receipt');
    const receipt = value as Partial<ArtifactTestResult>;
    if (receipt.digest !== artifact.digest || typeof receipt.command !== 'string' || !Array.isArray(receipt.args) || receipt.args.some(arg => typeof arg !== 'string') ||
      typeof receipt.testedAt !== 'string' || !Number.isFinite(Date.parse(receipt.testedAt)) ||
      (receipt.exitCode !== null && !Number.isInteger(receipt.exitCode)) || (receipt.signal !== null && typeof receipt.signal !== 'string') ||
      typeof receipt.passed !== 'boolean' || typeof receipt.unchanged !== 'boolean' ||
      (receipt.afterDigest !== null && (typeof receipt.afterDigest !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.afterDigest))) ||
      typeof receipt.stdout !== 'string' || typeof receipt.stderr !== 'string' || typeof receipt.outputTruncated !== 'boolean' ||
      (receipt.error !== undefined && typeof receipt.error !== 'string') ||
      (receipt.passed && (receipt.exitCode !== 0 || receipt.signal !== null || !receipt.unchanged || receipt.afterDigest !== artifact.digest || receipt.error !== undefined))) {
      throw new Error('Invalid artifact test receipt');
    }
    // A historical pass must never be presented for a now-mutated release.
    await this.verify(artifact);
    return receipt as ArtifactTestResult;
  }
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, file); }
  finally { await rm(temporary, { force: true }); }
}

async function snapshot(source: string, destination: string, store: string): Promise<void> {
  // Discover before assigning destinations: a link to a subpackage may sort
  // before a link to its enclosing bundle. Both must use the same final tree,
  // regardless of discovery order, so parent imports and module identity survive.
  const targets = new Map<string, string>();
  const visited = new Set<string>();
  const packages = new Set<string>();
  const discover = async (input: string, logical: string, ancestors: Set<string>): Promise<void> => {
    const info = await lstat(input);
    if (info.isSymbolicLink()) {
      const target = await realpath(input);
      if (inside(store, target)) throw new Error('Artifact source links into its release store');
      if (ancestors.has(target)) throw new Error(`Cyclic artifact symlink: ${input}`);
      if (!inside(source, target) && !targets.has(target)) targets.set(target, logical);
      await discover(target, logical, ancestors);
    } else if (info.isDirectory()) {
      const actual = await realpath(input);
      if (inside(store, actual)) throw new Error('Artifact source includes its release store');
      if (ancestors.has(actual)) throw new Error(`Cyclic artifact directory: ${input}`);
      if (visited.has(actual)) return;
      visited.add(actual);
      const next = new Set(ancestors).add(actual);
      const names = (await readdir(input)).sort();
      if (names.includes('package.json')) packages.add(actual);
      for (const name of names) await discover(path.join(input, name), `${logical}/${name}`, next);
    } else if (!info.isFile()) { throw new Error(`Artifact workspace contains a non-ordinary file: ${input}`); }
  };
  await discover(source, 'workspace', new Set());

  const roots = new Set<string>([source]);
  for (const target of targets.keys()) {
    if ([...targets.keys()].some(other => other !== target && inside(other, target))) continue;
    if (!(await lstat(target)).isDirectory()) throw new Error(`External file link needs package scope; link the containing package directory instead: ${target}`);
    roots.add(target);
  }
  for (const original of roots) {
    const scope = await packageScope(original);
    if (scope && !inside(original, scope)) throw new Error(`Inherited package scope is outside the snapshot; link the containing package directory instead: ${scope}`);
  }
  const closure = await declaredDependencies(source, roots, packages);
  const coordinates = [...roots, ...closure.links.map(link => link.candidate)];
  let base = path.dirname(source);
  while (coordinates.some(file => !inside(base, file))) base = path.dirname(base);
  // Node treats real paths beneath node_modules specially. Do not strip such
  // an ancestor merely because every selected root happens to be beneath it.
  for (let ancestor = base; ; ancestor = path.dirname(ancestor)) {
    if (path.basename(ancestor) === 'node_modules') base = path.dirname(ancestor);
    if (ancestor === path.dirname(ancestor)) break;
  }
  const tree = path.join(destination, 'dependencies', 'tree');
  const mirrored = (file: string): string => path.join(tree, path.relative(base, file));
  const materialized = new Map([...roots].map(original => [original, mirrored(original)]));
  // Only selected roots are copied. Empty sparse ancestors preserve their
  // relative topology without capturing unrelated files from the common parent.
  await writeFile(path.join(destination, 'package.json'), '{}\n', { flag: 'wx' });
  await mkdir(tree, { recursive: true });
  const copy = async (input: string, output: string, ancestors: Set<string>): Promise<void> => {
    const info = await lstat(input);
    if (info.isSymbolicLink()) {
      const target = await realpath(input);
      if (inside(store, target)) throw new Error('Artifact source links into its release store');
      if (ancestors.has(target)) throw new Error(`Cyclic artifact symlink: ${input}`);
      const containing = [...materialized.entries()].find(([original]) => inside(original, target));
      if (!containing) throw new Error(`Artifact symlink target changed while staging: ${input}`);
      const privateTarget = path.join(containing[1], path.relative(containing[0], target));
      await symlink(path.relative(path.dirname(output), privateTarget), output);
    } else if (info.isDirectory()) {
      const actual = await realpath(input);
      if (inside(store, actual)) throw new Error('Artifact source includes its release store');
      if (ancestors.has(actual)) throw new Error(`Cyclic artifact directory: ${input}`);
      const next = new Set(ancestors).add(actual);
      await mkdir(output);
      for (const name of (await readdir(input)).sort()) await copy(path.join(input, name), path.join(output, name), next);
      await chmod(output, info.mode & 0o777);
    } else if (info.isFile()) {
      await copyFile(input, output);
      await chmod(output, info.mode & 0o777);
    } else { throw new Error(`Artifact workspace contains a non-ordinary file: ${input}`); }
  };
  for (const [original, output] of materialized) {
    await mkdir(path.dirname(output), { recursive: true });
    await copy(original, output, new Set());
  }
  for (const manifest of closure.manifests) {
    if (await readFile(path.join(mirrored(manifest.directory), 'package.json'), 'utf8') !== manifest.text) throw new Error('Package manifest changed while staging');
  }
  for (const link of closure.links) {
    if ([...roots].some(root => inside(root, link.candidate))) continue; // Already authored and copied.
    const destinationLink = mirrored(link.candidate), target = mirrored(link.target);
    const existing = await optionalRealpath(destinationLink);
    if (existing) {
      if (existing !== await realpath(target)) throw new Error(`Conflicting captured dependency: ${link.candidate}`);
      continue;
    }
    await mkdir(path.dirname(destinationLink), { recursive: true });
    await symlink(path.relative(path.dirname(destinationLink), target), destinationLink);
  }
  await symlink(path.relative(destination, mirrored(source)), path.join(destination, 'workspace'));
}

async function optionalRealpath(file: string): Promise<string | undefined> {
  try { return await realpath(file); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined; throw error; }
}
async function packageScope(directory: string): Promise<string | undefined> {
  for (let current = directory; ; current = path.dirname(current)) {
    if (path.basename(current) === 'node_modules') return undefined;
    const manifest = path.join(current, 'package.json');
    if (await optionalRealpath(manifest)) return manifest;
    if (current === path.dirname(current)) return undefined;
  }
}
async function packageCandidates(directory: string, name: string, rejectBareFiles = true): Promise<Array<{ candidate: string; target: string }>> {
  if (!/^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name) || name.split('/').some(part => part === '.' || part === '..')) throw new Error(`Invalid declared package name: ${name}`);
  const resolved: Array<{ candidate: string; target: string }> = [];
  for (let current = directory; ; current = path.dirname(current)) {
    if (path.basename(current) !== 'node_modules') {
      const candidate = path.join(current, 'node_modules', name);
      const target = await optionalRealpath(candidate);
      // CJS can load exact files or append these suffixes before directory
      // fallback. Reject that unsupported layout, including file/directory
      // ambiguity, rather than silently treating it as an absent package.
      for (const suffix of ['', '.js', '.json', '.node']) {
        const file = suffix ? await optionalRealpath(`${candidate}${suffix}`) : target;
        if (file && ((await lstat(file)).isFile() || (!suffix && !(await lstat(file)).isDirectory()))) {
          if (!rejectBareFiles) return [];
          throw new Error(`Declared bare-file dependency ${name} is unsupported: ${file}; use a containing package directory or an explicit relative import`);
        }
      }
      if (target) resolved.push({ candidate, target });
    }
    // CJS can continue past an incomplete directory or missing subpath. Close
    // the entire declared namespace instead of assuming the nearest one wins.
    if (current === path.dirname(current)) return resolved;
  }
}
function dependencyNames(manifest: unknown, directory: string, workspaceRoot: boolean): Map<string, boolean> {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error(`Invalid package manifest: ${directory}`);
  const names = new Map<string, boolean>();
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    const value: unknown = (manifest as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${field}: ${directory}`);
    // Published packages' dev toolchains are not required runtime closure.
    // Workspace-root dev dependencies are intentional authoring dependencies.
    const required = field !== 'devDependencies' || workspaceRoot;
    for (const name of Object.keys(value)) names.set(name, (names.get(name) ?? false) || required);
  }
  return names;
}
async function declaredDependencies(source: string, roots: Set<string>, packages: Set<string>): Promise<{
  links: Array<{ candidate: string; target: string }>;
  manifests: Array<{ directory: string; text: string }>;
}> {
  const links: Array<{ candidate: string; target: string }> = [];
  const manifests: Array<{ directory: string; text: string }> = [];
  for (const directory of packages) {
    const text = await readFile(path.join(directory, 'package.json'), 'utf8');
    manifests.push({ directory, text });
    const manifest: unknown = JSON.parse(text);
    const names = dependencyNames(manifest, directory, directory === source);
    for (const [name, required] of names) {
      for (const resolved of await packageCandidates(directory, name, required)) {
        if (![...roots].some(root => inside(root, resolved.target))) {
          if (required) throw new Error(`Missing dependency closure for ${name} in ${directory}; explicitly link its containing package directory into the workspace`);
          continue;
        }
        links.push(resolved);
      }
    }
  }
  return { links, manifests };
}

async function copyPrivateTree(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) { await symlink(await readlink(source), destination); }
  else if (info.isDirectory()) {
    await mkdir(destination);
    for (const name of (await readdir(source)).sort()) await copyPrivateTree(path.join(source, name), path.join(destination, name));
    await chmod(destination, info.mode & 0o777);
  } else if (info.isFile()) { await copyFile(source, destination); await chmod(destination, info.mode & 0o777); }
  else { throw new Error('Artifact contains a non-ordinary file'); }
}

async function contentDigest(container: string, entryRelative: string): Promise<string> {
  const base = await realpath(container);
  if ((await lstat(container)).isSymbolicLink()) throw new Error('Artifact release cannot be a symlink');
  const hash = createHash('sha256').update(`mira-extension-artifact-v1\n${JSON.stringify(entryRelative)}\n`);
  const packages = new Set<string>();
  const visit = async (file: string, relative: string): Promise<void> => {
    const info = await lstat(file), mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      const target = await readlink(file);
      if (path.isAbsolute(target) || !inside(base, path.resolve(path.dirname(file), target)) || !inside(base, await realpath(file))) throw new Error(`Artifact symlink escapes its private tree: ${relative}`);
      hash.update(`${JSON.stringify([relative, 'link', target])}\n`);
    } else if (info.isDirectory()) {
      hash.update(`${JSON.stringify([relative, 'directory', mode])}\n`);
      const names = (await readdir(file)).sort();
      if (names.includes('package.json')) packages.add(file);
      for (const name of names) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) {
      const data = await readFile(file);
      hash.update(`${JSON.stringify([relative, 'file', mode, data.length])}\n`).update(data);
    } else { throw new Error(`Artifact contains a non-ordinary file: ${relative}`); }
  };
  // The store root (or any ancestor) may be an ordinary directory alias. Use
  // canonical paths throughout traversal while still rejecting a release that
  // is itself a symlink above. Mixing lexical paths with base falsely escapes.
  await visit(base, '');
  const entry = path.join(base, 'workspace', entryRelative);
  if (!inside(base, await realpath(entry)) || !(await lstat(await realpath(entry))).isFile()) throw new Error('Artifact entry is not a private regular file');
  const workspace = await realpath(path.join(base, 'workspace'));
  // An optional/peer dependency absent when authored must not become ambient
  // host code. Recheck at every identity boundary, including the fresh path:
  // release and activation parents can expose different node_modules trees.
  for (const directory of packages) {
    const manifest: unknown = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    for (const [name, required] of dependencyNames(manifest, directory, directory === workspace)) {
      if (!required) continue;
      for (const resolved of await packageCandidates(directory, name, required)) {
        if (!inside(base, resolved.target)) throw new Error(`Artifact declared dependency ${name} resolves outside its private tree: ${resolved.target}`);
      }
    }
  }
  return hash.digest('hex');
}
