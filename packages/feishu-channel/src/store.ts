import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** Private channel state, never extension config, History, Memory or API output. */
export class FeishuStoreError extends Error {
  constructor() { super('Feishu private state is unavailable; inspect its protected local file'); this.name = 'FeishuStoreError'; }
}
const maxBytes = 2_000_000;
const absent = 'absent';
const pending = new Map<string, Promise<unknown>>();
const within = (parent: string, child: string) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const missing = (error: unknown) => !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const fail = (): never => { throw new FeishuStoreError(); };
export class FeishuPrivateStore<T> {
  readonly file: string;
  readonly #forbidden: string[];
  #revision: string | undefined;
  constructor(file: string, sourceDirectory: string, excludedDirectories: string[] = []) {
    if (![file, sourceDirectory, ...excludedDirectories].every(path.isAbsolute)) fail();
    this.file = path.resolve(file); this.#forbidden = [sourceDirectory, ...excludedDirectories].map(directory => path.resolve(directory));
    if (this.#forbidden.some(root => within(root, this.file))) fail();
  }
  async #directory(create: boolean): Promise<boolean> {
    const roots: string[] = [];
    for (const root of this.#forbidden) { try { roots.push(await realpath(root)); } catch (error) { if (!missing(error)) throw error; } }
    if (roots.some(root => within(root, this.file))) fail();
    const directory = path.dirname(this.file); let current = path.parse(directory).root;
    for (const segment of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment); let info;
      try { info = await lstat(current); } catch (error) {
        if (!missing(error)) throw error;
        if (!create) return false;
        try { await mkdir(current, { mode: 0o700 }); } catch (cause) { if (!(cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST')) throw cause; }
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink() || roots.some(root => within(root, current))) fail();
    }
    const info = await lstat(directory);
    if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail();
    return true;
  }
  async #read(): Promise<{ value: T | null; revision: string }> {
    if (!await this.#directory(false)) return { value: null, revision: absent };
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (missing(error)) return { value: null, revision: absent }; throw error; }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || (before.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) fail();
      const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat(); const current = await lstat(this.file);
      if (length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || after.nlink !== 1 || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) fail();
      const bytes = buffer.subarray(0, length);
      return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T, revision: createHash('sha256').update(bytes).digest('hex') };
    } finally { await handle.close(); }
  }
  async load(): Promise<T | null> {
    try { const snapshot = await this.#read(); this.#revision = snapshot.revision; return snapshot.value; } catch { return fail(); }
  }
  async save(value: T): Promise<void> {
    const previous = pending.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      let temporary: string | undefined;
      try {
        if (this.#revision === undefined) fail();
        const bytes = Buffer.from(JSON.stringify(value)); if (bytes.length > maxBytes) fail();
        await this.#directory(true);
        if ((await this.#read()).revision !== this.#revision) fail();
        temporary = path.join(path.dirname(this.file), `.feishu.${randomUUID()}.tmp`);
        const handle = await open(temporary, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        if ((await this.#read()).revision !== this.#revision) fail();
        await rename(temporary, this.file);
        const directory = await open(path.dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        this.#revision = createHash('sha256').update(bytes).digest('hex');
      } catch { fail(); } finally { if (temporary) await rm(temporary, { force: true }); }
    });
    pending.set(this.file, operation);
    try { await operation; } finally { if (pending.get(this.file) === operation) pending.delete(this.file); }
  }
}
