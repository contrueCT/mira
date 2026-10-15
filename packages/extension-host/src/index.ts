import { ExtensionPrivateStorage, credentialKey } from './private-storage.ts';
import { RegisteredSettings, validateSettings, ExtensionSettingsError, type ExtensionSettingsView, type ExtensionSettingsWrite } from './settings.ts';
export { ExtensionSettingsError } from './settings.ts';
export type { ExtensionSettingsView, ExtensionSettingsWrite } from './settings.ts';
import { ArtifactStore, type ArtifactManifest } from './artifacts.ts';
export { ArtifactStore } from './artifacts.ts';
export type { ArtifactManifest, ArtifactTestCommand, ArtifactTestResult } from './artifacts.ts';
import { ConfigurationWriter } from './configuration.ts';
export { readExtensionConfiguration } from './configuration.ts';
export type { ExtensionConfiguration } from './configuration.ts';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Context, type Fiber, type Disposable } from 'cordis';
import Loader, { type EntryOptions } from '@cordisjs/plugin-loader';
import Hmr from '@cordisjs/plugin-hmr';
import Timer from '@cordisjs/plugin-timer';
import { serviceKey, type Cleanup, type ContextProvider, type ExtensionContext, type ExtensionEvent, type ExtensionTool, type ExtensionWake, type ExtensionSchedules, type ExtensionScheduleInput, type Json } from '@mira/extension-sdk';

export interface LocalExtensionEntry {
  id: string;
  /** Explicit local file. This is trusted process code, never a sandbox. */
  path: string;
  enabled?: boolean;
  config?: Json;
  generated?: GeneratedVersion;
  /** Manual installation identity; saved before scheduling is exposed. */
  installationId?: string;
}
export interface GeneratedRevision { id: string; digest: string; config: Json }
export interface GeneratedVersion { digest: string; revision: string; history: GeneratedRevision[] }
export interface ExtensionHostOptions {
  entries: LocalExtensionEntry[];
  reservedToolNames?: string[];
  /** Identity is bound by the host; extension-supplied source fields are ignored. */
  receive(source: string, event: ExtensionEvent, wake?: { id: string; reason: string }): Promise<'inserted' | 'duplicate'>;
  /** Private credential and plugin-state root, outside source/Memory/artifacts. */
  privateDirectory?: string;
  /** Composition-provided source and Memory roots that private files must not overlap. */
  privateStorageExcludedDirectories?: string[];
  schedules?: (owner: string, extensionId: string) => ExtensionSchedules;
  onSchedulesChanged?: () => void;
  hmr?: boolean;
  /** Optional same-file desired configuration persistence; otherwise runtime-only. */
  configurationFile?: string;
  /** Ordinary release files outside the source repository, not a sandbox. */
  artifactsDirectory?: string;
}
export interface RegisteredTool { extensionId: string; activation: string; digest?: string; tool: ExtensionTool }
export interface ContextProviderSample {
  extensionId: string; activation: string; providerId: string; digest?: string;
  status: 'ok' | 'empty' | 'failed' | 'stale' | 'too-large' | 'budget-exceeded';
  text?: string;
}
export interface RegisteredContextProvider {
  extensionId: string; activation: string; providerId: string; digest?: string;
  sample(signal: AbortSignal): Promise<ContextProviderSample>;
}
export interface ExtensionCapabilities { tools: RegisteredTool[]; contextProviders: RegisteredContextProvider[] }
export interface ExtensionStatus {
  id: string; path: string; enabled: boolean; config: Json;
  status: 'disabled' | 'import-failed' | 'waiting' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  generated?: GeneratedVersion;
  activation: string | null; tools: string[]; contextProviders: string[]; diagnostic: string | null;
}
export type ExtensionChange = { action: 'enable' | 'disable' | 'reload' | 'activate' | 'remove' }
  | { action: 'configure'; config: Json }
  | { action: 'install' | 'update'; digest: string; config?: Json }
  | { action: 'rollback'; revision: string };
export interface ChangeStatus { id: string; extensionId: string; action: ExtensionChange['action']; status: 'applied' | 'failed'; runtime: ExtensionStatus | null; persistence: 'saved' | 'failed' | 'not-required' | 'not-attempted'; error?: string; digest?: string; revision?: string; artifact?: 'verified' | 'failed'; test?: 'passed' | 'failed' | 'not-run' | 'invalidated'; cleanup?: 'failed' }
export class ExtensionRevisionConflictError extends Error {
  override name = 'ExtensionRevisionConflictError';
  constructor() { super('Extension state changed; refresh before retrying'); }
}
interface Instance { id: string; activation: string; context: ExtensionContext; fiber: Fiber; executions: Set<Promise<void>>; dependencies: string[]; provided: Set<string> }
interface CleanupScope { extensionId: string; activations: Set<string>; services: Set<string>; errors: string[] }

/** Cordis owns dependency/lifecycle/HMR state. This coordinator protects only
 * executing extension calls and awaits explicit local lifecycle changes. */
export class ExtensionHost {
  private readonly ctx = new Context();
  private readonly entries = new Map<string, LocalExtensionEntry>();
  private readonly instances = new WeakMap<Fiber, Instance>();
  private readonly latest = new Map<string, Instance>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly contextProviders = new Map<string, RegisteredContextProvider>();
  private readonly contextProviderDiagnostics = new Map<string, { activation: string; status: string }>();
  private readonly consumers = new Map<string, Set<Promise<void>>>();
  private readonly listeners = new Map<string, Set<(payload: Json) => void>>();
  private readonly diagnostics = new Map<string, string>();
  private readonly hostDiagnostics: string[] = [];
  private readonly cleanupFailures = new Map<string, string[]>();
  private cleanupScope: CleanupScope | undefined;
  private readonly receipts: ChangeStatus[] = [];
  private lifecycle: Promise<void> = Promise.resolve();
  private started = false;
  private closed = false;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  private configuration: ConfigurationWriter | undefined;
  private readonly reserved: Set<string>;
  private readonly artifacts: ArtifactStore | undefined;
  private artifactWatchRoot: string | undefined;
  readonly hmrEnabled: boolean;

