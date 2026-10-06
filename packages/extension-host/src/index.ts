import { ArtifactStore, type ArtifactManifest } from './artifacts.ts';
export { ArtifactStore } from './artifacts.ts';
export type { ArtifactManifest, ArtifactTestCommand, ArtifactTestResult } from './artifacts.ts';
import { ConfigurationWriter } from './configuration.ts';
export { readExtensionConfiguration } from './configuration.ts';
export type { ExtensionConfiguration } from './configuration.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Context, type Fiber, type Disposable } from 'cordis';
import Loader, { type EntryOptions } from '@cordisjs/plugin-loader';
import Hmr from '@cordisjs/plugin-hmr';
import Timer from '@cordisjs/plugin-timer';
import { serviceKey, type Cleanup, type ExtensionContext, type ExtensionEvent, type ExtensionTool, type ExtensionWake, type Json } from '@mira/extension-sdk';

export interface LocalExtensionEntry {
  id: string;
  /** Explicit local file. This is trusted process code, never a sandbox. */
  path: string;
  enabled?: boolean;
  config?: Json;
  generated?: GeneratedVersion;
}
export interface GeneratedRevision { id: string; digest: string; config: Json }
export interface GeneratedVersion { digest: string; revision: string; history: GeneratedRevision[] }
export interface ExtensionHostOptions {
  entries: LocalExtensionEntry[];
  reservedToolNames?: string[];
  /** Identity is bound by the host; extension-supplied source fields are ignored. */
  receive(source: string, event: ExtensionEvent, wake?: { id: string; reason: string }): Promise<'inserted' | 'duplicate'>;
  hmr?: boolean;
  /** Optional same-file desired configuration persistence; otherwise runtime-only. */
  configurationFile?: string;
  /** Ordinary release files outside the source repository, not a sandbox. */
  artifactsDirectory?: string;
}
export interface RegisteredTool { extensionId: string; activation: string; digest?: string; tool: ExtensionTool }
export interface ExtensionStatus {
  id: string; path: string; enabled: boolean; config: Json;
  status: 'disabled' | 'import-failed' | 'waiting' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  generated?: GeneratedVersion;
  activation: string | null; tools: string[]; diagnostic: string | null;
}
export type ExtensionChange = { action: 'enable' | 'disable' | 'reload' | 'activate' | 'remove' }
  | { action: 'configure'; config: Json }
  | { action: 'install' | 'update'; digest: string; config?: Json }
  | { action: 'rollback'; revision: string };
export interface ChangeStatus { id: string; extensionId: string; action: ExtensionChange['action']; status: 'accepted' | 'applied' | 'failed'; persistence: 'pending' | 'saved' | 'failed' | 'not-required' | 'not-attempted'; error?: string; digest?: string; revision?: string; artifact?: 'verified' | 'failed'; test?: 'passed' | 'failed' | 'not-run' | 'invalidated'; cleanup?: 'failed' }
interface Instance { id: string; activation: string; context: ExtensionContext; fiber: Fiber }

/** Cordis owns dependency/lifecycle/HMR state. This coordinator only protects
 * a published model/tool batch and queues explicit local lifecycle changes. */
export class ExtensionHost {
  private readonly ctx = new Context();
  private readonly entries = new Map<string, LocalExtensionEntry>();
  private readonly instances = new WeakMap<Fiber, Instance>();
  private readonly latest = new Map<string, Instance>();
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly consumers = new Map<string, Set<Promise<void>>>();
  private readonly listeners = new Map<string, Set<(payload: Json) => void>>();
  private readonly diagnostics = new Map<string, string>();
  private readonly hostDiagnostics: string[] = [];
  private readonly cleanupFailures = new Map<string, string[]>();
  private readonly changes: Array<{ receipt: ChangeStatus; change: ExtensionChange }> = [];
  private readonly receipts: ChangeStatus[] = [];
  private releaseBatch: (() => void) | undefined;
  private batch: Promise<void> | undefined;
  private started = false;
  private closed = false;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  private advancing = false;
  private configuration: ConfigurationWriter | undefined;
  private readonly reserved: Set<string>;
  private readonly artifacts: ArtifactStore | undefined;
  private artifactWatchRoot: string | undefined;
  readonly hmrEnabled: boolean;

