import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, readdir, realpath, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface WakeInputFileOptions {
  /** Absolute private spool directory; outside HOME unless explicitly managed. */
  rootDirectory: string;
  /** Explicit private application data root; permits only its strict descendants in HOME. */
  managedDataRoot?: string;
  /** Explicit source checkout root, not inferred from the process cwd. */
  sourceDirectory: string;
  /** Stable ID and full serialized content supplied from canonical run state. */
  runId: string;
  content: string;
}
export interface WakeInputFile { path: string; bytes: number }
const FILE_NAME = 'batch.txt';
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function isWithin(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
function code(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
}
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
function assertPrivate(stat: BigIntStats, label: string): void {
  if ((stat.mode & 0o077n) !== 0n || (process.getuid && stat.uid !== BigInt(process.getuid()))) {
    throw new Error(`${label} must be owned by the current user and inaccessible to other users`);
  }
}
async function statOrMissing(filePath: string): Promise<BigIntStats | undefined> {
  try { return await lstat(filePath, { bigint: true }); }
  catch (error) { if (code(error) === 'ENOENT') return undefined; throw error; }
}
async function assertDirectory(directory: string): Promise<BigIntStats> {
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Wake input directories must be real directories, not symlinks');
  assertPrivate(stat, 'Wake input directory');
  return stat;
}
async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
function assertLocation(root: string, source: string, home: string, managed?: string): void {
  if (root === path.parse(root).root || isWithin(source, root)) throw new Error('Wake input root must be outside the source directory and user home');
  if (managed !== undefined) {
    if (managed === path.parse(managed).root || managed === home || isWithin(managed, home) ||
        isWithin(source, managed) || isWithin(managed, source) || root === managed || !isWithin(managed, root)) {
      throw new Error('Wake input managed data root must be separate from source and HOME, and strictly contain the spool');
    }
  } else if (isWithin(home, root)) throw new Error('Wake input root must be outside the source directory and user home');
}
async function ensureRoot(rootDirectory: string, sourceDirectory: string, managedDataRoot: string | undefined, identity?: BigIntStats): Promise<BigIntStats> {
  const source = await realpath(sourceDirectory);
  const home = await realpath(homedir());
  assertLocation(rootDirectory, source, home, managedDataRoot);
  // Check every component before creating its child; recursive mkdir would
  // otherwise follow a pre-existing symlink in an ancestor.
  const { root } = path.parse(rootDirectory);
  let current = root;
  for (const component of rootDirectory.slice(root.length).split(path.sep)) {
    current = path.join(current, component);
    let stat = await statOrMissing(current);
    if (!stat) {
      try { await mkdir(current, { mode: 0o700 }); }
      catch (error) { if (code(error) !== 'EEXIST') throw error; }
      stat = await lstat(current, { bigint: true });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Wake input path cannot contain symlinks or non-directories');
    if (current === managedDataRoot) assertPrivate(stat, 'Wake input managed data root');
    // Ancestor write bits do not gate spool access. The managed/spool roots
    // and published artifacts still require private permissions below.
    if (process.getuid && stat.uid !== 0n && stat.uid !== BigInt(process.getuid()) && (stat.mode & 0o1000n) === 0n) {
      throw new Error('Wake input ancestor must be owned by the current user or root');
    }
  }
  if (managedDataRoot !== undefined) await assertDirectory(managedDataRoot);
  const actual = await assertDirectory(rootDirectory);
  if (identity && !sameIdentity(identity, actual)) throw new Error('Wake input root was replaced');
  return actual;
}
async function verifyExisting(directory: string, expected: Buffer): Promise<boolean> {
  const directoryStat = await statOrMissing(directory);
  if (!directoryStat) return false;
  await assertDirectory(directory);
  const filePath = path.join(directory, FILE_NAME);
  const before = await statOrMissing(filePath);
  if (!before) {
    if ((await readdir(directory)).length !== 0) throw new Error('Wake input directory contains unexpected files');
    return false; // A missing disposable file can be reconstructed.
  }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) throw new Error('Wake input must be a regular file without hard links or symlinks');
  assertPrivate(before, 'Wake input file');
  if (before.size !== BigInt(expected.byteLength)) throw new Error('Wake input content conflict for this run; existing data preserved');
  const handle = await open(filePath, READ_FLAGS);
  try {
    if (!sameFile(before, await handle.stat({ bigint: true }))) throw new Error('Wake input file changed during open');
    const buffer = Buffer.alloc(Math.min(65_536, Math.max(1, expected.byteLength)));
    let offset = 0;
    while (offset < expected.byteLength) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, expected.byteLength - offset), offset);
      if (bytesRead === 0 || !buffer.subarray(0, bytesRead).equals(expected.subarray(offset, offset + bytesRead))) {
        throw new Error('Wake input content conflict for this run; existing data preserved');
      }
      offset += bytesRead;
    }
    if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await lstat(filePath, { bigint: true })) ||
        !sameIdentity(directoryStat, await assertDirectory(directory))) throw new Error('Wake input file changed during verification');
    return true;
  } finally { await handle.close(); }
}

