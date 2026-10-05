import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export interface MemoryWorkspaceOptions {
  memoryRoot: string;
  stateRoot: string;
  /** The actual source checkout root; neither data root may overlap it. */
  sourceDirectory: string;
  signal?: AbortSignal;
}
export interface MemoryWorkspace { memoryRoot: string; stateRoot: string }
export interface MemoryBootstrapOptions extends MemoryWorkspace {
  /** Explicit relative paths, including nested files, inside stateRoot. */
  stateFiles?: readonly string[];
  signal?: AbortSignal;
}
export interface BootstrapFile { path: string; content: string }
export interface MemoryBootstrap { memory: BootstrapFile; state: BootstrapFile[] }
export interface MemorySnapshotOptions {
  memoryRoot: string;
  miraId: string;
  runId: string;
  signal?: AbortSignal;
}
export interface MemorySnapshot {
  miraId: string;
  runId: string;
  /** null means this run observed no tree change and created no commit. */
  commitId: string | null;
  changed: boolean;
  recovered: boolean;
  /** Paths changed since the prior Git revision, not claims of authorship. */
  changedPaths: string[];
}

const REGISTRATION = 'mira-memory-workspace.json';
const ZERO_OID = '0'.repeat(40);
function errorCode(error: unknown): string | number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error &&
      (typeof error.code === 'string' || typeof error.code === 'number')) return error.code;
  return undefined;
}
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function absolute(location: string): string {
  if (typeof location !== 'string' || !path.isAbsolute(location) || location.includes('\0')) {
    throw new Error('Memory/State configuration requires absolute paths');
  }
  return path.resolve(location);
}
async function exists(location: string): Promise<boolean> {
  try { await lstat(location); return true; }
  catch (error) { if (errorCode(error) === 'ENOENT') return false; throw error; }
}
/** Resolve existing ancestors before creating anything, including symlinks. */
async function canonical(location: string): Promise<string> {
  try { return await realpath(location); }
  catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    const parent = path.dirname(location);
    if (parent === location) throw error;
    return path.join(await canonical(parent), path.basename(location));
  }
}
async function assertNoGitAncestor(root: string, allowRootGit: boolean): Promise<void> {
  for (let current = root; ; current = path.dirname(current)) {
    if (!(allowRootGit && current === root) && await exists(path.join(current, '.git'))) {
      // Some hosts expose non-repository .git placeholders at mount roots.
      // Ask Git rather than mistaking any directory named .git for history.
      const detected = await git(current, ['rev-parse', '--show-toplevel'], undefined, undefined, [128]);
      if (detected.code === 0) throw new Error('Memory must have an independent Git repository; State must stay outside all Git repositories');
      if (!detected.stderr.includes('not a git repository')) throw new Error(detected.stderr.trim());
    }
    if (path.dirname(current) === current) break;
  }
}
async function regularText(location: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const file = await open(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await file.stat()).isFile()) throw new Error('Bootstrap inputs must be ordinary files');
    return await file.readFile({ encoding: 'utf8', ...(signal ? { signal } : {}) });
  } finally { await file.close(); }
}

