import { defineExtension, type ExtensionContext, type ExtensionConnectionStatus, type ExtensionToolset, type Json } from '@mira/extension-sdk';
import { SdkError, SdkErrorCode, StreamableHTTPClientTransport, auth, computeScopeUnion, isStrictScopeSuperset, type Tool } from '@modelcontextprotocol/client';
import { parseConfig, type McpConfig } from './config.ts';
import { createConnection, remoteTools, resultProjection } from './client.ts';
import { OAuthSession, safeOAuthFetch } from './oauth.ts';

class CatalogError extends Error {
  readonly code: 'name_conflict' | 'invalid_tools';
  constructor(message: string, code: 'name_conflict' | 'invalid_tools' = 'invalid_tools') { super(message); this.code = code; }
}

type Connection = Awaited<ReturnType<typeof createConnection>>;
/** One ordinary extension activation owns exactly one configured MCP server. */
class McpInstallation {
  private readonly context: ExtensionContext;
  private readonly config: McpConfig;
  private readonly toolset: ExtensionToolset;
  private readonly oauth: OAuthSession | undefined;
  private connection: Connection | undefined;
  private generation = 0;
  private state: ExtensionConnectionStatus['state'] = 'disconnected';
  private catalogError: string | undefined;
  private code: ExtensionConnectionStatus['code'];
  private authorization: string | null = null;
  private challenge: { scope?: string; resourceMetadataUrl?: URL } | undefined;
  private stopped = false;
  private catalog: Promise<void> = Promise.resolve();
  private catalogRefresh: Promise<void> | undefined;
  private catalogDirty = false;
  private readonly calls = new Set<Promise<unknown>>();
  constructor(context: ExtensionContext, raw: Json) {
    this.context = context; this.config = parseConfig(raw); this.toolset = context.registerToolset([]);
    if (this.config.auth === 'oauth' && this.config.url) this.oauth = new OAuthSession(context.credentials, this.config.url, {
      ...(this.config.redirectUrl ? { redirectUrl: this.config.redirectUrl } : {}), ...(this.config.callbackPort === undefined ? {} : { callbackPort: this.config.callbackPort }),
    }, url => { this.authorization = url; if (url) this.state = 'pending'; });
    context.onCleanup(() => this.close());
    context.registerSettings({
      fields: [
        { key: 'transport', label: 'Transport', type: 'select', options: [{ value: 'stdio', label: 'Local executable' }, { value: 'http', label: 'Remote HTTP' }] },
        { key: 'command', label: 'Installed executable (absolute path)', type: 'text' },
        { key: 'argsJson', label: 'Arguments (JSON array; no secrets)', type: 'text' },
        { key: 'cwd', label: 'Working directory (absolute path)', type: 'text' },
        { key: 'url', label: 'Remote MCP URL', type: 'text' },
        { key: 'protocol', label: 'Server protocol (local default: legacy)', type: 'select', options: [{ value: 'legacy', label: 'Legacy (2025 servers)' }, { value: '2026-07-28', label: 'Modern (2026-07-28)' }, { value: 'auto', label: 'Automatic (HTTP only)' }] },
        { key: 'auth', label: 'HTTP authentication', type: 'select', options: [{ value: 'none', label: 'None' }, { value: 'bearer', label: 'Bearer token' }, { value: 'oauth', label: 'OAuth' }] },
        { key: 'bearerToken', label: 'Bearer token', type: 'secret' },
        { key: 'redirectUrl', label: 'OAuth callback URL (default requires browser on this computer)', type: 'text' },
        { key: 'callbackPort', label: 'Local OAuth callback port (default 37391)', type: 'text' },
        { key: 'toolsJson', label: 'Selected remote tool names (JSON array; empty means all)', type: 'text' },
        ...Object.entries(this.config.envSecrets).map(([name, key]) => ({ key, label: `Server environment: ${name}`, type: 'secret' as const })),
      ],
      actions: [
        { id: 'connect', label: 'Connect', group: 'primary', execute: ({ signal }) => this.connect(signal, false) },
        { id: 'authorize', label: 'Authorize', group: 'primary', execute: ({ signal }) => this.connect(signal, true) },
        { id: 'refresh', label: 'Refresh tools', group: 'secondary', execute: ({ signal }) => this.refresh(signal) },
        { id: 'disconnect', label: 'Disconnect', group: 'secondary', execute: () => this.disconnect() },
        { id: 'forgetAuthorization', label: 'Forget authorization', group: 'secondary', execute: async () => { await this.disconnect(); await this.oauth?.forget(); this.challenge = undefined; } },
      ], status: () => this.status(),
    });
  }
  private configured(): boolean { return Boolean(this.config.transport === 'stdio' ? this.config.command : this.config.url); }
  private status(): ExtensionConnectionStatus {
    return { state: this.state, ...(this.code ? { code: this.code } : {}), visibleActions: !this.configured() ? [] : this.connection && (this.state === 'connected' || this.catalogError) ? ['refresh', 'disconnect', ...(this.oauth ? ['authorize', 'forgetAuthorization'] : [])] : this.state === 'connecting' || this.state === 'pending' ? [] : ['connect', ...(this.oauth ? ['authorize', 'forgetAuthorization'] : [])],
      ...(this.catalogError ? { details: [{ label: 'Tools', value: this.catalogError }] } : this.code === 'configuration' ? { details: [{ label: 'Protocol', value: 'Check the server protocol choice. Local servers default to legacy; modern-only servers require 2026-07-28.' }] } : {}),
      ...(!this.catalogError && this.connection?.client.unsupportedHeaderTools ? { details: [{ label: 'Unsupported tools', value: 'Some tools require HTTP header mapping, which is not supported by this plugin.' }] } : {}),
      ...(this.authorization ? { authorization: { url: this.authorization, label: 'Authorize MCP access', qr: true } } : {}) };
  }
  async initialize(): Promise<void> {
    if (!this.configured()) { this.state = 'unconfigured'; return; }
    // Enabled installations reconnect. Disabled ones never instantiate us.
    try { await this.connect(new AbortController().signal, false); } catch { /* Safe state remains visible in existing settings. */ }
  }
  private withdraw(): void {
    // An empty candidate cannot fail validation. A retired/closing Host may
    // reject publication before its plugin cleanup runs; still finish closing
    // the owned client and never throw from an SDK notification callback.
    try { this.toolset.replace([]); } catch { /* Host admission is already fenced. */ }
  }
  private publish(connection: Connection, generation: number, tools: Tool[]): void {
    if (this.stopped || generation !== this.generation || this.connection !== connection) return;
    try { this.toolset.replace(remoteTools(tools, this.config, async (tool, args, signal) => {
      // Host revisions fence old unbegun declarations; this closure pins the
      // connection and exact remote definition for an already begun call.
      const task = connection.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, { signal, timeout: 30_000, toolDefinition: tool });
      this.calls.add(task);
      try { return resultProjection(await task); }
      finally { this.calls.delete(task); }
    })); } catch (error) {
      const message = error instanceof Error ? error.message : '';
      throw new CatalogError(message.includes('uplicate') ? 'Duplicate tool name. Each tool must have a unique name across all installed extensions and built-in tools.'
        : message.includes('tool name') ? 'Invalid tool name. Use 1-64 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore. Server names are used unchanged.'
        : 'Invalid MCP tool catalog. Check the server tool definitions. The previous tools remain unchanged.', message.includes('uplicate') ? 'name_conflict' : 'invalid_tools');
    }
  }
  private async open(signal: AbortSignal, interactive: boolean, fetch?: typeof globalThis.fetch): Promise<Connection> {
    const generation = ++this.generation;
    const connection = await createConnection(this.context, this.config, {
      ...(this.oauth ? { oauth: this.oauth.provider } : {}), interactive, ...(fetch ? { fetch } : {}),
      challenged: challenge => { if (generation === this.generation && !this.stopped) this.challenge = challenge; },
      changed: () => { if (!interactive) this.scheduleCatalog(connection, generation); },
      closed: () => { if (generation === this.generation && !this.stopped) { this.withdraw(); this.state = 'disconnected'; } },
    });
    this.connection = connection;
    await connection.client.connect(connection.transport, { signal, timeout: 15_000 });
    return connection;
  }
  private async connect(signal: AbortSignal, interactive: boolean): Promise<void> {
    if (!this.configured() || this.stopped) throw new Error('MCP is not configured');
    await this.disconnect(); signal.throwIfAborted(); this.state = 'connecting'; this.code = undefined; this.catalogError = undefined;
    try {
      if (interactive) {
        if (!this.oauth) throw new Error('OAuth is not configured');
        const challenge = this.challenge;
        await this.oauth.run(signal, async (provider, waitForCallback, attemptSignal) => {
          if (challenge) {
            // The effect is never replayed. Only this explicit action may use
            // its private challenge to drive the SDK's authorization flow.
            const tokens = await provider.tokens();
            const scope = computeScopeUnion(tokens?.scope, challenge.scope);
            const options = { serverUrl: this.config.url, ...(scope ? { scope } : {}),
              ...(challenge.resourceMetadataUrl ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}),
              fetchFn: safeOAuthFetch(globalThis.fetch, attemptSignal), forceReauthorization: isStrictScopeSuperset(scope, tokens?.scope) };
            if (await auth(provider, options) === 'REDIRECT') {
              const callback = await waitForCallback();
              if (await auth(provider, { ...options, authorizationCode: callback.get('code')!,
                ...(callback.has('iss') ? { iss: callback.get('iss')! } : {}) }) !== 'AUTHORIZED') throw new Error('MCP authorization unavailable');
            }
            return;
          }
          try {
            const connection = await this.open(attemptSignal, true, safeOAuthFetch(globalThis.fetch, attemptSignal));
            // A server may expose discovery publicly but protect tools/list.
            // This explicit authorization attempt performs only non-effect reads.
            await connection.client.listTools(undefined, { signal: attemptSignal, timeout: 15_000 });
          }
          catch {
            if (!this.authorization || !this.connection || !(this.connection.transport instanceof StreamableHTTPClientTransport)) throw new Error('MCP authorization unavailable');
            const callback = await waitForCallback();
            await this.connection.transport.finishAuth(callback);
          }
        });
        if (this.challenge === challenge) this.challenge = undefined;
        // Interactive authentication never remains attached to effect requests.
        await this.disconnect();
      }
      const connection = await this.open(signal, false);
      await this.queueCatalog(connection, this.generation, signal);
      signal.throwIfAborted(); this.state = 'connected';
    } catch (error) {
      await this.disconnect(); this.state = 'error'; this.catalogError = error instanceof CatalogError ? error.message : undefined; this.code = error instanceof CatalogError ? error.code : error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed ? 'configuration' : this.config.auth === 'none' ? 'network' : 'authentication';
      throw new Error('MCP connection failed. Check configuration and protected authentication settings.');
    }
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    const connection = this.connection, generation = this.generation;
    if (!connection || (this.state !== 'connected' && !this.catalogError)) throw new Error('MCP is disconnected');
    try { await this.queueCatalog(connection, generation, signal); }
    catch (error) { if (generation === this.generation) this.catalogFailed(error); throw new Error('MCP tools could not be refreshed. Check protected settings.'); }
  }
  private queueCatalog(connection: Connection, generation: number, signal: AbortSignal): Promise<void> {
    const task = this.catalog.then(async () => {
      signal.throwIfAborted();
      if (this.stopped || generation !== this.generation || this.connection !== connection) throw new Error('MCP connection retired');
      const previousHeaderTools = connection.client.unsupportedHeaderTools;
      // One serialized listing may contain several pages. Accumulate the notice
      // across those pages, and commit it only with a valid complete catalog.
      connection.client.unsupportedHeaderTools = false;
      try {
        const result = await connection.client.listTools(undefined, { signal, timeout: 15_000, cacheMode: 'refresh' });
        signal.throwIfAborted(); this.publish(connection, generation, result.tools);
        if (!this.stopped && generation === this.generation && this.connection === connection) { this.state = 'connected'; this.code = undefined; this.catalogError = undefined; }
      } catch (error) {
        connection.client.unsupportedHeaderTools = previousHeaderTools;
        if (error instanceof SdkError && (error.code === SdkErrorCode.InvalidResult || error.code === SdkErrorCode.ListPaginationExceeded)) {
          throw new CatalogError('Invalid MCP tool catalog. Check the server tool definitions. The previous tools remain unchanged.');
        }
        throw error;
      }
    });
    this.catalog = task.catch(() => {});
    return task;
  }
  private scheduleCatalog(connection: Connection, generation: number): void {
    if (this.stopped || generation !== this.generation || this.connection !== connection) return;
    this.catalogDirty = true;
    if (this.catalogRefresh) return;
    const task = (async () => {
      // At most one queued automatic refresh plus a dirty bit, not one promise
      // per notification. Initial/manual/automatic reads share publication order.
      while (this.catalogDirty && generation === this.generation && !this.stopped) {
        this.catalogDirty = false;
        await this.queueCatalog(connection, generation, new AbortController().signal);
      }
    })();
    this.catalogRefresh = task;
    void task.catch(error => {
      if (generation === this.generation && !this.stopped) this.catalogFailed(error);
    }).finally(() => {
      if (this.catalogRefresh !== task) return;
      this.catalogRefresh = undefined;
      // A failed request must not discard a newer notification received while
      // it was pending. No dirty bit means no automatic retry of the failure.
      if (this.catalogDirty) this.scheduleCatalog(connection, generation);
    });
  }
  private catalogFailed(error: unknown): void {
    this.catalogError = error instanceof CatalogError ? error.message : undefined;
    if (!this.catalogError) this.withdraw();
    this.state = 'error'; this.code = error instanceof CatalogError ? error.code : 'network';
  }
  private async disconnect(): Promise<void> {
    ++this.generation; this.catalogDirty = false; this.catalogRefresh = undefined; this.withdraw();
    const connection = this.connection; this.connection = undefined;
    await Promise.allSettled([...this.calls]);
    await connection?.client.close(); this.authorization = null; this.catalogError = undefined; this.code = undefined; this.state = 'disconnected';
  }
  async close(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true; ++this.generation;
    // Host already withdrew declarations and drained actual tool leases.
    await Promise.allSettled([...this.calls]);
    const connection = this.connection; this.connection = undefined;
    await connection?.client.close();
  }
}
export default defineExtension({ name: 'mira-mcp-plugin', async apply(context, config) { await new McpInstallation(context, config).initialize(); } });
