import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

/** Private channel state, never extension config, History, Memory or API output. */
export class FeishuStoreError extends Error {
  readonly code: 'unavailable' | 'conflict' | 'busy';
  constructor(code: 'unavailable' | 'conflict' | 'busy' = 'unavailable') {
    super(code === 'busy' ? 'Feishu private state is busy; reconcile before retrying' : code === 'conflict' ? 'Feishu private state changed; reconcile before retrying' : 'Feishu private state is unavailable; inspect its protected local file');
    this.name = 'FeishuStoreError'; this.code = code;
  }
}
const maxBytes = 2_000_000;
const absent = 'absent';
const pending = new Map<string, Promise<unknown>>();
const applicationId = 0x4d465348;
const schema = 'CREATE TABLE ledger (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT, revision TEXT NOT NULL, legacy_revision TEXT NOT NULL) STRICT';
const digest = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const storeError = (error: unknown): FeishuStoreError => error instanceof FeishuStoreError ? error : new FeishuStoreError(
  error && typeof error === 'object' && 'errcode' in error && typeof error.errcode === 'number' && [5, 6].includes(error.errcode & 255) ? 'busy' : 'unavailable');
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
  async #read(): Promise<{ value: T | null; revision: string; serialized: string | null }> {
    if (!await this.#directory(false)) return { value: null, revision: absent, serialized: null };
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (missing(error)) return { value: null, revision: absent, serialized: null }; throw error; }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes || (before.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) fail();
      const buffer = Buffer.alloc(maxBytes + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length); if (!bytesRead) break; length += bytesRead; }
      const after = await handle.stat(); const current = await lstat(this.file);
      if (length > maxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || after.nlink !== 1 || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) fail();
      const bytes = buffer.subarray(0, length);
      const serialized = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return { value: JSON.parse(serialized) as T, revision: digest(bytes), serialized };
    } finally { await handle.close(); }
  }
  async #database(create: boolean): Promise<boolean> {
    if (!await this.#directory(create)) return false;
    const file = `${this.file}.sqlite`;
    if (create) {
      try { const handle = await open(file, 'wx', 0o600); await handle.close(); }
      catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')) throw error; }
    }
    let exists = false;
    for (const suffix of ['', '-journal', '-wal', '-shm']) {
      let info; try { info = await lstat(file + suffix); } catch (error) { if (missing(error)) continue; throw error; }
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8_000_000 || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail();
      if (!suffix) exists = true;
    }
    return exists;
  }
  #transaction(legacy: { value: T | null; revision: string; serialized: string | null }, update?: { value: string; revision: string }): { value: T | null; revision: string } {
    const db = new DatabaseSync(`${this.file}.sqlite`, { timeout: 100, allowExtension: false });
    try {
      if (db.prepare('PRAGMA journal_mode').get()!.journal_mode !== 'delete') fail();
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      const version = db.prepare('PRAGMA user_version').get()!.user_version;
      const app = db.prepare('PRAGMA application_id').get()!.application_id;
      const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (version === 0 && app === 0 && tables.length === 0) {
        if (!update) { db.exec('ROLLBACK'); return legacy; }
        db.exec(`${schema}; PRAGMA application_id=${applicationId}; PRAGMA user_version=1`);
        db.prepare('INSERT INTO ledger VALUES (1, ?, ?, ?)').run(legacy.serialized, legacy.revision, legacy.revision);
      } else if (version !== 1 || app !== applicationId || tables.length !== 1 || tables[0]!.name !== 'ledger' || tables[0]!.sql !== schema) fail();
      const row = db.prepare('SELECT value, revision, legacy_revision FROM ledger WHERE id=1').get();
      if (!row || row.legacy_revision !== legacy.revision || typeof row.revision !== 'string') throw new FeishuStoreError('conflict');
      const current = row.value;
      if (current !== null && (typeof current !== 'string' || Buffer.byteLength(current) > maxBytes || digest(current) !== row.revision)) fail();
      if (current === null && row.revision !== absent) fail();
      const value = current === null ? null : JSON.parse(current as string) as T;
      if (update) {
        if (row.revision !== this.#revision) throw new FeishuStoreError('conflict');
        const result = db.prepare('UPDATE ledger SET value=?, revision=? WHERE id=1 AND revision=?').run(update.value, update.revision, this.#revision!);
        if (result.changes !== 1) throw new FeishuStoreError('conflict');
      }
      db.exec('COMMIT');
      return { value, revision: row.revision };
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw storeError(error); }
    finally { db.close(); }
  }
  async load(): Promise<T | null> {
    try {
      const legacy = await this.#read();
      const snapshot = await this.#database(false) ? this.#transaction(legacy) : legacy;
      this.#revision = snapshot.revision; return snapshot.value;
    } catch (error) { throw storeError(error); }
  }
  async save(value: T): Promise<void> {
    const previous = pending.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      try {
        if (this.#revision === undefined) fail();
        const serialized = JSON.stringify(value); if (Buffer.byteLength(serialized) > maxBytes) fail();
        const legacy = await this.#read();
        await this.#database(true);
        const revision = digest(serialized);
        this.#transaction(legacy, { value: serialized, revision });
        const directory = await open(path.dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        this.#revision = revision;
      } catch (error) { throw storeError(error); }
    });
    pending.set(this.file, operation);
    try { await operation; } finally { if (pending.get(this.file) === operation) pending.delete(this.file); }
  }
}