interface GitResult { stdout: string; stderr: string; code: number }
/** Git only: no shell interpolation, global Git configuration, hooks or remote access. */
async function git(root: string, args: string[], signal?: AbortSignal, input?: string, allowedCodes: readonly number[] = []): Promise<GitResult> {
  signal?.throwIfAborted();
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'Mira', GIT_AUTHOR_EMAIL: 'mira@localhost',
    GIT_COMMITTER_NAME: 'Mira', GIT_COMMITTER_EMAIL: 'mira@localhost',
  });
  return await new Promise<GitResult>((resolve, reject) => {
    const child = execFile('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', 'commit.gpgSign=false', '-C', root, ...args], {
      env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(signal ? { signal } : {}),
    }, (error, stdout, stderr) => {
      const code = error ? errorCode(error) : 0;
      if (!error || (typeof code === 'number' && allowedCodes.includes(code))) {
        resolve({ stdout, stderr, code: typeof code === 'number' ? code : 0 });
      } else reject(error);
    });
    // update-ref uses a command stream; callers supply generated ref/OID tokens,
    // never arbitrary run IDs or file paths in this stream.
    child.stdin?.on('error', () => { /* execFile reports process failure/abort. */ });
    child.stdin?.end(input);
  });
}
async function repository(root: string, signal?: AbortSignal): Promise<void> {
  const dotGit = path.join(root, '.git');
  const stat = await lstat(dotGit);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Memory requires its own .git directory, not a linked worktree');
  const top = (await git(root, ['rev-parse', '--show-toplevel'], signal)).stdout.trim();
  const common = (await git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'], signal)).stdout.trim();
  if (await realpath(top) !== root || await realpath(common) !== dotGit) throw new Error('Memory Git repository must be independent at memoryRoot');
  // SHA-1 and SHA-256 repositories both work; callers derive zero OIDs below.
}
async function registeredRoot(location: string, signal?: AbortSignal): Promise<string> {
  const root = await realpath(absolute(location));
  await assertNoGitAncestor(root, true);
  await repository(root, signal);
  const registration: unknown = JSON.parse(await regularText(path.join(root, '.git', REGISTRATION), signal));
  if (typeof registration !== 'object' || registration === null || !('version' in registration) || registration.version !== 1 ||
      !('memoryRoot' in registration) || registration.memoryRoot !== root) throw new Error('Memory repository registration does not match memoryRoot');
  return root;
}

/** Create only MEMORY.md and ordinary empty State, preserving all existing files.
 * This configures data storage, not a restriction on the agent's shell/workdir.
 */
export async function setupMemoryWorkspace(options: MemoryWorkspaceOptions): Promise<MemoryWorkspace> {
  options.signal?.throwIfAborted();
  const source = await realpath(absolute(options.sourceDirectory));
  const memoryRoot = await canonical(absolute(options.memoryRoot));
  const stateRoot = await canonical(absolute(options.stateRoot));
  if ([memoryRoot, stateRoot].some((root) => within(source, root) || within(root, source)) ||
      within(memoryRoot, stateRoot) || within(stateRoot, memoryRoot)) {
    throw new Error('Memory, State and source directories must be separate and non-overlapping');
  }
  await assertNoGitAncestor(memoryRoot, true);
  await assertNoGitAncestor(stateRoot, false);
  await mkdir(memoryRoot, { recursive: true, mode: 0o700 });
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  if (await realpath(memoryRoot) !== memoryRoot || await realpath(stateRoot) !== stateRoot) throw new Error('Memory/State roots changed during setup');
  await assertNoGitAncestor(memoryRoot, true);
  await assertNoGitAncestor(stateRoot, false);
  if (!await exists(path.join(memoryRoot, '.git'))) await git(memoryRoot, ['init', '--quiet', '--initial-branch=main'], options.signal);
  await repository(memoryRoot, options.signal);
  const memory = path.join(memoryRoot, 'MEMORY.md');
  try {
    const handle = await open(memory, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
  await regularText(memory, options.signal);
  const gitDirectory = path.join(memoryRoot, '.git');
  const registrationPath = path.join(gitDirectory, REGISTRATION);
  if (!await exists(registrationPath)) {
    const pending = await mkdtemp(path.join(gitDirectory, '.mira-registration-'));
    const temporary = path.join(pending, 'registration');
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify({ version: 1, memoryRoot })); await handle.sync(); } finally { await handle.close(); }
      // Publish without ever exposing a partially-written registration or
      // overwriting a concurrent winner. A crash may leave harmless temp data.
      try { await link(temporary, registrationPath); }
      catch (error) { if (errorCode(error) !== 'EEXIST') throw error; }
      const directory = await open(gitDirectory, constants.O_RDONLY | constants.O_DIRECTORY);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(pending, { recursive: true, force: true }); }
  }
  await registeredRoot(memoryRoot, options.signal);
  return { memoryRoot, stateRoot };
}

/** Called by the runtime only for genuine first-context initialization.
 * No directory scanning, per-wake refresh, watcher or context injection occurs.
 */
export async function loadMemoryBootstrap(options: MemoryBootstrapOptions): Promise<MemoryBootstrap> {
  const memoryRoot = await registeredRoot(options.memoryRoot, options.signal);
  const stateRoot = await realpath(absolute(options.stateRoot));
  if (within(memoryRoot, stateRoot) || within(stateRoot, memoryRoot)) throw new Error('Memory and State roots must be separate');
  await assertNoGitAncestor(stateRoot, false);
  const memoryPath = path.join(memoryRoot, 'MEMORY.md');
  const memory = { path: memoryPath, content: await regularText(memoryPath, options.signal) };
  const state: BootstrapFile[] = [];
  for (const relative of options.stateFiles ?? []) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Configured State files must be relative paths within stateRoot');
    const file = await realpath(path.resolve(stateRoot, relative));
    if (!within(stateRoot, file)) throw new Error('Configured State files must stay within stateRoot');
    await assertNoGitAncestor(path.dirname(file), false);
    if (!state.some((entry) => entry.path === file)) state.push({ path: file, content: await regularText(file, options.signal) });
  }
  return { memory, state };
}

