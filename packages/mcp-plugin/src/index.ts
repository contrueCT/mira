import { createHash } from 'node:crypto';
import { defineExtension, type ExtensionContext, type ExtensionConnectionStatus, type ExtensionToolset, type Json, type ExtensionSettingsActions } from '@mira/extension-sdk';
import { SdkError, SdkErrorCode, StreamableHTTPClientTransport, type Tool } from '@modelcontextprotocol/client';
import { parseConfig, type McpConfig } from './config.ts';
import { createConnection, remoteTools, resultProjection } from './client.ts';
import { OAuthSession, safeOAuthFetch } from './oauth.ts';

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
  private code: ExtensionConnectionStatus['code'];
  private authorization: string | null = null;
  private stopped = false;
  private readonly calls = new Set<Promise<unknown>>();
  constructor(context: ExtensionContext, raw: Json) {
    this.context = context; this.config = parseConfig(raw); this.toolset = context.registerToolset([]);
    if (this.config.auth === 'oauth' && this.config.url) this.oauth = new OAuthSession(context.credentials, this.config.url, {
      ...(this.config.redirectUrl ? { redirectUrl: this.config.redirectUrl } : {}), ...(this.config.callbackPort === undefined ? {} : { callbackPort: this.config.callbackPort }),
    }, url => { this.authorization = url; if (url) this.state = 'pending'; });
    context.onCleanup(() => this.close());
    const actions = context.registerSettings({
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
        { id: 'forgetAuthorization', label: 'Forget authorization', group: 'secondary', execute: async () => { await this.disconnect(); await this.oauth?.forget(); } },
      ], status: () => this.status(),
    });
    this.registerControl(actions);
  }
  private configured(): boolean { return Boolean(this.config.transport === 'stdio' ? this.config.command : this.config.url); }
  private status(): ExtensionConnectionStatus {
    return { state: this.state, ...(this.code ? { code: this.code } : {}), visibleActions: !this.configured() ? [] : this.state === 'connected' ? ['refresh', 'disconnect', ...(this.oauth ? ['forgetAuthorization'] : [])] : this.state === 'connecting' || this.state === 'pending' ? [] : ['connect', ...(this.oauth ? ['authorize', 'forgetAuthorization'] : [])],
      ...(this.code === 'configuration' ? { details: [{ label: 'Protocol', value: 'Check the server protocol choice. Local servers default to legacy; modern-only servers require 2026-07-28.' }] } : {}),
      ...(this.authorization ? { authorization: { url: this.authorization, label: 'Authorize MCP access', qr: true } } : {}) };
  }
  private registerControl(actions: ExtensionSettingsActions): void {
    this.context.registerTool({ name: `mcp_control_${createHash('sha256').update(this.context.id).digest('hex').slice(0,24)}`, description: 'Manage this MCP installation’s connection through its existing protected settings actions. Returns only safe operation receipts. OAuth links and credentials are shown only in Settings. Installation/configuration/update/disable/remove/rollback use ordinary extension_manage.',
      parameters: { type: 'object', properties: { operation: { type: 'string', enum: ['start', 'current', 'cancel'] }, action: { type: 'string', enum: ['connect', 'authorize', 'refresh', 'disconnect', 'forgetAuthorization'] }, operationId: { type: 'string' } }, required: ['operation'], additionalProperties: false },
      execute: async raw => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { text: 'Invalid connection operation.', isError: true };
        try {
          let result;
          if (raw['operation'] === 'start' && typeof raw['action'] === 'string') result = await actions.start(raw['action']);
          else if (raw['operation'] === 'current') result = await actions.current();
          else if (raw['operation'] === 'cancel' && typeof raw['operationId'] === 'string') { await actions.cancel(raw['operationId']); result = { cancelled: true }; }
          else return { text: 'Invalid connection operation.', isError: true };
          return { text: JSON.stringify(result) };
        } catch { return { text: 'Connection operation unavailable. Check this extension’s protected settings.', isError: true }; }
      },
    });
  }
  async initialize(): Promise<void> {
    if (!this.configured()) { this.state = 'unconfigured'; return; }
    // Enabled installations reconnect. Disabled ones never instantiate us.
    try { await this.connect(new AbortController().signal, false); } catch { /* Safe state remains visible in existing settings. */ }
  }
  private publish(connection: Connection, generation: number, tools: Tool[]): void {
    if (this.stopped || generation !== this.generation || this.connection !== connection) return;
    this.toolset.replace(remoteTools(this.context.id, tools, this.config, async (tool, args, signal) => {
      // Host revisions fence old unbegun declarations; this closure pins the
      // connection and exact remote definition for an already begun call.
      const task = connection.client.callTool({ name: tool.name, arguments: args as Record<string, unknown> }, { signal, timeout: 30_000, toolDefinition: tool });
      this.calls.add(task);
      try { return resultProjection(await task); }
      finally { this.calls.delete(task); }
    }));
  }
  private async open(signal: AbortSignal, interactive: boolean, fetch?: typeof globalThis.fetch): Promise<Connection> {
    const generation = ++this.generation;
    const connection = await createConnection(this.context, this.config, {
      ...(this.oauth ? { oauth: this.oauth.provider } : {}), interactive, ...(fetch ? { fetch } : {}),
      changed: (error, tools) => {
        if (generation !== this.generation || this.stopped) return;
        try { if (error || !tools) throw new Error('Tool refresh failed'); this.publish(connection, generation, tools); }
        catch { this.toolset.replace([]); this.state = 'error'; this.code = 'configuration'; }
      },
      closed: () => { if (generation === this.generation && !this.stopped) { this.toolset.replace([]); this.state = 'disconnected'; } },
    });
    this.connection = connection;
    await connection.client.connect(connection.transport, { signal, timeout: 15_000 });
    return connection;
  }
  private async connect(signal: AbortSignal, interactive: boolean): Promise<void> {
    if (!this.configured() || this.stopped) throw new Error('MCP is not configured');
    await this.disconnect(); signal.throwIfAborted(); this.state = 'connecting'; this.code = undefined;
    try {
      if (interactive) {
        if (!this.oauth) throw new Error('OAuth is not configured');
        await this.oauth.run(signal, async (_provider, waitForCallback, attemptSignal) => {
          try { await this.open(attemptSignal, true, safeOAuthFetch(globalThis.fetch, attemptSignal)); }
          catch {
            if (!this.authorization || !this.connection || !(this.connection.transport instanceof StreamableHTTPClientTransport)) throw new Error('MCP authorization unavailable');
            const callback = await waitForCallback();
            await this.connection.transport.finishAuth(callback);
          }
        });
        // Interactive authentication never remains attached to effect requests.
        await this.disconnect();
      }
      const connection = await this.open(signal, false);
      this.publish(connection, this.generation, (await connection.client.listTools(undefined, { signal, timeout: 15_000 })).tools);
      signal.throwIfAborted(); this.state = 'connected';
    } catch (error) {
      await this.disconnect(); this.state = 'error'; this.code = error instanceof SdkError && error.code === SdkErrorCode.EraNegotiationFailed ? 'configuration' : this.config.auth === 'none' ? 'network' : 'authentication';
      throw new Error('MCP connection failed. Check configuration and protected authentication settings.');
    }
  }
  private async refresh(signal: AbortSignal): Promise<void> {
    const connection = this.connection, generation = this.generation;
    if (!connection || this.state !== 'connected') throw new Error('MCP is disconnected');
    try { this.publish(connection, generation, (await connection.client.listTools(undefined, { signal, timeout: 15_000, cacheMode: 'refresh' })).tools); }
    catch { if (generation === this.generation) { this.toolset.replace([]); this.state = 'error'; this.code = 'network'; } throw new Error('MCP tools could not be refreshed'); }
  }
  private async disconnect(): Promise<void> {
    ++this.generation; this.toolset.replace([]);
    const connection = this.connection; this.connection = undefined;
    await Promise.allSettled([...this.calls]);
    await connection?.client.close(); this.authorization = null; this.state = 'disconnected';
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
