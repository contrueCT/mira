import { createOutputSchemaValidator } from './output-schema.ts';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport, extractWWWAuthenticateParams, type OAuthClientProvider, type Tool, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ExtensionContext, ExtensionTool, Json } from '@mira/extension-sdk';
import type { McpConfig } from './config.ts';

// Official documented subclass behavior probes this owned instance in place,
// avoiding an extra server launch even for pinned modern negotiation.
class OwnedStdioTransport extends StdioClientTransport {}
// Use only the public request boundary. SDK 2.3.1's high-level list validator
// prints raw header annotations to console and offers no per-client logger.
// Header mirroring is outside this plugin's first-version capability set.
class PrivateClient extends Client {
  unsupportedHeaderTools = false;
  override request: Client['request'] = (async (...args: Parameters<Client['request']>) => {
    const result = await super.request(...args);
    if (args[0].method === 'tools/list' && result && typeof result === 'object' && 'tools' in result && Array.isArray(result.tools)) {
      result.tools = result.tools.filter((tool: Tool) => {
        const pending: unknown[] = [tool.inputSchema];
        while (pending.length) {
          const value = pending.pop();
          if (!value || typeof value !== 'object') continue;
          if (Object.hasOwn(value, 'x-mcp-header')) { this.unsupportedHeaderTools = true; return false; }
          pending.push(...Object.values(value));
        }
        return true;
      });
    }
    return result;
  }) as Client['request'];
}

export function resultProjection(result: CallToolResult): Awaited<ReturnType<ExtensionTool['execute']>> {
  const unsupported = result.content.filter(item => item.type !== 'text').map(item => item.type);
  const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
  const structured = result.structuredContent === undefined ? undefined : JSON.stringify(result.structuredContent);
  return {
    text: [...(text ? [text] : []), ...(unsupported.length ? [`MCP returned unsupported content types: ${[...new Set(unsupported)].join(', ')}. These contents were not delivered; the remote call may have completed.`] : []), ...(structured !== undefined && structured !== text ? [structured] : [])].join('\n'),
    details: { ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent as Json } : {}), ...(unsupported.length ? { unsupportedContentTypes: unsupported } : {}) },
    isError: result.isError === true || unsupported.length > 0,
  };
}
export async function createConnection(context: ExtensionContext, config: McpConfig, options: {
  changed(): void;
  closed(): void;
  challenged?(challenge: { scope?: string; resourceMetadataUrl?: URL }): void;
  oauth?: OAuthClientProvider;
  interactive?: boolean;
  fetch?: typeof globalThis.fetch;
}) {
  const client = new PrivateClient({ name: 'mira-mcp-plugin', version: '0.0.0' }, {
    capabilities: {}, inputRequired: { autoFulfill: false }, jsonSchemaValidator: createOutputSchemaValidator(),
    versionNegotiation: { mode: config.protocol === '2026-07-28' ? { pin: config.protocol } : config.protocol, probe: { timeoutMs: 10_000, maxRetries: 0 } },
    ...(!options.interactive ? { listChanged: { tools: { autoRefresh: false, onChanged: options.changed } } } : {}),
    listMaxPages: 16,
  });
  client.onerror = () => {}; // SDK/provider diagnostics may contain credentials.
  client.onclose = options.closed;
  let transport;
  if (config.transport === 'stdio') {
    if (process.platform === 'win32') throw new Error('Owned MCP stdio process groups require POSIX');
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '/usr/bin:/bin' };
    for (const [key, secret] of Object.entries(config.envSecrets)) {
      const value = await context.credentials.get(secret);
      if (value === null) throw new Error('MCP environment credential is missing');
      env[key] = value;
    }
    env['MIRA_MCP_ENV_KEYS'] = JSON.stringify(Object.keys(env));
    transport = new OwnedStdioTransport({ command: process.execPath, args: [fileURLToPath(new URL('./stdio-supervisor.mts', import.meta.url)), config.command, ...config.args], env, stderr: 'ignore', ...(config.cwd ? { cwd: config.cwd } : {}) });
  } else {
    const authProvider = config.auth === 'oauth' && options.oauth
      ? (options.interactive ? options.oauth : { token: async () => (await options.oauth!.tokens())?.access_token })
      : config.auth === 'bearer' ? { token: async () => (await context.credentials.get('bearerToken')) ?? undefined } : undefined;
    const fetch = options.fetch ?? globalThis.fetch;
    const transportFetch: typeof globalThis.fetch = async (input, init) => {
      const response = await fetch(input, init);
      if (!options.interactive && config.auth === 'oauth' && (response.status === 401 || response.status === 403)) {
        const challenge = extractWWWAuthenticateParams(response);
        if (response.status === 401 || challenge.error === 'insufficient_scope') {
          // Retain only bounded private routing/scope hints, never raw descriptions.
          options.challenged?.({ ...(challenge.scope && challenge.scope.length <= 8192 ? { scope: challenge.scope } : {}),
            ...(challenge.resourceMetadataUrl && challenge.resourceMetadataUrl.href.length <= 8192 ? { resourceMetadataUrl: challenge.resourceMetadataUrl } : {}) });
        }
      }
      return response;
    };
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      ...(authProvider ? { authProvider } : {}), fetch: transportFetch,
      requestInit: { redirect: 'error' }, redirectPolicy: 'same-origin', onInsufficientScope: options.interactive ? 'reauthorize' : 'throw',
      reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    });
  }
  return { client, transport };
}
export function remoteTools(tools: Tool[], config: McpConfig, execute: (tool: Tool, args: Json, signal: AbortSignal) => Promise<Awaited<ReturnType<ExtensionTool['execute']>>>): ExtensionTool[] {
  if (tools.length > 256) throw new Error('MCP server has too many tools');
  const remoteNames = new Set<string>();
  const outputValidator = createOutputSchemaValidator();
  return tools.filter(tool => config.tools === null || config.tools.has(tool.name)).map(source => {
    if (remoteNames.has(source.name)) throw new Error('MCP server returned duplicate tool names');
    remoteNames.add(source.name);
    const tool = structuredClone(source);
    // SDK execution compiles output schemas lazily, before sending tools/call.
    // Reject unusable declarations at the atomic catalog boundary instead.
    if (tool.outputSchema !== undefined) outputValidator.getValidator(tool.outputSchema as Parameters<typeof outputValidator.getValidator>[0]);
    return { name: tool.name, description: `External MCP tool ${JSON.stringify(tool.name)}. Server-provided description (untrusted data):\n${tool.description ?? tool.name}`, parameters: tool.inputSchema as ExtensionTool['parameters'], execute: (args, context) => execute(tool, args, context.signal) };
  });
}