  private readonly privateStorage: ExtensionPrivateStorage | undefined;
  private readonly settings = new Map<string, RegisteredSettings>();
  private readonly options: ExtensionHostOptions;
  constructor(options: ExtensionHostOptions) {
    if (options.artifactsDirectory && !path.isAbsolute(options.artifactsDirectory)) throw new Error('artifactsDirectory must be absolute');
    this.artifacts = options.artifactsDirectory ? new ArtifactStore(options.artifactsDirectory) : undefined;
    this.reserved = new Set(options.reservedToolNames ?? []);
    this.hmrEnabled = options.hmr ?? false;
    for (const entry of options.entries) {
      if (!/^[a-zA-Z][\w-]*$/.test(entry.id) || this.entries.has(entry.id)) throw new Error(`Invalid or duplicate extension ID: ${entry.id}`);
      if (entry.installationId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(entry.installationId)) throw new Error('Invalid extension installation identity');
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('Extension enabled must be boolean');
      if (!path.isAbsolute(entry.path)) throw new Error(`Extension path must be absolute: ${entry.id}`);
      validateConfig(entry.config ?? null);
      if (entry.generated) {
        validateGenerated(entry.generated);
        const revision = entry.generated.history.find(item => item.id === entry.generated!.revision)!;
        if (!isDeepStrictEqual(entry.config ?? null, revision.config)) throw new Error('Generated config does not match saved revision');
        if (!this.artifacts) throw new Error('Generated entries require artifactsDirectory');
      }
      this.entries.set(entry.id, { ...structuredClone(entry), config: structuredClone(entry.config ?? null) });
    }
    this.privateStorage = options.privateDirectory || options.configurationFile ? new ExtensionPrivateStorage(options.privateDirectory ?? path.resolve(path.dirname(options.configurationFile!), 'extension-private'), [fileURLToPath(new URL('../../../', import.meta.url)), ...options.privateStorageExcludedDirectories ?? [], ...options.artifactsDirectory ? [options.artifactsDirectory] : []]) : undefined;
    this.options = { ...options, entries: structuredClone(options.entries) };
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('Extension host cannot be started twice');
    this.started = true;
    await this.privateStorage?.validateLocation();
    if (this.options.configurationFile) this.configuration = await ConfigurationWriter.open(this.options.configurationFile, this.options.entries, this.hmrEnabled, this.options.artifactsDirectory);
    // Existing generated revision history already owns an installation identity.
    // Manual entries get one only when it can survive process restart.
    if ((this.options.schedules || this.privateStorage) && this.configuration) {
      for (const entry of this.entries.values()) {
        if (entry.generated || entry.installationId) continue;
        const saved = { ...entry, installationId: randomUUID() };
        await this.configuration.replace(entry.id, saved);
        this.entries.set(entry.id, saved);
      }
    }
    if (this.privateStorage) for (const entry of this.entries.values()) { const owner = this.scheduleOwner(entry.id); if (owner) { const directory = await this.privateStorage.prepare(owner); await mkdir(path.join(directory, 'data'), { recursive: true, mode: 0o700 }); } }
    this.ctx.baseUrl = pathToFileURL(`${process.cwd()}${path.sep}`).href;
    this.ctx.logger.exporter({ export: message => {
      if (message.type !== 'error' && message.type !== 'warn') return;
      const fiber = message.fiber?.deref();
      const id = fiber?.entry?.id;
      const diagnostic = message.args.map(value => value instanceof Error ? value.message : String(value)).join(' ');
      if (id && this.entries.has(id)) this.diagnostics.set(id, diagnostic);
      else { this.hostDiagnostics.push(diagnostic); if (this.hostDiagnostics.length > 50) this.hostDiagnostics.shift(); }
    } });
    const host = this;
    this.ctx.accessor('mira', { get(this: Context) { return host.apiFor(this); } });
    await this.ctx.plugin(Loader);
    await this.ctx.plugin(Timer);
    if (this.hmrEnabled && this.artifacts && [...this.entries.values()].some(entry => !entry.generated)) {
      await mkdir(this.artifacts.root, { recursive: true });
      this.artifactWatchRoot = await realpath(this.artifacts.root);
    }
    for (const entry of this.entries.values()) {
      // The configured identity is stable even though Cordis code instances change.
      if (entry.generated) {
        try { await this.createGenerated(entry); } catch (error) { this.diagnostics.set(entry.id, error instanceof Error ? error.message : String(error)); }
        continue;
      }
      entry.path = await realpath(entry.path);
      if (!(await stat(entry.path)).isFile()) throw new Error(`Extension is not a file: ${entry.id}`);
      const config: EntryOptions = { id: entry.id, name: pathToFileURL(entry.path).href, config: entry.config, disabled: entry.enabled === false, inject: ['timer'] };
      await this.ctx.loader.create(config);
    }
    await this.ctx.loader.await();
    if (this.hmrEnabled && [...this.entries.values()].some(entry => !entry.generated)) {
      if (!this.ctx.loader.internal) throw new Error('Source HMR requires Node --expose-internals; native addons are not installed');
      // A manual directory can contain the artifact store. Exclude both its
      // authored and canonical paths: generated versions never participate in
      // source HMR, even when the manual watch roots recurse around them.
      const ignored = ['**/node_modules/**', '**/.git/**'];
      if (this.artifacts) {
        await mkdir(this.artifacts.root, { recursive: true });
        for (const root of new Set([this.artifacts.root, this.artifactWatchRoot!])) {
          const relative = path.relative(process.cwd(), root).split(path.sep).join('/');
          const literal = relative.replace(/[\\*?\[\]{}()!+@]/g, '\\$&');
          ignored.push(literal || '**', literal ? `${literal}/**` : '**');
        }
      }
      await this.ctx.plugin(Hmr, { root: [...new Set([...this.entries.values()].filter(entry => !entry.generated).map(entry => path.dirname(entry.path)))], ignored, debounce: 30 });
    }
  }

