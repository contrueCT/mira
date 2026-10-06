import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuiltinCatalog } from './model-catalog.ts';
import { emptyModelConfiguration, parseModelConfiguration, type ModelConfiguration } from './model-config.ts';
import { createModelTransport, type ModelSelection } from './model-transport.ts';

export interface WebSettings {
  revision: string;
  configuration: ModelConfiguration;
  selection: ModelSelection | null;
}
type SettingsData = Omit<WebSettings, 'revision'>;
export const webSettingsMaxBytes = 2_000_000;
export class WebSettingsError extends Error {
  readonly code: 'invalid_settings' | 'settings_conflict' | 'settings_unavailable';
  constructor(code: WebSettingsError['code']) {
    super({ invalid_settings: 'Invalid model settings', settings_conflict: 'Settings changed; reload before saving', settings_unavailable: 'Model settings are unavailable; check the local configuration file' }[code]);
    this.name = 'WebSettingsError'; this.code = code;
  }
}
const invalid = (): never => { throw new WebSettingsError('invalid_settings'); };
const unavailable = (): never => { throw new WebSettingsError('settings_unavailable'); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).some(name => !names.includes(name)) || names.some(name => !Object.hasOwn(value, name))) invalid();
}
function name(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) return invalid();
  return value;
}
function parseSelection(value: unknown): ModelSelection | null {
  if (value === null) return null;
  const selection = object(value);
  if (selection['kind'] === 'builtin') {
    exact(selection, ['kind', 'provider', 'model']);
    return { kind: 'builtin', provider: name(selection['provider']), model: name(selection['model']) };
  }
  if (selection['kind'] === 'custom') {
    exact(selection, ['kind', 'connection', 'model']);
    return { kind: 'custom', connection: name(selection['connection']), model: name(selection['model']) };
  }
  return invalid();
}
function parseData(value: unknown): SettingsData {
  try {
    const data = object(value); exact(data, ['configuration', 'selection']);
    const configuration = parseModelConfiguration(data['configuration']);
    const selection = parseSelection(data['selection']);
    const catalog = createBuiltinCatalog();
    for (const id of Object.keys(configuration.builtinCredentials)) if (!catalog.getProvider(id)) invalid();
    // Pure transport setup validates provider support, limits and configured references.
    // The callback is deliberately incapable of resolving a credential.
    if (selection) createModelTransport(configuration, selection, { env: () => undefined });
    return { configuration, selection };
  } catch { return invalid(); }
}
/** Strict allowlist for API input and output. This never reads environment secrets. */
export function parseWebSettings(value: unknown): WebSettings {
  const settings = object(value); exact(settings, ['revision', 'configuration', 'selection']);
  if (typeof settings['revision'] !== 'string' || !/^[a-f0-9]{64}$/u.test(settings['revision'])) return invalid();
  return { revision: settings['revision'], ...parseData({ configuration: settings['configuration'], selection: settings['selection'] }) };
}
function revision(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
const missingRevision = revision('mira-web-settings:missing');
function within(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function errno(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }
// Serialize all stores for the same path in this process. The app's existing
// fenced writer owns cross-process service exclusion; outside edits are checked
// again immediately before rename, and are never silently accepted as our revision.
const pending = new Map<string, Promise<unknown>>();

export class WebSettingsStore {
  readonly file: string;
  readonly sourceDirectory: string;
  constructor(file: string, sourceDirectory = fileURLToPath(new URL('../../../', import.meta.url))) {
    if (!path.isAbsolute(file) || !path.isAbsolute(sourceDirectory)) unavailable();
    this.file = path.resolve(file); this.sourceDirectory = path.resolve(sourceDirectory);
    if (within(this.sourceDirectory, this.file) || this.file === path.parse(this.file).root) unavailable();
  }
  /** Inspect each ancestor before creating anything; never follow directory links. */
  private async directory(create: boolean): Promise<boolean> {
    const source = await realpath(this.sourceDirectory);
    const directory = path.dirname(this.file);
    let current = path.parse(directory).root;
    for (const component of directory.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (!errno(error, 'ENOENT')) throw error;
        if (!create) return false;
        try { await mkdir(current, { mode: 0o700 }); } catch (error) { if (!errno(error, 'EEXIST')) throw error; }
        info = await lstat(current);
      }
      if (!info.isDirectory() || info.isSymbolicLink()) unavailable();
      if (within(source, current)) unavailable();
    }
    if (within(source, await realpath(directory))) unavailable();
    return true;
  }
  private async read(): Promise<{ bytes: Buffer | null; revision: string }> {
    if (!await this.directory(false)) return { bytes: null, revision: missingRevision };
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (errno(error, 'ENOENT')) return { bytes: null, revision: missingRevision }; throw error; }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > webSettingsMaxBytes) unavailable();
      const buffer = Buffer.alloc(webSettingsMaxBytes + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const current = await lstat(this.file);
      if (length > webSettingsMaxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) unavailable();
      const bytes = buffer.subarray(0, length);
      return { bytes, revision: revision(bytes) };
    } finally { await handle.close(); }
  }
  async get(): Promise<WebSettings> {
    try {
      const current = await this.read();
      const data = current.bytes === null ? { configuration: emptyModelConfiguration(), selection: null } : parseData(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes)) as unknown);
      return { revision: current.revision, ...data };
    } catch { return unavailable(); }
  }
  async save(value: unknown): Promise<WebSettings> {
    const parsed = parseWebSettings(value);
    const bytes = Buffer.from(`${JSON.stringify({ configuration: parsed.configuration, selection: parsed.selection }, null, 2)}\n`);
    if (bytes.length > webSettingsMaxBytes) return invalid();
    const previous = pending.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      let temporary: string | undefined;
      try {
        const current = await this.read();
        if (current.revision !== parsed.revision) throw new WebSettingsError('settings_conflict');
        await this.directory(true);
        const parentBefore = await lstat(path.dirname(this.file));
        const candidate = path.join(path.dirname(this.file), `.${path.basename(this.file)}.${randomUUID()}.tmp`);
        const handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporary = candidate;
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        const latest = await this.read();
        const parentAfter = await lstat(path.dirname(this.file));
        if (latest.revision !== parsed.revision) throw new WebSettingsError('settings_conflict');
        if (parentBefore.dev !== parentAfter.dev || parentBefore.ino !== parentAfter.ino) unavailable();
        await rename(temporary, this.file); temporary = undefined;
        return { revision: revision(bytes), configuration: parsed.configuration, selection: parsed.selection };
      } catch (error) {
        if (error instanceof WebSettingsError) throw error;
        return unavailable();
      } finally { if (temporary) await unlink(temporary).catch(() => undefined); }
    });
    pending.set(this.file, operation);
    try { return await operation; }
    finally { if (pending.get(this.file) === operation) pending.delete(this.file); }
  }
}
