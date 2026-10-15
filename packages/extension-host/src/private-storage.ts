import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, readdir, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

export class CredentialConflictError extends Error { constructor() { super('Extension credentials changed'); } }
export const credentialRevision = (values: Record<string, string>): string => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const fail = (): never => { throw new Error('Extension private storage is unavailable'); };
export function credentialKey(key: string): void {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)) throw new Error('Invalid extension credential key');
}
/** Ordinary protected files under the trusted host OS account, not encryption or isolation. */
export class ExtensionPrivateStorage {
  private readonly queues = new Map<string, Promise<unknown>>();
  readonly root: string;
  private readonly excluded: string[];
  constructor(root: string, excluded: string[] = []) { if (!path.isAbsolute(root)) fail(); this.root = root; this.excluded = [...excluded]; }
  async validateLocation(): Promise<void> {
    const canonical = async (value: string): Promise<string> => {
      const suffix: string[] = []; let current = path.resolve(value);
      for (;;) { try { return path.join(await realpath(current), ...suffix); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const parent = path.dirname(current); if (parent === current) return fail(); suffix.unshift(path.basename(current)); current = parent;
      } }
    };
    const root = await canonical(this.root);
    const inside = (child: string, parent: string): boolean => { const relative = path.relative(parent, child); return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
    for (const excluded of this.excluded) { const other = await canonical(excluded); if (inside(root, other) || inside(other, root)) throw new Error('Extension private storage must be outside source, Memory and artifacts'); }
  }
  directory(owner: string): string { return path.join(this.root, createHash('sha256').update(owner).digest('hex')); }
  async prepare(owner: string): Promise<string> {
    await this.validateLocation();
    // Reject symlinks in every existing ancestor, including an alternative root.
    let current = path.parse(this.root).root;
    for (const part of this.root.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try { const info = await lstat(current); if (!info.isDirectory() || info.isSymbolicLink()) fail(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; await mkdir(current, { mode: 0o700 }); }
    }
    const rootInfo = await lstat(this.root);
    if (process.platform !== 'win32' && (rootInfo.mode & 0o077) !== 0) fail();
    const directory = this.directory(owner);
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail();
    return directory;
  }
  private async read(owner: string): Promise<Record<string, string>> {
    const directory = await this.prepare(owner);
    let handle;
    try { handle = await open(path.join(directory, 'credentials.json'), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; return fail(); }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 262_144 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) fail();
      const data: unknown = JSON.parse(await handle.readFile('utf8'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) fail();
      for (const [key, value] of Object.entries(data as Record<string, unknown>)) { credentialKey(key); if (typeof value !== 'string' || value.length > 16_384) fail(); }
      return data as Record<string, string>;
    } catch { return fail(); } finally { await handle.close(); }
  }
  private serial<T>(owner: string, run: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(owner) ?? Promise.resolve()).then(run, run);
    this.queues.set(owner, task.catch(() => {}));
    return task;
  }
  async values(owner: string): Promise<Record<string, string>> { return this.serial(owner, () => this.read(owner)); }
  async update(owner: string, updates: Record<string, string | null>, assertActive: () => void, expectedRevision?: string): Promise<void> {
    for (const [key, value] of Object.entries(updates)) { credentialKey(key); if (value !== null && (typeof value !== 'string' || !value.length || value.length > 16_384 || value.includes('\0'))) throw new Error('Invalid extension credential value'); }
    return this.serial(owner, async () => {
      assertActive();
      const data = await this.read(owner);
      if (expectedRevision !== undefined && credentialRevision(data) !== expectedRevision) throw new CredentialConflictError();
      for (const [key, value] of Object.entries(updates)) { if (value === null) delete data[key]; else Object.defineProperty(data, key, { value, enumerable: true, configurable: true, writable: true }); }
      const serialized = JSON.stringify(data);
      if (Buffer.byteLength(serialized, 'utf8') > 262_144) throw new Error('Extension credential storage limit exceeded');
      const directory = this.directory(owner), temporary = path.join(directory, `.credentials-${randomUUID()}.tmp`);
      try {
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
        assertActive();
        await rename(temporary, path.join(directory, 'credentials.json'));
      } finally { await rm(temporary, { force: true }); }
    });
  }
  /** Explicit uninstall only. Plugin state remains separate from credential deletion. */
  async removeCredentials(owner: string): Promise<void> { await this.serial(owner, async () => { await this.prepare(owner); const directory = this.directory(owner);
      for (const name of await readdir(directory)) if (name === 'credentials.json' || /^\.credentials-[0-9a-f-]{36}\.tmp$/.test(name)) await rm(path.join(directory, name), { force: true }); }); }
}