  private assertOpen(): void { if (!this.started || this.closed || this.closing) throw new Error('Extension host is not running'); }
  private async waitExecutions(ctx: Context): Promise<void> {
    // Cordis fences the fiber as unloading before invoking its disposers. Tool
    // admission checks that state and acquires synchronously, so this snapshot
    // cannot miss a newly admitted call on the retiring activation.
    const instance = this.instances.get(ctx.fiber);
    if (instance && this.settings.get(instance.id)?.activation === instance.activation) this.settings.get(instance.id)?.cancel();
    await Promise.all(instance?.executions ?? []);
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const task = this.lifecycle.then(action);
    this.lifecycle = task.then(() => {}, () => {});
    return task;
  }
  private defer(ctx: Context, cleanup: Cleanup): Promise<void> {
    const done = Promise.withResolvers<void>();
    ctx.effect(() => async () => {
      await this.waitExecutions(ctx);
      try { await cleanup(); } catch (error) { this.recordCleanupFailure(ctx, error); throw error; } finally { done.resolve(); }
    }, 'Mira execution-safe cleanup');
    return done.promise;
  }
  /** Collect the native effect so Cordis cannot run it as a concurrent sibling.
   * Calling the same official disposer twice is harmless: it is idempotent.
   * The tracked first call gives dependents a completion barrier even on error. */
  private deferNative(ctx: Context, dispose: Disposable, before?: () => Promise<void>): Promise<void> {
    const host = this;
    const done = Promise.withResolvers<void>();
    ctx.effect(function* () {
      yield dispose;
      yield async () => {
        await host.waitExecutions(ctx);
        await before?.();
        try { await dispose(); } catch (error) { host.recordCleanupFailure(ctx, error); throw error; } finally { done.resolve(); }
      };
    }, 'Mira execution-safe Cordis resource');
    return done.promise;
  }
  private trackAffected(instance: Instance): void {
    const scope = this.cleanupScope;
    if (!scope || (instance.id !== scope.extensionId && !scope.activations.has(instance.activation)
      && !instance.dependencies.some(key => scope.services.has(key)))) return;
    scope.activations.add(instance.activation);
    for (const key of instance.provided) scope.services.add(key);
  }
  private beginCleanupScope(id: string): void {
    const scope: CleanupScope = { extensionId: id, activations: new Set(), services: new Set(), errors: [] };
    this.cleanupScope = scope;
    let previousSize = -1;
    while (previousSize !== scope.activations.size) {
      previousSize = scope.activations.size;
      for (const instance of this.latest.values()) {
        if (this.instances.get(instance.fiber) === instance) this.trackAffected(instance);
      }
    }
  }
  private recordCleanupFailure(ctx: Context, error: unknown): void {
    const id = ctx.fiber.entry?.id;
    const message = error instanceof Error ? error.message : String(error);
    if (id) this.cleanupFailures.set(id, [...this.cleanupFailures.get(id) ?? [], message]);
    const instance = this.instances.get(ctx.fiber);
    if (instance && this.cleanupScope?.activations.has(instance.activation)) {
      this.cleanupScope.errors.push(`${id}: ${message}`);
    }
    this.hostDiagnostics.push(`Cleanup failed for ${id ?? 'unknown extension'}: ${message}`);
    if (this.hostDiagnostics.length > 50) this.hostDiagnostics.shift();
  }
  private apiFor(ctx: Context): ExtensionContext {
    const prior = this.instances.get(ctx.fiber);
    if (prior) return prior.context;
    ctx.fiber.assertActive();
    if (ctx.fiber.state !== 1 && ctx.fiber.state !== 2) throw new Error('Cannot create API for an inactive extension');
    const id = ctx.fiber.entry?.id;
    if (!id || !this.entries.has(id)) throw new Error('Mira API requires a configured extension identity');
    const activation = randomUUID();
    let retired = false;
    const executions = new Set<Promise<void>>();
    const finished = Promise.withResolvers<void>();
    const dependencies = Object.keys(ctx.fiber.inject).filter(key => key.startsWith('mira.extension.'));
    // Cordis withdraws services to start dependent disposal before the provider
    // resource is closed. Pin this activation's injected values now, so an
    // already executing call may first access a dependency while unloading.
    const services = new Map<string, unknown>();
    for (const key of dependencies) {
      const value: unknown = ctx.get(key, false);
      if (value !== undefined) services.set(key, value);
    }
    for (const key of dependencies) {
      let consumers = this.consumers.get(key);
      if (!consumers) this.consumers.set(key, consumers = new Set());
      consumers.add(finished.promise);
    }
    const serviceDrains: Promise<void>[] = [];
    const resourceDrains: Promise<void>[] = [];
    const cleanupDrains: Promise<void>[] = [];
    const provided = new Set<string>();
    const drainConsumers = async (): Promise<void> => {
      await Promise.all([...provided].flatMap(key => [...this.consumers.get(key) ?? []]).filter(task => task !== finished.promise));
    };
    const drainDependencies = async (): Promise<void> => { await Promise.all(serviceDrains); await drainConsumers(); };
    const releaseResource = (cleanup: Cleanup): Promise<void> => this.defer(ctx, async () => { await drainDependencies(); await cleanup(); });
    const alive = (): void => { if (this.closed) throw new Error('Extension host is closed'); if (retired) throw new Error('Extension activation has retired'); };
    const canRegister = (): void => {
      alive(); ctx.fiber.assertActive();
      if (ctx.fiber.state !== 1 && ctx.fiber.state !== 2) throw new Error('Cannot register resources while extension is retiring');
    };
    const context: ExtensionContext = {
      id,
      privateDirectory: this.privateStorage && this.scheduleOwner(id) ? path.join(this.privateStorage.directory(this.scheduleOwner(id)!), 'data') : null,
      credentials: {
        get: async key => { canRegister(); credentialKey(key); const owner = this.scheduleOwner(id); if (!owner || !this.privateStorage) throw new ExtensionSettingsError('unavailable'); const values = await this.privateStorage.values(owner); canRegister(); return Object.hasOwn(values, key) ? values[key]! : null; },
        has: async key => (await context.credentials.get(key)) !== null,
        set: async (key, value) => { canRegister(); const owner = this.scheduleOwner(id); if (!owner || !this.privateStorage) throw new ExtensionSettingsError('unavailable'); await this.privateStorage.update(owner, { [key]: value }, canRegister); },
        delete: async key => { canRegister(); const owner = this.scheduleOwner(id); if (!owner || !this.privateStorage) throw new ExtensionSettingsError('unavailable'); await this.privateStorage.update(owner, { [key]: null }, canRegister); },
      },
      registerSettings: definition => {
        canRegister(); const owner = this.scheduleOwner(id);
        if (!owner || !this.privateStorage) throw new ExtensionSettingsError('unavailable');
        if (this.settings.has(id)) throw new Error('Duplicate extension settings');
        const settings = new RegisteredSettings(validateSettings(definition), activation, owner, this.privateStorage,
          () => this.entries.get(id)?.config ?? null, canRegister, task => { executions.add(task); void task.finally(() => executions.delete(task)); });
        this.settings.set(id, settings);
        // Abort before draining leases, including automatic Cordis/HMR retirement.
        ctx.effect(() => () => { settings.cancel(); }, 'Cancel extension settings actions');
        resourceDrains.push(releaseResource(async () => { await settings.drain(); if (this.settings.get(id) === settings) this.settings.delete(id); }));
        // A plugin tool already holds an execution lease. Do not queue behind
        // lifecycle serialization, which may itself be draining that tool.
        // The same runner reserves local admission before its async checks.
        return Object.freeze({
          start: async (actionId: string) => {
            canRegister();
            const view = await settings.start(actionId, (await settings.view()).revision);
            canRegister();
            const operation = view.operation!;
            return { id: operation.id, action: operation.action, state: operation.state };
          },
          current: async () => { canRegister(); return settings.current(); },
          cancel: async (operationId: string) => { canRegister(); settings.cancelOperation(operationId); },
        });
      },
      schedules: this.scopedSchedules(id, () => { canRegister(); }),
      registerTool: tool => {
        canRegister();
        const name = tool.name, description = tool.description, parameters = tool.parameters, execute = tool.execute;
        if (typeof name !== 'string' || !/^[a-zA-Z_]/.test(name) || name.length > 64 || /[^a-zA-Z0-9_-]/.test(name)) throw new Error('Invalid extension tool name: use 1-64 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore');
        if (!description.trim() || parameters.type !== 'object' || typeof execute !== 'function') throw new Error('Invalid extension tool');
        if (this.reserved.has(name) || this.tools.has(name)) throw new Error(`Duplicate registered tool: ${name}`);
        const registered: RegisteredTool = { extensionId: id, activation, ...(this.entries.get(id)?.generated ? { digest: this.entries.get(id)!.generated!.digest } : {}), tool: {
          name, description, parameters: structuredClone(parameters),
          execute: async (arguments_, execution) => {
            if (retired || this.closed || this.closing || ctx.fiber.state !== 2 || this.tools.get(name) !== registered) {
              return {
                text: `Tool ${name} was not executed because extension activation ${activation} is stale. Use the next model request’s fresh tool declarations before retrying.`,
                details: { status: 'stale', executed: false, extensionId: id, activation, toolName: name },
              };
            }
            const lease = Promise.withResolvers<void>();
            executions.add(lease.promise);
            try { return await execute.call(tool, arguments_, execution); }
            finally { executions.delete(lease.promise); lease.resolve(); }
          },
        } };
        resourceDrains.push(releaseResource(() => { if (this.tools.get(name) === registered) this.tools.delete(name); }));
        this.tools.set(name, registered);
      },
      registerContextProvider: provider => {
        canRegister();
        const providerId = provider.id, provide = provider.provide;
        if (typeof providerId !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(providerId) || typeof provide !== 'function') throw new Error('Invalid context provider');
        if (id.length > 128) throw new Error('Context provider extension ID exceeds 128 characters');
        const key = `${id}/${providerId}`;
        if (this.contextProviders.has(key)) throw new Error(`Duplicate context provider: ${key}`);
        if (this.contextProviders.size >= 32) throw new Error('Context provider registry exceeds 32 providers');
        const source = { extensionId: id, activation, providerId, ...(this.entries.get(id)?.generated ? { digest: this.entries.get(id)!.generated!.digest } : {}) };
        const registered: RegisteredContextProvider = { ...source, sample: async signal => {
          signal.throwIfAborted();
          if (retired || this.closed || this.closing || ctx.fiber.state !== 2 || this.contextProviders.get(key) !== registered) return { ...source, status: 'stale' };
          const lease = Promise.withResolvers<void>();
          executions.add(lease.promise);
          // Cancellation stops request preparation promptly, but cannot preempt
          // trusted code. Keep its resource lease until the callback really ends.
          const task = (async (): Promise<ContextProviderSample> => {
            try {
              const result = await provide.call(provider, { signal });
              if (result === null) return { ...source, status: 'empty' };
              if (!result || typeof result !== 'object') return { ...source, status: 'failed' };
              const text = result.text;
              if (typeof text !== 'string') return { ...source, status: 'failed' };
              if (!text.length) return { ...source, status: 'empty' };
              const sample: ContextProviderSample = { ...source, status: 'ok', text };
              if (Buffer.byteLength(JSON.stringify(sample), 'utf8') > 16_384) return { ...source, status: 'too-large' };
              return sample;
            } catch { return { ...source, status: 'failed' }; }
            finally { executions.delete(lease.promise); lease.resolve(); }
          })();
          return await cancellable(task, signal);
        } };
        resourceDrains.push(releaseResource(() => { if (this.contextProviders.get(key) === registered) { this.contextProviders.delete(key); this.contextProviderDiagnostics.delete(key); } }));
        this.contextProviders.set(key, registered);
      },
      emitEvent: async event => { alive(); return this.options.receive(id, validatedEvent(event)); },
      requestWake: async request => {
        alive();
        if (!request.id || !request.reason.trim()) throw new Error('Wake needs a stable ID and reason');
        return this.options.receive(id, validatedEvent(request.event), { id: request.id, reason: request.reason });
      },
      provideService: (name, value) => { canRegister(); const key = serviceKey(name); serviceDrains.push(this.deferNative(ctx, ctx.provide(key, value))); provided.add(key); services.set(key, value); this.trackAffected(this.instances.get(ctx.fiber)!); },
      service: <T>(name: string): T => {
        alive(); const key = serviceKey(name);
        if (!(key in ctx.fiber.inject) && !provided.has(key)) throw new Error(`Declare required service: ${name}`);
        if (!services.has(key)) {
          const value: unknown = ctx.get(key, false);
          if (value === undefined) throw new Error(`Required service unavailable: ${name}`);
          services.set(key, value);
        }
        return services.get(key) as T;
      },
      onCleanup: cleanup => { canRegister(); cleanupDrains.push(this.defer(ctx, async () => { await drainDependencies(); await Promise.all(resourceDrains); await cleanup(); })); },
      onEvent: (name, listener) => {
        canRegister();
        const registeredListener = (payload: Json): void => listener(payload);
        let listeners = this.listeners.get(name);
        if (!listeners) listeners = new Set();
        resourceDrains.push(releaseResource(() => { listeners.delete(registeredListener); if (!listeners.size) this.listeners.delete(name); }));
        this.listeners.set(name, listeners);
        listeners.add(registeredListener);
      },
      publish: (name, payload) => { alive(); for (const listener of this.listeners.get(name) ?? []) listener(structuredClone(payload)); },
      interval: (callback, milliseconds) => {
        canRegister();
        if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('Interval must be positive');
        resourceDrains.push(this.deferNative(ctx, ctx.interval(callback, milliseconds), drainDependencies));
      },
    };
    const instance = { id, activation, context, fiber: ctx.fiber, executions, dependencies, provided };
    this.instances.set(ctx.fiber, instance); this.latest.set(id, instance);
    this.trackAffected(instance);
    this.defer(ctx, async () => {
      await Promise.all([...serviceDrains, ...resourceDrains, ...cleanupDrains]);
      await drainConsumers();
      retired = true;
      if (this.instances.get(ctx.fiber) === instance) this.instances.delete(ctx.fiber);
      for (const key of dependencies) { const consumers = this.consumers.get(key); consumers?.delete(finished.promise); if (!consumers?.size) this.consumers.delete(key); }
      finished.resolve();
    });
    return context;
  }

