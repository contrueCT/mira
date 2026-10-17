import { probeReasoningFormat, type ModelProbeResult } from './model-probe.ts';
import { constants } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBuiltinCatalog, builtinApiKeySupport } from './model-catalog.ts';
import { validateBaseUrl } from './model-config.ts';
import { createModelTransport, type ModelSelection, type ModelTransport, type ModelTransportOptions } from './model-transport.ts';
import { discoverModels, type ModelDiscoveryOptions, type ModelDiscoveryResult } from './model-discovery.ts';
import { parseWebConnectionWrite, parseWebModelConfiguration, parseWebModelConfigurationWrite, validWebApiKey, webConnectionMetadata, webTransportConfiguration,
  type WebCustomConnectionWrite, type WebModelConfiguration, type WebModelConfigurationWrite } from './web-model-config.ts';

export interface WebSettings {
  revision: string;
  configuration: WebModelConfiguration;
  selection: ModelSelection | null;
}
export interface WebSettingsWrite {
  revision: string;
  configuration: WebModelConfigurationWrite;
  selection: ModelSelection | null;
}
interface StoredCredential { apiKey: string | null; binding: string }
interface StoredData {
  version: 1;
  nonce: string;
  configuration: {
    defaultThinkingLevel?: WebModelConfiguration['defaultThinkingLevel'];
    builtinCredentials: Record<string, StoredCredential>;
    customConnections: Array<Omit<WebCustomConnectionWrite, 'hasApiKey' | 'apiKey'> & { apiKey: string | null }>;
  };
  selection: ModelSelection | null;
}
export const webSettingsMaxBytes = 2_000_000;
export class WebSettingsError extends Error {
  readonly code: 'invalid_settings' | 'settings_conflict' | 'settings_unavailable';
  constructor(code: WebSettingsError['code']) {
    super({ invalid_settings: 'Invalid model settings', settings_conflict: 'Settings changed; reload before saving', settings_unavailable: 'Model settings are unavailable; check the protected local configuration file' }[code]);
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
function parseSettings(value: unknown, write: boolean): WebSettingsWrite {
  try {
    const settings = object(value); exact(settings, ['revision', 'configuration', 'selection']);
    if (typeof settings['revision'] !== 'string' || !/^[a-f0-9]{64}$/u.test(settings['revision'])) invalid();
    const configuration = write ? parseWebModelConfigurationWrite(settings['configuration']) : parseWebModelConfiguration(settings['configuration']);
    const selection = parseSelection(settings['selection']);
    // Pure transport setup validates model/protocol support, never resolves keys.
    if (selection) createModelTransport(webTransportConfiguration(configuration), selection, { env: () => undefined });
    return { revision: settings['revision'] as string, configuration, selection };
  } catch { return invalid(); }
}
/** Response allowlist: write-only values cannot pass this parser. */
export function parseWebSettings(value: unknown): WebSettings { return parseSettings(value, false) as WebSettings; }
export function parseWebSettingsWrite(value: unknown): WebSettingsWrite { return parseSettings(value, true); }
export function hasSelectedWebApiKey(settings: WebSettings): boolean {
  const selected = settings.selection;
  if (!selected) return false;
  return selected.kind === 'builtin' ? settings.configuration.builtinCredentials[selected.provider]?.hasApiKey === true
    : settings.configuration.customConnections.find(item => item.id === selected.connection)?.hasApiKey === true;
}
function builtinBinding(provider: string): string {
  const entry = createBuiltinCatalog().getProvider(provider);
  if (!entry) return invalid();
  const endpoints = [...new Set(entry.getModels().map(model => JSON.stringify([validateBaseUrl(model.baseUrl), model.api])))].sort();
  return revision(JSON.stringify([provider, endpoints]));
}
function sameConnection(left: WebCustomConnectionWrite, right: WebCustomConnectionWrite): boolean {
  return left.id === right.id && left.baseUrl === right.baseUrl && left.api === right.api && left.modelsUrl === right.modelsUrl;
}
function allKeys(data: StoredData): string[] {
  return [...Object.values(data.configuration.builtinCredentials), ...data.configuration.customConnections].flatMap(entry => entry.apiKey === null ? [] : [entry.apiKey]);
}
function rejectSecretMetadata(value: unknown, keys: string[]): void {
  if (typeof value === 'string') {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch { /* Raw string is still checked. */ }
    if (keys.some(key => value.includes(key) || decoded.includes(key))) invalid();
  } else if (Array.isArray(value)) { for (const item of value) rejectSecretMetadata(item, keys); }
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { rejectSecretMetadata(key, keys); rejectSecretMetadata(item, keys); }
}
function project(data: StoredData, currentRevision: string): WebSettings {
  const configuration: WebModelConfiguration = {
    ...(data.configuration.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: data.configuration.defaultThinkingLevel }),
    builtinCredentials: Object.fromEntries(Object.entries(data.configuration.builtinCredentials).map(([provider, entry]) => [provider, { hasApiKey: entry.apiKey !== null && entry.binding === builtinBinding(provider) }])),
    customConnections: data.configuration.customConnections.map(connection => ({ ...webConnectionMetadata(connection), hasApiKey: connection.apiKey !== null })),
  };
  const result = { revision: currentRevision, configuration, selection: data.selection === null ? null : structuredClone(data.selection) };
  rejectSecretMetadata(result, allKeys(data));
  return result;
}
function emptyStored(): StoredData { return { version: 1, nonce: randomUUID(), configuration: { builtinCredentials: {}, customConnections: [] }, selection: null }; }
function parseStored(value: unknown): StoredData {
  const root = object(value); exact(root, ['version', 'nonce', 'configuration', 'selection']);
  if (root['version'] !== 1 || typeof root['nonce'] !== 'string' || !/^[a-f0-9-]{36}$/u.test(root['nonce'])) invalid();
  const config = object(root['configuration']); exact(config, ['builtinCredentials', 'customConnections', ...(Object.hasOwn(config, 'defaultThinkingLevel') ? ['defaultThinkingLevel'] : [])]);
  const credentials = object(config['builtinCredentials']);
  const input: WebModelConfigurationWrite['builtinCredentials'] = Object.create(null) as WebModelConfigurationWrite['builtinCredentials'];
  const bindings = new Map<string, string>();
  for (const [provider, value] of Object.entries(credentials)) {
    const entry = object(value); exact(entry, ['apiKey', 'binding']);
    if (typeof entry['binding'] !== 'string' || !/^[a-f0-9]{64}$/u.test(entry['binding'])) invalid();
    input[provider] = { apiKey: entry['apiKey'] as string | null }; bindings.set(provider, entry['binding'] as string);
  }
  if (!Array.isArray(config['customConnections'])) invalid();
  for (const value of config['customConnections'] as unknown[]) {
    const connection = object(value);
    if (!Object.hasOwn(connection, 'apiKey') || Object.hasOwn(connection, 'hasApiKey')) invalid();
  }
  const parsed = parseWebSettingsWrite({ revision: missingRevision, configuration: { builtinCredentials: input, customConnections: config['customConnections'], ...(Object.hasOwn(config, 'defaultThinkingLevel') ? { defaultThinkingLevel: config['defaultThinkingLevel'] } : {}) }, selection: root['selection'] });
  const builtinCredentials = Object.fromEntries(Object.entries(parsed.configuration.builtinCredentials).map(([provider, entry]) => {
    if (entry.apiKey && !builtinApiKeySupport(createBuiltinCatalog().getProvider(provider)!).supported) invalid();
    return [provider, { apiKey: entry.apiKey ?? null, binding: bindings.get(provider)! }];
  }));
  const data: StoredData = { version: 1, nonce: root['nonce'] as string, configuration: { ...(parsed.configuration.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: parsed.configuration.defaultThinkingLevel }), builtinCredentials,
    customConnections: parsed.configuration.customConnections.map(connection => ({ ...webConnectionMetadata(connection), apiKey: connection.apiKey ?? null })) }, selection: parsed.selection };
  project(data, missingRevision);
  return data;
}
function mergeStored(previous: StoredData, input: WebSettingsWrite): StoredData {
  const builtinCredentials = Object.fromEntries(Object.entries(input.configuration.builtinCredentials).map(([provider, update]) => {
    const binding = builtinBinding(provider); const old = previous.configuration.builtinCredentials[provider];
    const apiKey = update.apiKey === undefined ? (old?.binding === binding ? old.apiKey : null) : update.apiKey;
    if (apiKey && !builtinApiKeySupport(createBuiltinCatalog().getProvider(provider)!).supported) invalid();
    return [provider, { apiKey, binding }];
  }));
  const customConnections = input.configuration.customConnections.map(update => {
    const old = previous.configuration.customConnections.find(connection => sameConnection(connection, update));
    return { ...webConnectionMetadata(update), apiKey: update.apiKey === undefined ? old?.apiKey ?? null : update.apiKey };
  });
  const data: StoredData = { version: 1, nonce: randomUUID(), configuration: { ...(input.configuration.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: input.configuration.defaultThinkingLevel }), builtinCredentials, customConnections }, selection: input.selection };
  rejectSecretMetadata(project(data, missingRevision), allKeys(previous));
  return data;
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
  readonly #excludedDirectories: string[];
  constructor(file: string, sourceDirectory = fileURLToPath(new URL('../../../', import.meta.url)), excludedDirectories: string[] = []) {
    if (!path.isAbsolute(file) || !path.isAbsolute(sourceDirectory)) unavailable();
    this.file = path.resolve(file); this.sourceDirectory = path.resolve(sourceDirectory);
    if (excludedDirectories.some(directory => !path.isAbsolute(directory))) unavailable();
    this.#excludedDirectories = excludedDirectories.map(directory => path.resolve(directory));
    if (this.#excludedDirectories.some(directory => within(directory, this.file))) unavailable();
    if (within(this.sourceDirectory, this.file) || this.file === path.parse(this.file).root) unavailable();
  }
  /** Inspect each ancestor before creating anything; never follow directory links. */
  private async directory(create: boolean): Promise<boolean> {
    const source = await realpath(this.sourceDirectory);
    const forbidden = [source];
    for (const directory of this.#excludedDirectories) {
      try { forbidden.push(await realpath(directory)); } catch (error) { if (!errno(error, 'ENOENT')) throw error; }
    }
    const directory = path.dirname(this.file);
    if (forbidden.some(root => within(root, this.file))) unavailable();
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
    const info = await lstat(directory);
    if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) unavailable();
    return true;
  }
  private async read(): Promise<{ bytes: Buffer | null; revision: string }> {
    if (!await this.directory(false)) return { bytes: null, revision: missingRevision };
    let handle;
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (errno(error, 'ENOENT')) return { bytes: null, revision: missingRevision }; throw error; }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size > webSettingsMaxBytes || (before.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && before.uid !== process.getuid())) unavailable();
      const buffer = Buffer.alloc(webSettingsMaxBytes + 1); let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const after = await handle.stat();
      const current = await lstat(this.file);
      if (length > webSettingsMaxBytes || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.mode !== after.mode || before.uid !== after.uid || after.nlink !== 1 || current.isSymbolicLink() || current.dev !== after.dev || current.ino !== after.ino) unavailable();
      const bytes = buffer.subarray(0, length);
      return { bytes, revision: revision(bytes) };
    } finally { await handle.close(); }
  }
  private async snapshot(): Promise<{ data: StoredData; revision: string }> {
    try {
      const current = await this.read();
      const data = current.bytes === null ? emptyStored() : parseStored(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(current.bytes)) as unknown);
      return { data, revision: current.revision };
    } catch { return unavailable(); }
  }
  async get(): Promise<WebSettings> {
    const current = await this.snapshot();
    return project(current.data, current.revision);
  }
  /** Keys are read only at request time and stay inside the server auth closure. */
  transport(settings: WebSettings, options: Pick<ModelTransportOptions, 'fetch' | 'onFailure' | 'onRetry'> = {}): ModelTransport {
    const current = parseWebSettings(settings);
    if (!current.selection) return invalid();
    const selection = current.selection;
    return createModelTransport(webTransportConfiguration(current.configuration), selection, {
      ...options,
      resolveApiKey: async signal => {
        signal.throwIfAborted();
        const latest = await this.snapshot();
        signal.throwIfAborted();
        // Both values are validated public snapshots. JSON object key order is
        // irrelevant; array order and every actual setting must still match.
        if (latest.revision !== current.revision || !isDeepStrictEqual(project(latest.data, latest.revision), current)) throw new WebSettingsError('settings_conflict');
        if (selection.kind === 'builtin') {
          const entry = latest.data.configuration.builtinCredentials[selection.provider];
          return entry?.binding === builtinBinding(selection.provider) ? entry.apiKey ?? undefined : undefined;
        }
        return latest.data.configuration.customConnections.find(connection => connection.id === selection.connection)?.apiKey ?? undefined;
      },
    });
  }
  /** A draft key is used for this discovery only. It is never written here. */
  async discover(value: unknown, options: Omit<ModelDiscoveryOptions, 'env'> = {}): Promise<ModelDiscoveryResult> {
    let connection: WebCustomConnectionWrite;
    try { connection = parseWebConnectionWrite(value); } catch { return invalid(); }
    let key = connection.apiKey;
    if (key === undefined) {
      const current = await this.snapshot();
      key = current.data.configuration.customConnections.find(entry => sameConnection(entry, connection))?.apiKey;
    }
    if (!validWebApiKey(key)) throw new Error('Model discovery requires a saved or newly entered API key');
    rejectSecretMetadata(webConnectionMetadata(connection), [key]);
    const custom = webTransportConfiguration({ builtinCredentials: {}, customConnections: [connection] }).customConnections[0]!;
    return discoverModels(custom, { env: { [custom.apiKeyEnv]: key }, ...(options.fetch ? { fetch: options.fetch } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  }
  /** Validate the same revision and credential binding as a save, without writing. */
  async probe(value: unknown, options: Pick<ModelTransportOptions, 'fetch'> & { signal?: AbortSignal } = {}): Promise<ModelProbeResult> {
    const parsed = parseWebSettingsWrite(value);
    if (parsed.selection?.kind !== 'custom') return invalid();
    const current = await this.snapshot();
    if (current.revision !== parsed.revision) throw new WebSettingsError('settings_conflict');
    const data = mergeStored(current.data, parsed);
    const selection = parsed.selection;
    const connection = data.configuration.customConnections.find(entry => entry.id === selection.connection);
    if (!connection?.apiKey || connection.api !== 'openai-completions' || !connection.models.find(model => model.id === selection.model)?.reasoning) return invalid();
    const result = await probeReasoningFormat(webTransportConfiguration(project(data, current.revision).configuration), selection, {
      ...options, resolveApiKey: async signal => {
        signal.throwIfAborted();
        if ((await this.snapshot()).revision !== current.revision) throw new WebSettingsError('settings_conflict');
        return connection.apiKey!;
      },
    });
    options.signal?.throwIfAborted();
    if ((await this.snapshot()).revision !== current.revision) throw new WebSettingsError('settings_conflict');
    return result;
  }
  async save(value: unknown): Promise<WebSettings> {
    const parsed = parseWebSettingsWrite(value);
    const previous = pending.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      let temporary: string | undefined;
      try {
        const current = await this.snapshot();
        if (current.revision !== parsed.revision) throw new WebSettingsError('settings_conflict');
        const data = mergeStored(current.data, parsed);
        const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
        if (bytes.length > webSettingsMaxBytes) return invalid();
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
        const directory = await open(path.dirname(this.file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try { await directory.sync(); } finally { await directory.close(); }
        return project(data, revision(bytes));
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
