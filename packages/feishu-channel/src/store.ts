import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
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
const legacySchema = 'CREATE TABLE ledger (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT, revision TEXT NOT NULL, legacy_revision TEXT NOT NULL) STRICT';
const schema = 'CREATE TABLE ledger (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT, revision TEXT NOT NULL, legacy_revision TEXT NOT NULL, value_digest TEXT NOT NULL) STRICT';
const receiptsSchema = 'CREATE TABLE receipts (call_id TEXT PRIMARY KEY, value TEXT NOT NULL, revision TEXT NOT NULL, binding_id TEXT NOT NULL, pending INTEGER NOT NULL CHECK(pending IN (0,1))) STRICT';
const pendingSchema = 'CREATE INDEX pending_receipts ON receipts(binding_id, pending, call_id)';
type ReceiptWrite = { value: unknown; pending: boolean; bindingId: string };
type Update<T> = { value: T; receipts?: Record<string, ReceiptWrite> } | { callId: string; receipt: ReceiptWrite };

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
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail();
      if (!suffix) exists = true;
    }
    return exists;
  }
  #transaction(legacy: { value: T | null; revision: string; serialized: string | null }, operation?: { update?: Update<T>; callId?: string; after?: string; bindingId?: string }): { value: T | null; revision: string; receipt?: unknown; callId?: string } {
    const db = new DatabaseSync(`${this.file}.sqlite`, { timeout: 100, allowExtension: false });
    try {
      if (db.prepare('PRAGMA journal_mode').get()!.journal_mode !== 'delete') fail();
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
      let version = db.prepare('PRAGMA user_version').get()!.user_version;
      const app = db.prepare('PRAGMA application_id').get()!.application_id;
      const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
      const update = operation?.update;
      if (version === 0 && app === 0 && tables.length === 0) {
        if (!update) { db.exec('ROLLBACK'); return legacy; }
        db.exec(`${legacySchema}; PRAGMA application_id=${applicationId}; PRAGMA user_version=1`);
        db.prepare('INSERT INTO ledger VALUES (1, ?, ?, ?)').run(legacy.serialized, legacy.revision, legacy.revision); version = 1;
      } else if (app !== applicationId || (version === 1
        ? tables.length !== 1 || tables[0]!.name !== 'ledger' || tables[0]!.sql !== legacySchema
        : version !== 2 || tables.length !== 3 || tables.some((item, index) => item.sql !== [schema, pendingSchema, receiptsSchema][index]))) fail();
      const row = db.prepare('SELECT * FROM ledger WHERE id=1').get();
      if (!row || row.legacy_revision !== legacy.revision || typeof row.revision !== 'string') throw new FeishuStoreError('conflict');
      const current: string | null = row.value === null ? null : typeof row.value === 'string' ? row.value : fail();
      const expectedDigest: string = version === 1 ? row.revision : typeof row.value_digest === 'string' ? row.value_digest : fail();
      if (current !== null && (typeof current !== 'string' || Buffer.byteLength(current) > maxBytes || digest(current) !== expectedDigest)) fail();
      if (current === null && expectedDigest !== absent) fail();
      const value = current === null ? null : JSON.parse(current as string) as T;
      if (operation && row.revision !== this.#revision) throw new FeishuStoreError('conflict');
      let revision = row.revision;
      if (update) {
        if (version === 1) {
          db.exec(`ALTER TABLE ledger RENAME TO previous_ledger; ${schema}; ${receiptsSchema}; ${pendingSchema}`);
          db.prepare('INSERT INTO ledger VALUES (1, ?, ?, ?, ?)').run(current, revision, legacy.revision, expectedDigest);
          db.exec('DROP TABLE previous_ledger; PRAGMA user_version=2'); version = 2;
        }
        const writes = 'callId' in update ? { [update.callId]: update.receipt } : update.receipts ?? {};
        for (const [callId, receipt] of Object.entries(writes)) {
          if (!callId || callId.length > 512 || /[\u0000-\u001f\u007f]/u.test(callId)) fail();
          if (!receipt.bindingId || receipt.bindingId.length > 512) fail();
          const serialized = JSON.stringify(receipt.value); if (Buffer.byteLength(serialized) > maxBytes) fail();
          db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?) ON CONFLICT(call_id) DO UPDATE SET value=excluded.value, revision=excluded.revision, pending=excluded.pending')
            .run(callId, serialized, digest(serialized), receipt.bindingId, receipt.pending ? 1 : 0);
        }
        const serialized = 'value' in update ? JSON.stringify(update.value) : current;
        if (serialized !== null && Buffer.byteLength(serialized) > maxBytes) fail();
        revision = randomUUID();
        const result = db.prepare('UPDATE ledger SET value=?, revision=?, value_digest=? WHERE id=1 AND revision=?')
          .run(serialized, revision, serialized === null ? absent : digest(serialized), this.#revision!);
        if (result.changes !== 1) throw new FeishuStoreError('conflict');
      }
      let receipt: unknown, callId: string | undefined;
      if (version === 2 && operation && !update) {
        const record = operation.callId !== undefined ? db.prepare('SELECT call_id, value, revision FROM receipts WHERE call_id=?').get(operation.callId)
          : db.prepare('SELECT call_id, value, revision FROM receipts WHERE binding_id=? AND pending=1 AND call_id>? ORDER BY call_id LIMIT 1').get(operation.bindingId!, operation.after ?? '');
        if (record) {
          if (typeof record.value !== 'string' || Buffer.byteLength(record.value) > maxBytes || digest(record.value) !== record.revision || typeof record.call_id !== 'string') fail();
          receipt = JSON.parse(record.value as string); callId = record.call_id as string;
        }
      }
      db.exec('COMMIT');
      return { value, revision, ...(callId === undefined ? {} : { receipt, callId }) };
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
  async loadReceipt<R>(callId: string): Promise<R | null> { return (await this.#receipt({ callId })).receipt as R ?? null; }
  async nextPendingReceipt<R>(bindingId: string, after = ''): Promise<{ callId: string; receipt: R } | null> {
    const result = await this.#receipt({ after, bindingId });
    return result.callId === undefined ? null : { callId: result.callId, receipt: result.receipt as R };
  }
  async #receipt(query: { callId: string } | { after: string; bindingId: string }): Promise<{ receipt?: unknown; callId?: string }> {
    try {
      if (this.#revision === undefined) fail();
      const legacy = await this.#read();
      return await this.#database(false) ? this.#transaction(legacy, query) : {};
    } catch (error) { throw storeError(error); }
  }
  async save(value: T, receipts?: Record<string, ReceiptWrite>): Promise<void> { await this.#write({ value, ...(receipts ? { receipts } : {}) }); }
  async saveReceipt(callId: string, value: unknown, pending: boolean, bindingId: string): Promise<void> { await this.#write({ callId, receipt: { value, pending, bindingId } }); }
  async #write(update: Update<T>): Promise<void> {
    const previous = pending.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      try {
        if (this.#revision === undefined) fail();
        const legacy = await this.#read(); await this.#database(true);
        const { revision } = this.#transaction(legacy, { update });
        const directory = await open(path.dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        this.#revision = revision;
      } catch (error) { throw storeError(error); }
    });
    pending.set(this.file, operation);
    try { await operation; } finally { if (pending.get(this.file) === operation) pending.delete(this.file); }
  }
}