  private scheduleOwner(id: string): string | null {
    const entry = this.entries.get(id);
    if (!entry) return null;
    const identity = entry.generated?.history[0]?.id ?? entry.installationId;
    return identity ? JSON.stringify(['extension', id, identity]) : null;
  }
  private scopedSchedules(id: string, assertActive: () => void): ExtensionSchedules {
    const owner = this.scheduleOwner(id);
    const api = owner ? this.options.schedules?.(owner, id) : undefined;
    const invoke = async <T>(action: (service: ExtensionSchedules) => Promise<T>, changed = false): Promise<T> => {
      assertActive();
      if (!api) throw new Error('Persistent scheduling requires a durable installation identity and a scheduling-capable host');
      const result = await action(api);
      if (changed) this.options.onSchedulesChanged?.();
      return result;
    };
    return {
      create: input => invoke(api => api.create(validatedSchedule(input)), true),
      get: key => invoke(api => api.get(key)),
      list: () => invoke(api => api.list()),
      replace: (expectedVersion, input) => invoke(api => api.replace(expectedVersion, validatedSchedule(input)), true),
      cancel: (key, expectedVersion) => invoke(api => api.cancel(key, expectedVersion), true),
    };
  }
  /** Serialize the enqueue boundary with explicit lifecycle mutations. No code
   * from an extension runs here; pending deliveries retain their frozen data. */
  async withScheduledOwners<T>(dispatch: (owners: string[]) => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.serialize(async () => {
      await this.ctx.loader.await();
      const owners = this.snapshot().filter(entry => entry.status === 'active' && entry.enabled)
        .map(entry => this.scheduleOwner(entry.id)).filter((owner): owner is string => owner !== null);
      return dispatch(owners);
    });
  }

