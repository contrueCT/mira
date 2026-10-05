import { ConfigurationWriter } from './configuration.ts';
export { readExtensionConfiguration } from './configuration.ts';
export type { ExtensionConfiguration } from './configuration.ts';
import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
}
export interface ExtensionHostOptions {
  entries: LocalExtensionEntry[];
  reservedToolNames?: string[];
  /** Identity is bound by the host; extension-supplied source fields are ignored. */
  receive(source: string, event: ExtensionEvent, wake?: { id: string; reason: string }): Promise<'inserted' | 'duplicate'>;
  hmr?: boolean;
  /** Optional same-file desired configuration persistence; otherwise runtime-only. */
  configurationFile?: string;
}
export interface RegisteredTool { extensionId: string; activation: string; tool: ExtensionTool }
export interface ExtensionStatus {
  id: string; path: string; enabled: boolean; config: Json;
  status: 'disabled' | 'import-failed' | 'waiting' | 'loading' | 'active' | 'failed' | 'disposed' | 'unloading';
  activation: string | null; tools: string[]; diagnostic: string | null;
}
export type ExtensionChange = { action: 'enable' | 'disable' | 'reload' } | { action: 'configure'; config: Json };
export interface ChangeStatus { id: string; extensionId: string; action: ExtensionChange['action']; status: 'accepted' | 'applied' | 'failed'; persistence: 'pending' | 'saved' | 'failed' | 'not-required'; error?: string }
interface Instance { id: string; activation: string; context: ExtensionContext; fiber: Fiber }

