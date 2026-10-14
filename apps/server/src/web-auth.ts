import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import path from 'node:path';

const sessionLifetime = 12 * 60 * 60 * 1_000;
const cookieName = 'mira_web_session';
interface Stored { version: 1; revision: string; enabled: boolean; salt: string | null; hash: string | null }
export interface WebAuthStatus { enabled: boolean; authenticated: boolean }
export interface WebAuthWrite { revision: string; enabled: boolean; currentPassword?: string; password?: string }
export class WebAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = 'WebAuthError'; this.status = status; }
}
const unavailable = (): never => { throw new WebAuthError(503, 'Web access settings are unavailable; check the protected local file'); };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, Buffer.from(salt, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
}
function validPassword(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && Array.from(value).length >= 12 && Array.from(value).length <= 256 && Buffer.byteLength(value) <= 1024;
}
function token(cookie: string | undefined): string | undefined {
  const values = (cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`));
  if (values.length !== 1) return undefined;
  const value = values[0]!.slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
function parse(value: unknown): Stored {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unavailable();
  const data = value as Stored;
  if (Object.keys(data).sort().join(',') !== 'enabled,hash,revision,salt,version' || data.version !== 1 || typeof data.enabled !== 'boolean'
    || typeof data.revision !== 'string' || !/^[a-f0-9-]{36}$/.test(data.revision)
    || (data.enabled ? typeof data.salt !== 'string' || !/^[a-f0-9]{64}$/.test(data.salt) || typeof data.hash !== 'string' || !/^[a-f0-9]{128}$/.test(data.hash) : data.hash !== null || data.salt !== null)) return unavailable();
  return data;
}
/** One server process owns this file. No passwords or session tokens are persisted. */
export class WebAccessAuth {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, { start: number; count: number }>();
  private globalAttempts = { start: 0, count: 0 };
  private checking = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly file: string;
  private data: Stored;
  private constructor(file: string, data: Stored) { this.file = file; this.data = data; }
  static async open(options: { miraHome: string; sourceDirectory: string }): Promise<WebAccessAuth> {
    try {
      const home = path.resolve(options.miraHome); const source = await realpath(options.sourceDirectory);
      if (await realpath(home) !== home) return unavailable();
      const relative = path.relative(source, home);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) return unavailable();
      const info = await lstat(home);
      if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) return unavailable();
      const file = path.join(home, 'web-access.json');
      let data: Stored;
      try {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2048 || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) return unavailable();
          const buffer = Buffer.alloc(2049); const { bytesRead } = await handle.read(buffer);
          if (bytesRead > 2048) return unavailable();
          data = parse(JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')));
        } finally { await handle.close(); }
      } catch (error) {
        if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
        data = { version: 1, revision: randomUUID(), enabled: false, salt: null, hash: null };
      }
      return new WebAccessAuth(file, data);
    } catch { return unavailable(); }
  }
  status(cookie?: string): WebAuthStatus {
    const now = Date.now();
    for (const [id, expiry] of this.sessions) if (expiry <= now) this.sessions.delete(id);
    const value = token(cookie);
    return { enabled: this.data.enabled, authenticated: !this.data.enabled || (value !== undefined && this.sessions.has(digest(value))) };
  }
  settings(): { enabled: boolean; revision: string } { return { enabled: this.data.enabled, revision: this.data.revision }; }
  private async verify(password: unknown, address: string): Promise<void> {
    const now = Date.now();
    for (const [key, value] of this.attempts) if (now - value.start >= 60_000) this.attempts.delete(key);
    if (now - this.globalAttempts.start >= 60_000) this.globalAttempts = { start: now, count: 0 };
    const entry = this.attempts.get(address) ?? { start: now, count: 0 };
    if (entry.count >= 5 || this.globalAttempts.count >= 30 || this.checking >= 2) throw new WebAuthError(429, 'Too many password attempts; retry in one minute');
    entry.count++; this.globalAttempts.count++; this.attempts.set(address, entry); this.checking++;
    const current = this.data;
    try {
      if (!validPassword(password) || !current.hash || !current.salt) throw new WebAuthError(401, 'Incorrect password');
      const actual = await derive(password, current.salt);
      if (current !== this.data || !timingSafeEqual(actual, Buffer.from(current.hash, 'hex'))) throw new WebAuthError(401, 'Incorrect password');
    } finally { this.checking--; }
  }
  private issue(secure: boolean): string {
    const value = randomBytes(32).toString('base64url');
    while (this.sessions.size >= 256) this.sessions.delete(this.sessions.keys().next().value!);
    this.sessions.set(digest(value), Date.now() + sessionLifetime);
    return `${cookieName}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secure ? '; Secure' : ''}`;
  }
  async login(password: unknown, address: string, secure: boolean): Promise<string> {
    if (!this.data.enabled) throw new WebAuthError(409, 'Password access is disabled');
    await this.verify(password, address);
    return this.issue(secure);
  }
  logout(cookie: string | undefined, secure: boolean): string {
    const value = token(cookie); if (value) this.sessions.delete(digest(value));
    return `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;
  }
  async save(input: WebAuthWrite, cookie: string | undefined, address: string, secure: boolean): Promise<string> {
    const operation = this.pending.catch(() => undefined).then(async () => {
      if (!this.status(cookie).authenticated) throw new WebAuthError(401, 'Please sign in');
      if (input.revision !== this.data.revision) throw new WebAuthError(409, 'Access settings changed; reload before saving');
      if (this.data.enabled) {
        try { await this.verify(input.currentPassword, address); }
        catch (error) { if (error instanceof WebAuthError && error.status === 401) throw new WebAuthError(403, 'Incorrect current password'); throw error; }
      }
      if (input.enabled && !validPassword(input.password)) throw new WebAuthError(400, 'Choose a password with 12 to 256 characters');
      if (!input.enabled && input.password !== undefined) throw new WebAuthError(400, 'Do not send a new password when disabling access');
      const salt = input.enabled ? randomBytes(32).toString('hex') : null;
      const data: Stored = { version: 1, revision: randomUUID(), enabled: input.enabled, salt,
        hash: salt === null ? null : (await derive(input.password!, salt)).toString('hex') };
      const temporary = path.join(path.dirname(this.file), `.web-access.${randomUUID()}.tmp`);
      try {
        const directory = await lstat(path.dirname(this.file));
        if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o077) !== 0) return unavailable();
        const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(`${JSON.stringify(data)}\n`); await handle.sync(); } finally { await handle.close(); }
        await rename(temporary, this.file);
        // Publish revocation immediately after rename, including a later fsync failure.
        this.data = data; this.sessions.clear();
        const dir = await open(path.dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await dir.sync(); } finally { await dir.close(); }
      } catch { return unavailable(); }
      finally { await unlink(temporary).catch(() => undefined); }
      return data.enabled ? this.issue(secure) : this.logout(cookie, secure);
    });
    this.pending = operation;
    return operation;
  }
}