  /** Save desired configuration, then await the actual lifecycle outcome. */
  async requestChange(id: string, change: ExtensionChange, options?: { expectedRevision: string }): Promise<ChangeStatus> {
    this.assertOpen();
    if (!/^[a-zA-Z][\w-]*$/.test(id)) throw new Error('Invalid extension ID');
    if (!['enable', 'disable', 'reload', 'configure', 'install', 'activate', 'update', 'rollback', 'remove'].includes(change.action)) throw new Error('Unknown extension action');
    if (change.action === 'configure' || ((change.action === 'install' || change.action === 'update') && change.config !== undefined)) validateConfig(change.config!);
    if (change.action === 'install' || change.action === 'update') validateDigest(change.digest);
    const snapshot = structuredClone(change);
    const expectedRevision = options?.expectedRevision;
    return this.serialize(async () => {
      // Settle an already-started HMR replacement before comparing the state the
      // client saw. The check and dispatch below have no intervening await.
      await this.ctx.loader.await();
      if (expectedRevision !== undefined && this.managementRevision(id) !== expectedRevision) throw new ExtensionRevisionConflictError();
      if (snapshot.action === 'install') {
        if (this.entries.has(id)) throw new Error(`Extension already installed: ${id}`);
        if (!this.artifacts) throw new Error('Generated extensions require artifactsDirectory');
      } else if (!this.entries.has(id)) throw new Error(`Unknown configured extension: ${id}`);
      if (snapshot.action === 'update' || snapshot.action === 'rollback' || snapshot.action === 'activate') {
        if (!this.entries.get(id)?.generated) throw new Error('Action requires an installed generated extension');
      }
      const receipt: ChangeStatus = { id: randomUUID(), extensionId: id, action: snapshot.action, status: 'failed', runtime: null, persistence: this.configuration && snapshot.action !== 'reload' ? 'not-attempted' : 'not-required' };
      try { await this.applyChange(receipt, snapshot); }
      finally { this.cleanupScope = undefined; }
      receipt.runtime = this.snapshot().find(entry => entry.id === id) ?? null;
      this.receipts.push(receipt);
      this.options.onSchedulesChanged?.();
      return structuredClone(receipt);
    });
  }
  async extensionSettings(id: string): Promise<ExtensionSettingsView | null> {
    this.assertOpen(); const settings = this.settings.get(id);
    if (!settings || this.snapshot().find(entry => entry.id === id)?.status !== 'active') return null;
    return settings.view();
  }
  async startSettingsAction(id: string, action: string, expectedRevision: string): Promise<ExtensionSettingsView> {
    this.assertOpen();
    return this.serialize(async () => { const settings = this.settings.get(id); if (!settings) throw new ExtensionSettingsError('unavailable'); return settings.start(action, expectedRevision); });
  }
  async cancelSettingsAction(id: string, operationId: string): Promise<void> {
    this.assertOpen(); const settings = this.settings.get(id); if (!settings) throw new ExtensionSettingsError('unavailable');
    settings.cancelOperation(operationId);
  }
  async saveExtensionSettings(id: string, input: ExtensionSettingsWrite): Promise<void> {
    this.assertOpen();
    await this.serialize(async () => {
      const settings = this.settings.get(id); if (!settings) throw new ExtensionSettingsError('unavailable');
      await settings.write(input, async ({ config, credentialsChanged }) => {
        const configChanged = !isDeepStrictEqual(this.entries.get(id)?.config ?? null, config);
        if (!configChanged && !credentialsChanged) return;
        // Cordis skips equal-config updates. A changed UI credential still needs
        // one forced reapply so clients initialized during apply see the new value.
        const change: ExtensionChange = configChanged ? { action: 'configure', config } : { action: 'reload' };
        const receipt: ChangeStatus = { id: randomUUID(), extensionId: id, action: change.action, status: 'failed', runtime: null, persistence: this.configuration && configChanged ? 'not-attempted' : 'not-required' };
        try { await this.applyChange(receipt, change); } finally { this.cleanupScope = undefined; }
        receipt.runtime = this.snapshot().find(entry => entry.id === id) ?? null; this.receipts.push(receipt);
        if (receipt.status !== 'applied') throw new ExtensionSettingsError('unavailable');
      });
    });
  }
  /** Opaque revision of private desired/runtime state, never raw config data. */
  managementRevision(id: string): string {
    this.assertOpen();
    const entry = this.entries.get(id);
    const runtime = this.snapshot().find(item => item.id === id) ?? null;
    const receipt = this.receipts.findLast(item => item.extensionId === id)?.id ?? null;
    return createHash('sha256').update(JSON.stringify({ entry: entry ?? null, runtime, receipt })).digest('hex');
  }
  changeStatus(): ChangeStatus[] { return structuredClone(this.receipts); }
  diagnosticsLog(): string[] { return [...this.hostDiagnostics]; }
  inspect(): ExtensionStatus[] {
    this.assertOpen();
    return this.snapshot();
  }
  private snapshot(): ExtensionStatus[] {
    const names: ExtensionStatus['status'][] = ['waiting', 'loading', 'active', 'failed', 'disposed', 'unloading'];
    return [...this.entries.values()].map(entry => {
      const cordis = this.ctx.loader.store[entry.id];
      return { id: entry.id, path: entry.path, enabled: entry.enabled !== false, config: structuredClone(entry.config ?? null),
        ...(entry.generated ? { generated: structuredClone(entry.generated) } : {}),
        status: entry.enabled === false ? 'disabled' : cordis?.fiber ? names[cordis.fiber.state]! : 'import-failed',
        activation: this.latest.get(entry.id)?.activation ?? null,
        tools: [...this.tools.values()].filter(tool => tool.extensionId === entry.id).map(tool => tool.tool.name),
        contextProviders: [...this.contextProviders.values()].filter(provider => provider.extensionId === entry.id).map(provider => provider.providerId),
        diagnostic: this.diagnostics.get(entry.id) ?? ([...this.contextProviders.entries()].filter(([, provider]) => provider.extensionId === entry.id)
          .map(([key]) => this.contextProviderDiagnostics.get(key)).find(Boolean) ? 'Context provider sampling failed or exceeded its data budget.' : undefined) ?? (entry.enabled !== false && !cordis?.fiber ? 'Import did not create a plugin; see host diagnostics' : null) };
    });
  }

