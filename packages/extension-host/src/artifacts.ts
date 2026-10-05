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
 * Every load rechecks bytes; callers still authorize testing/import/execution. */
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
  const workspace = path.join(destination, 'workspace');
  const materialized = new Map<string, string>([[source, workspace]]);
  await mkdir(path.join(destination, 'dependencies'));
  const copy = async (input: string, output: string, ancestors: Set<string>): Promise<void> => {
    const info = await lstat(input);
    if (info.isSymbolicLink()) {
      const target = await realpath(input);
      if (inside(store, target)) throw new Error('Artifact source links into its release store');
      if (ancestors.has(target)) throw new Error(`Cyclic artifact symlink: ${input}`);
      // A link into an existing tree must keep that tree's relative layout.
      // Copying only its target into a new bucket breaks sibling/parent imports
      // even though those files are already present in the workspace snapshot.
      const containing = [...materialized.entries()]
        .filter(([original]) => inside(original, target))
        .sort(([left], [right]) => right.length - left.length)[0];
      let privateTarget = containing ? path.join(containing[1], path.relative(containing[0], target)) : undefined;
      if (!privateTarget) {
        // Stable logical link names make content identity independent of original
        // checkout location. Dependencies live outside node_modules because Node
        // intentionally does not strip TypeScript beneath node_modules.
        const key = createHash('sha256').update(path.relative(destination, output).split(path.sep).join('/')).digest('hex');
        privateTarget = path.join(destination, 'dependencies', key);
        materialized.set(target, privateTarget);
        await copy(target, privateTarget, ancestors);
      }
      await symlink(path.relative(path.dirname(output), privateTarget), output);
      return;
    }
    if (info.isDirectory()) {
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
  await copy(source, workspace, new Set());
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
  const visit = async (file: string, relative: string): Promise<void> => {
    const info = await lstat(file), mode = info.mode & 0o777;
    if (info.isSymbolicLink()) {
      const target = await readlink(file);
      if (path.isAbsolute(target) || !inside(base, path.resolve(path.dirname(file), target)) || !inside(base, await realpath(file))) throw new Error(`Artifact symlink escapes its private tree: ${relative}`);
      hash.update(`${JSON.stringify([relative, 'link', target])}\n`);
    } else if (info.isDirectory()) {
      hash.update(`${JSON.stringify([relative, 'directory', mode])}\n`);
      for (const name of (await readdir(file)).sort()) await visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else if (info.isFile()) {
      const data = await readFile(file);
      hash.update(`${JSON.stringify([relative, 'file', mode, data.length])}\n`).update(data);
    } else { throw new Error(`Artifact contains a non-ordinary file: ${relative}`); }
  };
  await visit(container, '');
  const entry = path.join(container, 'workspace', entryRelative);
  if (!inside(base, await realpath(entry)) || !(await lstat(await realpath(entry))).isFile()) throw new Error('Artifact entry is not a private regular file');
  return hash.digest('hex');
}
