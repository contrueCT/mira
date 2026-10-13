import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** Private disk format, for a trusted same-OS-account client to read at runtime.
 * Never put this object in API responses, process arguments, logs or history. */
export interface ExternalSenderCredential { version: 1; id: string; token: string | null }
export interface ExternalAccessConfiguration { version: 1; enabled: boolean }
export interface ExternalSenderStatus {
  id: string;
  credentialFile: string;
  state: 'active' | 'revoked' | 'missing';
}
export interface ExternalAccessStatus {
  enabled: boolean;
  accessFile: string;
  sender?: ExternalSenderStatus;
}
export interface ExternalAccessStoreOptions {
  miraHome: string;
  sourceDirectory: string;
  memoryRoot?: string;
  artifactsDirectory?: string;
}
export const externalAccessMaxBytes = 4_096;
export class ExternalAccessError extends Error {
  readonly code: 'invalid_external_access' | 'external_access_conflict' | 'external_access_unavailable';
  constructor(code: ExternalAccessError['code']) {
    super({
      invalid_external_access: 'Invalid external access command or sender identity',
      external_access_conflict: 'External access changed or is busy; inspect status before retrying',
      external_access_unavailable: 'External access is unavailable; inspect the protected local configuration',
    }[code]);
    this.name = 'ExternalAccessError'; this.code = code;
  }
}
const unavailable = (): never => { throw new ExternalAccessError('external_access_unavailable'); };
const invalid = (): never => { throw new ExternalAccessError('invalid_external_access'); };
const conflict = (): never => { throw new ExternalAccessError('external_access_conflict'); };
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const missingRevision = digest('mira-external-access:missing');
const errno = (error: unknown, code: string): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === code;
function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value)) return invalid();
  return value;
}
function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/u.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value;
}
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
const overlap = (first: string, second: string): boolean => within(first, second) || within(second, first);
function privateOwner(info: Stats): void {
  if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) unavailable();
}
const sameObject = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
function regularFile(info: Stats): void {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > externalAccessMaxBytes) unavailable();
  privateOwner(info);
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== keys.length || keys.some(key => !Object.hasOwn(result, key))) unavailable();
  return result;
}
function configuration(bytes: Buffer | null): ExternalAccessConfiguration {
  if (bytes === null) return { version: 1, enabled: false };
  const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, ['version', 'enabled']);
  if (value['version'] !== 1 || typeof value['enabled'] !== 'boolean') return unavailable();
  return { version: 1, enabled: value['enabled'] };
}
function credential(bytes: Buffer | null, id: string): ExternalSenderCredential | null {
  if (bytes === null) return null;
  const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown, ['version', 'id', 'token']);
  if (value['version'] !== 1 || value['id'] !== id || (value['token'] !== null && !validToken(value['token']))) return unavailable();
  return { version: 1, id, token: value['token'] };
}
interface ReadFile { bytes: Buffer | null; revision: string }
interface Snapshot {
  access: ReadFile;
  configuration: ExternalAccessConfiguration;
  sender?: { file: ReadFile; credential: ExternalSenderCredential | null };
}

/** Local single-user credentials, not a sandbox or model-action approval gate.
 * Every authentication reads disk again; no watchers, restarts or extra Wake. */