  /** Copy/hash only: never imports or executes the source tree. */
  async stage(sourceRoot: string, entryRelative: string, expectedDigest?: string): Promise<ArtifactManifest> {
    this.assertOpen();
    if (!this.artifacts) throw new Error('Generated extensions require artifactsDirectory');
    return this.artifacts.stage(sourceRoot, entryRelative, expectedDigest);
  }
  async releases(): Promise<ArtifactManifest[]> { return this.artifacts ? this.artifacts.list() : []; }

  private async removeRuntime(id: string): Promise<void> {
    const entry = this.ctx.loader.store[id];
    if (!entry) return;
    // Await the old fiber explicitly before Loader removes it from its task list.
    await entry.fiber?.dispose();
    this.ctx.loader.remove(id);
    await this.ctx.loader.await();
    const failures = this.cleanupFailures.get(id);
    if (failures?.length) throw new Error(`Cleanup failed: ${failures.join('; ')}`);
  }
  private async assertArtifactWatchRoot(): Promise<void> {
    if (this.artifactWatchRoot && await realpath(this.artifacts!.root) !== this.artifactWatchRoot) {
      throw new Error('Artifact store path changed after HMR exclusion was established; restart the host');
    }
  }
  private async createGenerated(entry: LocalExtensionEntry, receipt?: ChangeStatus): Promise<void> {
    let fresh: ArtifactManifest;
    try {
      await this.assertArtifactWatchRoot();
      const artifact = await this.artifacts!.read(entry.generated!.digest);
      fresh = entry.enabled === false ? artifact : await this.artifacts!.prepareFreshActivation(artifact);
    } catch (error) {
      // Old cleanup runs after desired config is saved and may change ordinary
      // files. Revoke earlier evidence if activation-time verification fails.
      if (receipt) { receipt.artifact = 'failed'; receipt.test = 'invalidated'; }
      throw error;
    }
    const owner = this.scheduleOwner(entry.id);
    if (owner && this.privateStorage) { const directory = await this.privateStorage.prepare(owner); await mkdir(path.join(directory, 'data'), { recursive: true, mode: 0o700 }); }
    const options: EntryOptions = { id: entry.id, name: pathToFileURL(fresh.entry).href, config: entry.config, disabled: entry.enabled === false, inject: ['timer'] };
    await this.ctx.loader.create(options);
  }
  private async desiredEntry(id: string, change: ExtensionChange, receipt: ChangeStatus): Promise<LocalExtensionEntry | null> {
    const previous = this.entries.get(id);
    if (change.action === 'remove') return null;
    if (change.action === 'install' && previous) throw new Error('Extension already installed');
    if (change.action !== 'install' && !previous) throw new Error('Extension disappeared before apply');
    const desired: LocalExtensionEntry = previous ? structuredClone(previous) : { id, path: '', enabled: false, config: null };
    if (change.action === 'configure') desired.config = structuredClone(change.config);
    if (change.action === 'enable' || change.action === 'activate') desired.enabled = true;
    if (change.action === 'disable') desired.enabled = false;
    if (change.action === 'rollback') {
      const revision = desired.generated!.history.find(item => item.id === change.revision);
      if (!revision) throw new Error('Unknown saved revision');
      desired.config = structuredClone(revision.config);
      desired.generated!.digest = revision.digest;
      desired.generated!.revision = revision.id;
    }
    if (change.action === 'install' || change.action === 'update' || (change.action === 'configure' && desired.generated)) {
      const digest = change.action === 'configure' ? desired.generated!.digest : change.digest;
      const config = change.config === undefined ? desired.config ?? null : structuredClone(change.config);
      const revision = { id: randomUUID(), digest, config };
      desired.config = config;
      desired.generated = { digest, revision: revision.id, history: [...desired.generated?.history ?? [], revision] };
    }
    if (desired.generated && change.action !== 'disable') {
      try {
        await this.assertArtifactWatchRoot();
        const artifact = await this.artifacts!.read(desired.generated.digest);
        desired.path = artifact.entry;
        receipt.artifact = 'verified'; receipt.digest = artifact.digest; receipt.revision = desired.generated.revision;
        const test = await this.artifacts!.testResult(artifact);
        receipt.test = test ? (test.passed ? 'passed' : 'failed') : 'not-run';
      } catch (error) { receipt.artifact = 'failed'; throw error; }
    }
    return desired;
  }