  private readonly options: ExtensionHostOptions;
  constructor(options: ExtensionHostOptions) {
    if (options.artifactsDirectory && !path.isAbsolute(options.artifactsDirectory)) throw new Error('artifactsDirectory must be absolute');
    this.artifacts = options.artifactsDirectory ? new ArtifactStore(options.artifactsDirectory) : undefined;
    this.reserved = new Set(options.reservedToolNames ?? []);
    this.hmrEnabled = options.hmr ?? false;
    for (const entry of options.entries) {
      if (!/^[a-zA-Z][\w-]*$/.test(entry.id) || this.entries.has(entry.id)) throw new Error(`Invalid or duplicate extension ID: ${entry.id}`);
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
    this.options = { ...options, entries: structuredClone(options.entries) };
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('Extension host cannot be started twice');
    this.started = true;
    if (this.options.configurationFile) this.configuration = await ConfigurationWriter.open(this.options.configurationFile, this.options.entries, this.hmrEnabled, this.options.artifactsDirectory);
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
  private waitBatch(): Promise<void> { return this.batch ?? Promise.resolve(); }
  private defer(ctx: Context, cleanup: Cleanup): Promise<void> {
    const done = Promise.withResolvers<void>();
    ctx.effect(() => async () => {
      await this.waitBatch();
      try { await cleanup(); } catch (error) { this.recordCleanupFailure(ctx, error); throw error; } finally { done.resolve(); }
    }, 'Mira batch-safe cleanup');
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
        await host.waitBatch();
        await before?.();
        try { await dispose(); } catch (error) { host.recordCleanupFailure(ctx, error); throw error; } finally { done.resolve(); }
      };
    }, 'Mira batch-safe Cordis resource');
    return done.promise;
  }
  private recordCleanupFailure(ctx: Context, error: unknown): void {
    const id = ctx.fiber.entry?.id;
    const message = error instanceof Error ? error.message : String(error);
    if (id) this.cleanupFailures.set(id, [...this.cleanupFailures.get(id) ?? [], message]);
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
    const finished = Promise.withResolvers<void>();
    const dependencies = Object.keys(ctx.fiber.inject).filter(key => key.startsWith('mira.extension.'));
    for (const key of dependencies) {
      let consumers = this.consumers.get(key);
      if (!consumers) this.consumers.set(key, consumers = new Set());
      consumers.add(finished.promise);
    }
    const serviceDrains: Promise<void>[] = [];
    const resourceDrains: Promise<void>[] = [];
    const cleanupDrains: Promise<void>[] = [];
    const provided = new Set<string>();
    const services = new Map<string, unknown>();
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
      registerTool: tool => {
        canRegister();
        const name = tool.name, description = tool.description, parameters = tool.parameters, execute = tool.execute;
        if (!/^[a-zA-Z][\w.-]*$/.test(name) || !description.trim() || parameters.type !== 'object' || typeof execute !== 'function') throw new Error('Invalid extension tool');
        if (this.reserved.has(name) || this.tools.has(name)) throw new Error(`Duplicate registered tool: ${name}`);
        const registered = { extensionId: id, activation, ...(this.entries.get(id)?.generated ? { digest: this.entries.get(id)!.generated!.digest } : {}), tool: { name, description, parameters: structuredClone(parameters), execute: execute.bind(tool) } };
        resourceDrains.push(releaseResource(() => { if (this.tools.get(name) === registered) this.tools.delete(name); }));
        this.tools.set(name, registered);
      },
      emitEvent: async event => { alive(); return this.options.receive(id, validatedEvent(event)); },
      requestWake: async request => {
        alive();
        if (!request.id || !request.reason.trim()) throw new Error('Wake needs a stable ID and reason');
        return this.options.receive(id, validatedEvent(request.event), { id: request.id, reason: request.reason });
      },
      provideService: (name, value) => { canRegister(); const key = serviceKey(name); serviceDrains.push(this.deferNative(ctx, ctx.provide(key, value))); provided.add(key); services.set(key, value); },
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
    const instance = { id, activation, context, fiber: ctx.fiber };
    this.instances.set(ctx.fiber, instance); this.latest.set(id, instance);
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

  /** Accepted, not applied. A tool must not await its own batch's retirement. */
  requestChange(id: string, change: ExtensionChange): ChangeStatus {
    this.assertOpen();
    if (!/^[a-zA-Z][\w-]*$/.test(id)) throw new Error('Invalid extension ID');
    if (!['enable', 'disable', 'reload', 'configure', 'install', 'activate', 'update', 'rollback', 'remove'].includes(change.action)) throw new Error('Unknown extension action');
    if (change.action === 'install') {
      if (this.entries.has(id)) throw new Error(`Extension already installed: ${id}`);
      if (!this.artifacts) throw new Error('Generated extensions require artifactsDirectory');
    } else if (!this.entries.has(id)) throw new Error(`Unknown configured extension: ${id}`);
    if (change.action === 'configure' || ((change.action === 'install' || change.action === 'update') && change.config !== undefined)) validateConfig(change.config!);
    if (change.action === 'install' || change.action === 'update') validateDigest(change.digest);
    if (change.action === 'update' || change.action === 'rollback' || change.action === 'activate') {
      if (!this.entries.get(id)?.generated) throw new Error('Action requires an installed generated extension');
    }
    const receipt: ChangeStatus = { id: randomUUID(), extensionId: id, action: change.action, status: 'accepted', persistence: this.configuration && change.action !== 'reload' ? 'pending' : 'not-required' };
    this.changes.push({ receipt, change: structuredClone(change) }); this.receipts.push(receipt);
    return structuredClone(receipt);
  }
  changeStatus(): ChangeStatus[] { return structuredClone(this.receipts); }
  diagnosticsLog(): string[] { return [...this.hostDiagnostics]; }
  inspect(): ExtensionStatus[] {
    this.assertOpen();
    const names: ExtensionStatus['status'][] = ['waiting', 'loading', 'active', 'failed', 'disposed', 'unloading'];
    return [...this.entries.values()].map(entry => {
      const cordis = this.ctx.loader.store[entry.id];
      return { id: entry.id, path: entry.path, enabled: entry.enabled !== false, config: structuredClone(entry.config ?? null),
        ...(entry.generated ? { generated: structuredClone(entry.generated) } : {}),
        status: entry.enabled === false ? 'disabled' : cordis?.fiber ? names[cordis.fiber.state]! : 'import-failed',
        activation: this.latest.get(entry.id)?.activation ?? null,
        tools: [...this.tools.values()].filter(tool => tool.extensionId === entry.id).map(tool => tool.tool.name),
        diagnostic: this.diagnostics.get(entry.id) ?? (entry.enabled !== false && !cordis?.fiber ? 'Import did not create a plugin; see host diagnostics' : null) };
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
      await this.artifacts!.verify(artifact);
      fresh = entry.enabled === false ? artifact : await this.artifacts!.prepareFreshActivation(artifact);
    } catch (error) {
      // Old cleanup runs after desired config is saved and may change ordinary
      // files. Revoke earlier evidence if activation-time verification fails.
      if (receipt) { receipt.artifact = 'failed'; receipt.test = 'invalidated'; }
      throw error;
    }
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
        await this.artifacts!.verify(artifact);
        desired.path = artifact.entry;
        receipt.artifact = 'verified'; receipt.digest = artifact.digest; receipt.revision = desired.generated.revision;
        const test = await this.artifacts!.testResult(artifact);
        receipt.test = test ? (test.passed ? 'passed' : 'failed') : 'not-run';
      } catch (error) { receipt.artifact = 'failed'; throw error; }
    }
    return desired;
  }

  private release(): void { const release = this.releaseBatch; this.batch = undefined; this.releaseBatch = undefined; release?.(); }
  private async advance(): Promise<void> {
    this.release();
    await this.ctx.loader.await();
    while (this.changes.length) {
      const { receipt, change } = this.changes.shift()!;
      this.cleanupFailures.delete(receipt.extensionId);
      try {
        const id = receipt.extensionId;
        const desired = await this.desiredEntry(id, change, receipt);
        if (this.configuration && change.action !== 'reload') {
          try { await this.configuration.replace(id, desired); receipt.persistence = 'saved'; }
          catch (error) { receipt.persistence = 'failed'; throw error; }
        }
        this.diagnostics.delete(id);
        if (desired === null) {
          try { await this.removeRuntime(id); }
          finally { this.entries.delete(id); this.latest.delete(id); }
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
          const state = this.inspect().find(item => item.id === id)!;
          if (state.status === 'failed' || state.status === 'import-failed') throw new Error(state.diagnostic ?? `Extension ${state.status}`);
        }
        receipt.status = 'applied';
      } catch (error) { if (receipt.persistence === 'pending') receipt.persistence = 'not-attempted'; receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : String(error); }
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
      const failures = this.cleanupFailures.get(receipt.extensionId);
      if (failures?.length) {
        receipt.cleanup = 'failed'; receipt.status = 'failed';
        receipt.error ??= `Cleanup failed: ${failures.join('; ')}`;
      }
    }
    await this.ctx.loader.await();
  }
  /** Release the previous entire batch, settle known lifecycle work, then capture
   * a generation without an intervening await. Watcher delivery may occur later;
   * it does not make an explicit activation request nondeterministic. */
  async prepare(): Promise<RegisteredTool[]> {
    this.assertOpen();
    if (this.advancing) throw new Error('Concurrent extension boundary');
    this.advancing = true;
    try {
      await this.advance();
      this.batch = new Promise(resolve => { this.releaseBatch = resolve; });
      return [...this.tools.values()].map(tool => ({ ...tool, tool: { ...tool.tool, parameters: structuredClone(tool.tool.parameters) } }));
    } finally { this.advancing = false; }
  }
  /** Terminal/error cleanup never reopens a finished cognition turn. */
  async finish(): Promise<void> {
    this.assertOpen();
    if (this.advancing) throw new Error('Concurrent extension boundary');
    this.advancing = true;
    try { await this.advance(); } finally { this.advancing = false; }
  }
  close(): Promise<void> {
    if (this.closeTask) return this.closeTask;
    this.release();
    this.closing = true;
    this.closeTask = (async () => {
      try { await this.ctx.fiber.dispose(); } finally { this.closed = true; this.closing = false; }
    })();
    return this.closeTask;
  }
}
function validatedEvent(event: ExtensionEvent): ExtensionEvent {
  if (!event.id || !event.type || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error('Event requires a stable ID, type and timestamp');
  return { id: event.id, type: event.type, occurredAt: event.occurredAt, payload: structuredClone(event.payload) };
}
export type { ExtensionEvent, ExtensionWake, ExtensionTool, Json };

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