/** Cordis owns dependency/lifecycle/HMR state. This coordinator only protects
 * a published model/tool batch and queues explicit, configured local changes. */
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
  readonly hmrEnabled: boolean;

  private readonly options: ExtensionHostOptions;
  constructor(options: ExtensionHostOptions) {
    this.reserved = new Set(options.reservedToolNames ?? []);
    this.hmrEnabled = options.hmr ?? false;
    for (const entry of options.entries) {
      if (!/^[a-zA-Z][\w-]*$/.test(entry.id) || this.entries.has(entry.id)) throw new Error(`Invalid or duplicate extension ID: ${entry.id}`);
      if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') throw new Error('Extension enabled must be boolean');
      if (!path.isAbsolute(entry.path)) throw new Error(`Extension path must be absolute: ${entry.id}`);
      validateConfig(entry.config ?? null);
      this.entries.set(entry.id, { ...entry, config: structuredClone(entry.config ?? null) });
    }
    this.options = { ...options, entries: structuredClone(options.entries) };
  }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error('Extension host cannot be started twice');
    this.started = true;
    if (this.options.configurationFile) this.configuration = await ConfigurationWriter.open(this.options.configurationFile, this.options.entries, this.hmrEnabled);
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
    for (const entry of this.entries.values()) {
      // The configured identity is stable even though Cordis code instances change.
      entry.path = await realpath(entry.path);
      if (!(await stat(entry.path)).isFile()) throw new Error(`Extension is not a file: ${entry.id}`);
      const config: EntryOptions = { id: entry.id, name: pathToFileURL(entry.path).href, config: entry.config, disabled: entry.enabled === false, inject: ['timer'] };
      await this.ctx.loader.create(config);
    }
    await this.ctx.loader.await();
    if (this.hmrEnabled) {
      if (!this.ctx.loader.internal) throw new Error('Source HMR requires Node --expose-internals; native addons are not installed');
      // Watch only explicitly trusted extension directories, never Memory/State.
      await this.ctx.plugin(Hmr, { root: [...new Set([...this.entries.values()].map(entry => path.dirname(entry.path)))], ignored: ['**/node_modules/**', '**/.git/**'], debounce: 30 });
    }
  }

  private assertOpen(): void { if (!this.started || this.closed || this.closing) throw new Error('Extension host is not running'); }
  private waitBatch(): Promise<void> { return this.batch ?? Promise.resolve(); }
  private defer(ctx: Context, cleanup: Cleanup): Promise<void> {
    const done = Promise.withResolvers<void>();
    ctx.effect(() => async () => {
      await this.waitBatch();
      try { await cleanup(); } finally { done.resolve(); }
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
        try { await dispose(); } finally { done.resolve(); }
      };
    }, 'Mira batch-safe Cordis resource');
    return done.promise;
  }
  private apiFor(ctx: Context): ExtensionContext {
    const prior = this.instances.get(ctx.fiber);
    if (prior) return prior.context;
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
    const context: ExtensionContext = {
      id,
      registerTool: tool => {
        alive();
        if (!/^[a-zA-Z][\w.-]*$/.test(tool.name) || !tool.description.trim() || tool.parameters.type !== 'object' || typeof tool.execute !== 'function') throw new Error('Invalid extension tool');
        if (this.reserved.has(tool.name) || this.tools.has(tool.name)) throw new Error(`Duplicate registered tool: ${tool.name}`);
        const registered = { extensionId: id, activation, tool: { ...tool, parameters: structuredClone(tool.parameters) } };
        this.tools.set(tool.name, registered);
        resourceDrains.push(releaseResource(() => { if (this.tools.get(tool.name) === registered) this.tools.delete(tool.name); }));
      },
      emitEvent: async event => { alive(); return this.options.receive(id, validatedEvent(event)); },
      requestWake: async request => {
        alive();
        if (!request.id || !request.reason.trim()) throw new Error('Wake needs a stable ID and reason');
        return this.options.receive(id, validatedEvent(request.event), { id: request.id, reason: request.reason });
      },
      provideService: (name, value) => { alive(); const key = serviceKey(name); serviceDrains.push(this.deferNative(ctx, ctx.provide(key, value))); provided.add(key); services.set(key, value); },
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
      onCleanup: cleanup => { alive(); cleanupDrains.push(this.defer(ctx, async () => { await drainDependencies(); await Promise.all(resourceDrains); await cleanup(); })); },
      onEvent: (name, listener) => {
        alive();
        let listeners = this.listeners.get(name);
        if (!listeners) this.listeners.set(name, listeners = new Set());
        listeners.add(listener);
        resourceDrains.push(releaseResource(() => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(name); }));
      },
      publish: (name, payload) => { alive(); for (const listener of this.listeners.get(name) ?? []) listener(structuredClone(payload)); },
      interval: (callback, milliseconds) => {
        alive();
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
    if (!this.entries.has(id)) throw new Error(`Unknown configured extension: ${id}`);
    if (!['enable', 'disable', 'reload', 'configure'].includes(change.action)) throw new Error('Unknown extension action');
    if (change.action === 'configure') validateConfig(change.config);
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
      const cordis = this.ctx.loader.resolve(entry.id);
      return { id: entry.id, path: entry.path, enabled: !cordis.disabled, config: structuredClone(entry.config ?? null),
        status: cordis.disabled ? 'disabled' : cordis.fiber ? names[cordis.fiber.state]! : 'import-failed',
        activation: this.latest.get(entry.id)?.activation ?? null,
        tools: [...this.tools.values()].filter(tool => tool.extensionId === entry.id).map(tool => tool.tool.name),
        diagnostic: this.diagnostics.get(entry.id) ?? (!cordis.disabled && !cordis.fiber ? 'Import did not create a plugin; see host diagnostics' : null) };
    });
  }

  private release(): void { const release = this.releaseBatch; this.batch = undefined; this.releaseBatch = undefined; release?.(); }
  private async advance(): Promise<void> {
    this.release();
    await this.ctx.loader.await();
    while (this.changes.length) {
      const { receipt, change } = this.changes.shift()!;
      try {
        if (this.configuration && change.action !== 'reload') {
          try { await this.configuration.save(receipt.extensionId, change); receipt.persistence = 'saved'; }
          catch (error) { receipt.persistence = 'failed'; throw error; }
        }
        const desired = this.entries.get(receipt.extensionId)!;
        if (change.action === 'configure') desired.config = structuredClone(change.config);
        else if (change.action !== 'reload') desired.enabled = change.action === 'enable';
        const entry = this.ctx.loader.resolve(receipt.extensionId);
        this.diagnostics.delete(receipt.extensionId);
        if (change.action === 'reload') {
          // This restarts the currently imported module. File code changes use
          // official HMR, not an invented import cache or rollback mechanism.
          if (entry.disabled) throw new Error('Enable a disabled extension before restarting it');
          if (entry.fiber) await entry.fiber.update(entry.fiber.config, true); else await entry.init();
        } else await this.ctx.loader.update(entry.id, change.action === 'configure' ? { config: change.config } : { disabled: change.action === 'disable' });
        await this.ctx.loader.await();
        const state = this.inspect().find(item => item.id === receipt.extensionId)!;
        if (state.status === 'failed' || state.status === 'import-failed') throw new Error(state.diagnostic ?? `Extension ${state.status}`);
        receipt.status = 'applied';
      } catch (error) { receipt.status = 'failed'; receipt.error = error instanceof Error ? error.message : String(error); }
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
    // Cordis interprets this key as executable configuration. Manual JSON settings
    // must not turn configure into a generated-code activation path.
    if ('__jsExpr' in value) throw new Error('Executable Cordis config expressions are not supported');
    for (const item of Object.values(value)) validateConfig(item);
    return;
  }
  throw new Error('Extension config must be plain finite JSON');
}