  private async applyChange(receipt: ChangeStatus, change: ExtensionChange): Promise<void> {
    try {
      await this.ctx.loader.await();
      const id = receipt.extensionId;
      this.settings.get(id)?.cancel();
      const previousOwner = this.scheduleOwner(id);
      this.cleanupFailures.delete(id);
      this.beginCleanupScope(id);
      const desired = await this.desiredEntry(id, change, receipt);
      if (this.configuration && change.action !== 'reload') {
        try { await this.configuration.replace(id, desired); receipt.persistence = 'saved'; }
        catch (error) { receipt.persistence = 'failed'; throw error; }
      }
      // Saving is awaited I/O: HMR may have started retiring this entry in the
      // meantime. Drain that work before mutating its runtime. Keep the final
      // task check and mutation in the same turn, so a stale fiber cannot be
      // disabled/configured while HMR is still replacing it.
      while (this.ctx.loader.getTasks().length) await this.ctx.loader.await();
      this.diagnostics.delete(id);
      if (desired === null) {
        try { await this.removeRuntime(id); }
        finally { this.entries.delete(id); this.latest.delete(id); if (previousOwner) await this.privateStorage?.removeCredentials(previousOwner); }
      } else {
        this.entries.set(id, desired);
        if (desired.generated) {
          if (change.action === 'disable' && this.ctx.loader.store[id]) await this.ctx.loader.update(id, { disabled: true });
          else {
            await this.removeRuntime(id);
            this.latest.delete(id);
            await this.createGenerated(desired, receipt);
          }
        } else {
          const entry = this.ctx.loader.resolve(id);
          if (change.action === 'reload') {
            if (entry.disabled) throw new Error('Enable a disabled extension before restarting it');
            if (entry.fiber) await entry.fiber.update(entry.fiber.config, true); else await entry.init();
          } else await this.ctx.loader.update(id, change.action === 'configure' ? { config: change.config } : { disabled: change.action === 'disable' });
        }
        await this.ctx.loader.await();
        const state = this.snapshot().find(item => item.id === id)!;
        if (state.status === 'failed' || state.status === 'import-failed') throw new Error(state.diagnostic ?? `Extension ${state.status}`);
      }
      receipt.status = 'applied';
    } catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : String(error); }
    // An earlier failure can bypass createGenerated (for example cleanup
    // mutates a candidate and then throws). Do not retain stale preflight
    // evidence merely because activation was never reached.
    if (receipt.status === 'failed' && receipt.artifact === 'verified' && receipt.digest) {
      try { await this.artifacts!.read(receipt.digest); }
      catch (error) {
        receipt.artifact = 'failed'; receipt.test = 'invalidated';
        receipt.error = `${receipt.error ?? 'Change failed'}; ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    const failures = this.cleanupScope?.errors;
    if (failures?.length) {
      receipt.cleanup = 'failed'; receipt.status = 'failed';
      const message = `Cleanup failed: ${failures.join('; ')}`;
      receipt.error = receipt.error ? `${receipt.error}; ${message}` : message;
    }
  }
  /** Settle known lifecycle work and snapshot declarations. Only actual tool
   * execution leases resources; an old declaration never pins an activation. */
  async prepare(): Promise<RegisteredTool[]> { return (await this.prepareCapabilities()).tools; }
  /** One declaration snapshot for tools and context providers. Capturing it does
   * not lease resources; each actual call checks its original activation. */
  async prepareCapabilities(): Promise<ExtensionCapabilities> {
    this.assertOpen();
    return this.serialize(async () => {
      await this.ctx.loader.await();
      return {
        tools: [...this.tools.values()].map(tool => ({ ...tool, tool: { ...tool.tool, parameters: structuredClone(tool.tool.parameters) } })),
        contextProviders: [...this.contextProviders.values()].map(provider => ({ ...provider })),
      };
    });
  }
  /** Sample each pinned provider once; unavailable data replaces old successes.
   * Budgets bound serialized JSON bytes and never silently truncate content. */
  async sampleContextProviders(providers: readonly RegisteredContextProvider[], signal: AbortSignal): Promise<ContextProviderSample[]> {
    this.assertOpen(); signal.throwIfAborted();
    if (providers.length > 32) throw new Error('Context provider registry exceeds 32 providers');
    const seen = new Set<string>();
    for (const provider of providers) {
      const key = `${provider.extensionId}/${provider.providerId}`;
      if (seen.has(key)) throw new Error('Duplicate context provider declaration');
      seen.add(key);
    }
    const samples: ContextProviderSample[] = [];
    // Reserve room for every source/status so aggregate overflow stays explicit.
    let remaining = 65_536 - Buffer.byteLength(JSON.stringify(providers.map(({ extensionId, activation, providerId, digest }) => ({ extensionId, activation, providerId, ...(digest === undefined ? {} : { digest }), status: 'budget-exceeded' }))), 'utf8');
    for (const provider of providers) {
      signal.throwIfAborted();
      const sample = await provider.sample(signal);
      signal.throwIfAborted();
      const fallback: ContextProviderSample = { extensionId: sample.extensionId, activation: sample.activation, providerId: sample.providerId, ...(sample.digest === undefined ? {} : { digest: sample.digest }), status: 'budget-exceeded' };
      const extra = Buffer.byteLength(JSON.stringify(sample), 'utf8') - Buffer.byteLength(JSON.stringify(fallback), 'utf8');
      const selected = extra > remaining ? fallback : sample;
      if (selected === sample) remaining -= extra;
      samples.push(selected);
      const key = `${sample.extensionId}/${sample.providerId}`;
      // Process-local health only. A late result from a retired request cannot
      // overwrite a replacement activation's diagnostic or expose raw errors.
      if (this.contextProviders.get(key)?.activation === sample.activation && sample.status !== 'stale') {
        if (['failed', 'too-large', 'budget-exceeded'].includes(selected.status)) this.contextProviderDiagnostics.set(key, { activation: sample.activation, status: selected.status });
        else this.contextProviderDiagnostics.delete(key);
      }
    }
    return samples;
  }
  /** Terminal/error cleanup never reopens a finished cognition turn. */
  async finish(): Promise<void> {
    this.assertOpen();
    await this.serialize(() => this.ctx.loader.await());
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.closing = true;
    this.closeTask = (async () => {
      await this.lifecycle;
      try { await this.ctx.fiber.dispose(); } finally { this.closed = true; this.closing = false; }
    })();
    return this.closeTask;
  }
}
function validatedSchedule(input: ExtensionScheduleInput): ExtensionScheduleInput {
  const snapshot = structuredClone(input);
  snapshot.event = validatedEvent(snapshot.event);
  if (snapshot.wake && (typeof snapshot.wake.id !== 'string' || !snapshot.wake.id || typeof snapshot.wake.reason !== 'string' || !snapshot.wake.reason.trim())) {
    throw new Error('Scheduled Wake needs a stable ID and reason');
  }
  return snapshot;
}
function validatedEvent(event: ExtensionEvent): ExtensionEvent {
  if (!event.id || !event.type || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error('Event requires a stable ID, type and timestamp');
  return { id: event.id, type: event.type, occurredAt: event.occurredAt, payload: structuredClone(event.payload) };
}
export type { ExtensionEvent, ExtensionWake, ExtensionTool, ContextProvider, Json };

function validateConfig(value: Json): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value)) { for (const item of value) validateConfig(item); return; }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    // Cordis interprets this key as executable configuration. Plain JSON settings
    // stay data rather than an implicit configuration-expression execution path.
    if ('__jsExpr' in value) throw new Error('Executable Cordis config expressions are not supported');
    for (const item of Object.values(value)) validateConfig(item);
    return;
  }
  throw new Error('Extension config must be plain finite JSON');
}

function validateDigest(digest: string): void { if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid artifact digest'); }
function validateGenerated(value: GeneratedVersion): void {
  validateDigest(value.digest);
  if (!Array.isArray(value.history) || !value.history.length || typeof value.revision !== 'string') throw new Error('Invalid generated version');
  const ids = new Set<string>();
  for (const revision of value.history) {
    validateDigest(revision.digest); validateConfig(revision.config);
    if (typeof revision.id !== 'string' || !revision.id || ids.has(revision.id)) throw new Error('Invalid generated revision');
    ids.add(revision.id);
  }
  const current = value.history.find(item => item.id === value.revision);
  if (!current || current.digest !== value.digest) throw new Error('Generated version does not match revision');
}

/** Observe cancellation without abandoning the underlying resource lease. */
async function cancellable<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  const stopped = Promise.withResolvers<never>();
  const abort = (): void => stopped.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  try { signal.throwIfAborted(); return await Promise.race([task, stopped.promise]); }
  finally { signal.removeEventListener('abort', abort); }
}