/** Write an ordinary UTF-8 text file, derived from canonical PostgreSQL state.
 * The returned file can be read with normal file tools. No file reader, memory
 * API, secondary run registry or automatic cleanup is introduced here.
 * Existing differing content is never overwritten. The host process owner is
 * trusted; this is not a sandbox against arbitrary same-UID code.
 */
export async function writeWakeInput(options: WakeInputFileOptions): Promise<WakeInputFile> {
  for (const directory of [options.rootDirectory, options.sourceDirectory, ...(options.managedDataRoot === undefined ? [] : [options.managedDataRoot])]) {
    if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') || directory.split(path.sep).includes('..')) {
      throw new Error('Wake input configuration requires absolute paths without traversal');
    }
  }
  const root = path.resolve(options.rootDirectory);
  const source = path.resolve(options.sourceDirectory);
  const managed = options.managedDataRoot === undefined ? undefined : path.resolve(options.managedDataRoot);
  assertLocation(root, source, path.resolve(homedir()), managed);
  if (typeof options.runId !== 'string' || options.runId.length === 0 || options.runId.length > 4096) throw new Error('Wake input requires a nonempty stable run ID of at most 4096 characters');
  if (typeof options.content !== 'string' || !options.content.isWellFormed()) throw new Error('Wake input content must be well-formed Unicode text');
  const bytes = Buffer.from(options.content, 'utf8');
  // Run IDs never become path components, including IDs containing ../ or NUL.
  const directory = path.join(root, createHash('sha256').update(options.runId).digest('hex'));
  const filePath = path.join(directory, FILE_NAME);
  const identity = await ensureRoot(root, source, managed);
  if (!await verifyExisting(directory, bytes)) {
    const stage = await mkdtemp(path.join(root, '.pending-'));
    const temporary = path.join(stage, 'batch.tmp');
    const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.chmod(0o400);
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path.join(stage, FILE_NAME));
    await syncDirectory(stage);
    await ensureRoot(root, source, managed, identity);
    // A directory rename cannot replace a nonempty published directory. This
    // gives atomic publication without the clobbering behavior of file rename.
    try { await rename(stage, directory); }
    catch (error) { if (code(error) !== 'EEXIST' && code(error) !== 'ENOTEMPTY') throw error; }
    await syncDirectory(root);
    if (!await verifyExisting(directory, bytes)) throw new Error('Wake input file disappeared during publication');
  }
  await ensureRoot(root, source, managed, identity);
  return { path: filePath, bytes: bytes.byteLength };
}

export { MemoryReadLimitError, setupMemoryWorkspace, loadMemoryBootstrap, snapshotMemory, boundPromptMemory, loadPromptMemory, MEMORY_PROMPT_BYTES, resetMemoryWorkspace, memoryUsage } from './memory.ts';
export type { MemoryWorkspaceOptions, MemoryWorkspace, MemoryBootstrapOptions, BootstrapFile, MemoryBootstrap, MemorySnapshotOptions, MemorySnapshot, MemoryResetOptions, MemoryResetResult, MemoryUsage } from './memory.ts';