function identifier(value: string, label: string): void {
  if (typeof value !== 'string' || !value || value.length > 4096 || !value.isWellFormed()) throw new Error(`${label} must be nonempty well-formed text of at most 4096 characters`);
}
function runKey(options: MemorySnapshotOptions): string {
  return createHash('sha256').update(JSON.stringify([options.miraId, options.runId])).digest('hex');
}
async function outcome(root: string, ref: string, options: MemorySnapshotOptions, recovered: boolean): Promise<MemorySnapshot | null> {
  const found = await git(root, ['rev-parse', '--verify', '--quiet', ref], options.signal, undefined, [1]);
  let oid = found.stdout.trim();
  if (found.code === 1) {
    // Ref transactions lock/check all writes together, but a host crash need
    // not persist multiple ref files together. Recover a published HEAD
    // commit by its key trailer even if its receipt ref was not persisted.
    const head = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], options.signal, undefined, [1]);
    if (head.code === 1) return null;
    const candidates = (await git(root, ['log', 'HEAD', '--format=%H', '--fixed-strings', `--grep=Mira-Run-Key: ${runKey(options)}`], options.signal)).stdout.trim().split('\n').filter(Boolean);
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw new Error('Multiple Memory commits claim the same run key');
    oid = candidates[0]!;
    // The exact trailer check below runs before rebuilding the receipt.
  }
  const type = (await git(root, ['cat-file', '-t', oid], options.signal)).stdout.trim();
  if (type !== 'tree' && type !== 'commit') throw new Error('Unexpected Memory snapshot receipt object');
  if (type === 'commit') {
    const message = (await git(root, ['show', '-s', '--format=%B', oid], options.signal)).stdout.split('\n');
    for (const expected of [`Mira-Run-Key: ${runKey(options)}`, `Mira-Id-Base64: ${Buffer.from(options.miraId).toString('base64')}`, `Mira-Run-Id-Base64: ${Buffer.from(options.runId).toString('base64')}`]) {
      if (!message.includes(expected)) throw new Error('Memory snapshot commit does not match this Mira/run key');
    }
  }
  if (found.code === 1) {
    try { await git(root, ['update-ref', ref, oid, '0'.repeat(oid.length)], options.signal); }
    catch (error) {
      if (options.signal?.aborted) throw error;
      const winner = await git(root, ['rev-parse', '--verify', '--quiet', ref], options.signal, undefined, [1]);
      if (winner.stdout.trim() !== oid) throw error;
    }
  }
  const changedPaths = type === 'commit'
    ? (await git(root, ['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', oid], options.signal)).stdout.split('\0').filter(Boolean)
    : [];
  return { miraId: options.miraId, runId: options.runId, commitId: type === 'commit' ? oid : null,
    changed: type === 'commit', recovered, changedPaths };
}

/** Snapshot the current Memory worktree once for this Mira/run key. Git and the
 * caller's PostgreSQL receipt are separate commits: retry this exact key if the
 * database association fails. A no-change result is durable without a commit.
 * Files present/changed before this wake are included too; no authorship claim.
 */
export async function snapshotMemory(options: MemorySnapshotOptions): Promise<MemorySnapshot> {
  identifier(options.miraId, 'miraId'); identifier(options.runId, 'runId');
  const root = await registeredRoot(options.memoryRoot, options.signal);
  const key = runKey(options);
  const ref = `refs/mira/wake-snapshots/${key}`;
  const prior = await outcome(root, ref, options, true);
  if (prior) return prior;
  const headResult = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], options.signal, undefined, [1]);
  const head = headResult.code === 0 ? headResult.stdout.trim() : null;
  const oldTree = head
    ? (await git(root, ['rev-parse', `${head}^{tree}`], options.signal)).stdout.trim()
    : (await git(root, ['hash-object', '-t', 'tree', '--stdin'], options.signal, '')).stdout.trim();
  // Ordinary Git semantics: honor .gitignore; stage additions/modifications/
  // deletions from the worktree, including changes that predate this wake.
  await git(root, ['add', '-A', '--', '.'], options.signal);
  const tree = (await git(root, ['write-tree'], options.signal)).stdout.trim();
  const zero = head ? '0'.repeat(head.length) : (tree.length === 64 ? '0'.repeat(64) : ZERO_OID);
  let object = tree;
  const changed = tree !== oldTree;
  if (changed) {
    const message = `Memory snapshot\n\nMira-Run-Key: ${key}\nMira-Id-Base64: ${Buffer.from(options.miraId).toString('base64')}\nMira-Run-Id-Base64: ${Buffer.from(options.runId).toString('base64')}\n`;
    object = (await git(root, ['commit-tree', tree, ...(head ? ['-p', head] : []), '-m', message], options.signal)).stdout.trim();
  }
  const commands = `start\n${changed ? `update HEAD ${object} ${head ?? zero}` : `verify HEAD ${head ?? zero}`}\ncreate ${ref} ${object}\nprepare\ncommit\n`;
  try { await git(root, ['update-ref', '--stdin'], options.signal, commands); }
  catch (error) {
    // A concurrent same-key caller may already have published. Cancellation and
    // genuine command errors stay errors; retries recover the durable receipt.
    if (options.signal?.aborted) throw error;
    const winner = await outcome(root, ref, options, true);
    if (winner) return winner;
    throw error;
  }
  const result = await outcome(root, ref, options, false);
  if (!result) throw new Error('Memory snapshot receipt disappeared after publication');
  return result;
}