export class ExternalAccessStore {
  readonly miraHome: string;
  readonly sourceDirectory: string;
  readonly externalDirectory: string;
  readonly accessFile: string;
  readonly #excluded: string[];
  constructor(options: ExternalAccessStoreOptions) {
    const excluded = [options.sourceDirectory, options.memoryRoot ?? path.join(options.miraHome, 'memory'),
      options.artifactsDirectory ?? path.join(options.miraHome, 'extension-artifacts')];
    if (!path.isAbsolute(options.miraHome) || excluded.some(directory => !path.isAbsolute(directory))) unavailable();
    this.miraHome = path.resolve(options.miraHome);
    this.sourceDirectory = path.resolve(options.sourceDirectory);
    this.externalDirectory = path.join(this.miraHome, 'external');
    this.accessFile = path.join(this.externalDirectory, 'access.json');
    this.#excluded = excluded.map(directory => path.resolve(directory));
    if (this.miraHome === path.parse(this.miraHome).root || this.#excluded.some(directory => overlap(directory, this.externalDirectory))) unavailable();
  }
  private senderFile(id: string): string {
    // Portable even for colon-containing identities, case-insensitive filesystems,
    // reserved device names, or IDs ending in dots. The file also binds its ID.
    return path.join(this.externalDirectory, 'senders', `${digest(id)}.json`);
  }
  private async forbiddenDirectories(): Promise<string[]> {
    const result: string[] = [];
    for (const directory of this.#excluded) {
      let current = directory;
      const tail: string[] = [];
      while (true) {
        try { result.push(path.join(await realpath(current), ...tail.reverse())); break; }
        catch (error) {
          if (!errno(error, 'ENOENT') || current === path.parse(current).root) throw error;
          tail.push(path.basename(current)); current = path.dirname(current);
        }
      }
    }
    return result;
  }
  /** Validate ancestors before creating anything. No credential path may contain
   * a symlink or overlap source, Memory, or extension artifacts in either direction. */
  private async directory(directory: string, create: boolean): Promise<boolean> {
    const forbidden = await this.forbiddenDirectories();
    if (forbidden.some(root => overlap(root, this.externalDirectory))) unavailable();
    let current = path.parse(directory).root;
    for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let info: Stats;
      try { info = await lstat(current); }
      catch (error) {
        if (!errno(error, 'ENOENT')) throw error;
        if (!create) return false;
        try { await mkdir(current, { mode: 0o700 }); await this.syncDirectory(path.dirname(current)); }
        catch (error) { if (!errno(error, 'EEXIST')) throw error; }
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) unavailable();
      if (within(this.miraHome, current)) privateOwner(info);
      if (forbidden.some(root => within(root, current))) unavailable();
    }
    const canonical = await realpath(directory);
    if (canonical !== directory || forbidden.some(root => overlap(root, this.externalDirectory))) unavailable();
    return true;
  }
  private async read(file: string): Promise<ReadFile> {
    const parent = path.dirname(file);
    if (!await this.directory(parent, false)) return { bytes: null, revision: missingRevision };
    const parentBefore = await lstat(parent);
    let handle: FileHandle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (errno(error, 'ENOENT')) return { bytes: null, revision: missingRevision }; throw error; }
    try {
      const before = await handle.stat(); regularFile(before);
      const bytes = Buffer.alloc(externalAccessMaxBytes + 1); let length = 0;
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat(); regularFile(after);
      const current = await lstat(file); regularFile(current);
      if (length > externalAccessMaxBytes || before.size !== length || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || !sameObject(current, after) ||
          !sameObject(parentBefore, await lstat(parent)) || !await this.directory(parent, false)) unavailable();
      const result = bytes.subarray(0, length);
      // Include file identity and timestamps so even a same-content replacement
      // (for example disable/enable or repeated revoke) invalidates stale intent.
      return { bytes: result, revision: digest([after.dev, after.ino, after.ctimeMs, after.mtimeMs, digest(result)].join(':')) };
    } finally { await handle.close(); }
  }
  private async snapshot(id?: string): Promise<Snapshot> {
    const access = await this.read(this.accessFile);
    const result: Snapshot = { access, configuration: configuration(access.bytes) };
    if (id !== undefined) {
      const file = await this.read(this.senderFile(id));
      const stored = credential(file.bytes, id);
      if (stored?.token && [id, this.accessFile, this.senderFile(id)].some(value => value.includes(stored.token!))) unavailable();
      result.sender = { file, credential: stored };
    }
    return result;
  }
  private project(current: Snapshot, id?: string): ExternalAccessStatus {
    return { enabled: current.configuration.enabled, accessFile: this.accessFile,
      ...(id === undefined ? {} : { sender: { id, credentialFile: this.senderFile(id),
        state: current.sender?.credential === null ? 'missing' as const : current.sender?.credential?.token === null ? 'revoked' as const : 'active' as const } }),
    };
  }
  async status(senderId?: string): Promise<ExternalAccessStatus> {
    if (senderId !== undefined) identity(senderId);
    try { return this.project(await this.snapshot(senderId), senderId); } catch { return unavailable(); }
  }
  async authenticate(senderId: string, token: string): Promise<boolean> {
    try {
      const id = identity(senderId);
      if (!validToken(token)) return false;
      const current = await this.snapshot(id);
      const expected = current.sender?.credential?.token;
      return current.configuration.enabled && typeof expected === 'string' && timingSafeEqual(Buffer.from(expected), Buffer.from(token));
    } catch { return false; }
  }
  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async lock(): Promise<() => Promise<void>> {
    await this.directory(this.externalDirectory, true);
    const file = path.join(this.externalDirectory, '.access.lock');
    const deadline = Date.now() + 2_000;
    while (true) {
      let handle: FileHandle;
      try { handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) {
        if (!errno(error, 'EEXIST')) throw error;
        // Invalid locks are never followed, removed, repaired, or stolen.
        const existing = await lstat(file).catch(error => { if (errno(error, 'ENOENT')) return null; throw error; });
        if (existing) regularFile(existing);
        if (Date.now() >= deadline) return conflict();
        await delay(20); continue;
      }
      const owned = await handle.stat();
      try {
        await handle.writeFile(`${JSON.stringify({ version: 1, pid: process.pid, nonce: randomUUID() })}\n`);
        await handle.sync();
      } catch (error) {
        await handle.close();
        if (sameObject(owned, await lstat(file))) await unlink(file);
        throw error;
      }
      await handle.close();
      return async () => {
        const latest = await lstat(file); regularFile(latest);
        if (!sameObject(owned, latest)) unavailable();
        await unlink(file); await this.syncDirectory(this.externalDirectory);
      };
    }
  }
  private async update(file: string, value: ExternalAccessConfiguration | ExternalSenderCredential, expected: Snapshot, id?: string): Promise<void> {
    const parent = path.dirname(file);
    await this.directory(parent, true);
    const parentBefore = await lstat(parent);
    let temporary: string | undefined = path.join(parent, `.${path.basename(file)}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
      const latest = await this.snapshot(id);
      if (latest.access.revision !== expected.access.revision || latest.sender?.file.revision !== expected.sender?.file.revision) conflict();
      if (!sameObject(parentBefore, await lstat(parent)) || !await this.directory(parent, false)) unavailable();
      await rename(temporary, file); temporary = undefined;
      await this.syncDirectory(parent);
    } finally { if (temporary) await unlink(temporary).catch(() => undefined); }
  }
  private async mutate(operation: 'enable' | 'disable' | 'create' | 'rotate' | 'revoke', id?: string): Promise<ExternalAccessStatus> {
    if (id !== undefined) identity(id);
    let release: (() => Promise<void>) | undefined;
    try {
      // Capture intent before waiting for the cross-process lock. A writer that
      // started against an older credential cannot overwrite a later revocation.
      const expected = await this.snapshot(id);
      release = await this.lock();
      const current = await this.snapshot(id);
      if (current.access.revision !== expected.access.revision || current.sender?.file.revision !== expected.sender?.file.revision) conflict();
      if (id === undefined) {
        await this.update(this.accessFile, { version: 1, enabled: operation === 'enable' }, expected);
      } else {
        if (operation === 'create' ? current.sender?.credential !== null : current.sender?.credential === null) conflict();
        // rotate is an explicit reissue, including after a completed revoke.
        // create never revives a revoked identity. revoke is idempotent.
        await this.update(this.senderFile(id), { version: 1, id, token: operation === 'revoke' ? null : randomBytes(32).toString('base64url') }, expected, id);
      }
      return this.project(await this.snapshot(id), id);
    } catch (error) {
      if (error instanceof ExternalAccessError) throw error;
      return unavailable();
    } finally { if (release) { try { await release(); } catch { unavailable(); } } }
  }
  async setEnabled(enabled: boolean): Promise<ExternalAccessStatus> {
    if (typeof enabled !== 'boolean') return invalid();
    return this.mutate(enabled ? 'enable' : 'disable');
  }
  async create(senderId: string): Promise<ExternalAccessStatus> { return this.mutate('create', identity(senderId)); }
  async rotate(senderId: string): Promise<ExternalAccessStatus> { return this.mutate('rotate', identity(senderId)); }
  async revoke(senderId: string): Promise<ExternalAccessStatus> { return this.mutate('revoke', identity(senderId)); }
}
