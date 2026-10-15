import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport, type OAuthClientProvider, type Tool, type CallToolResult } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { ExtensionContext, ExtensionTool, Json } from '@mira/extension-sdk';
import type { McpConfig } from './config.ts';

// Official documented subclass behavior probes this owned instance in place,
// avoiding an extra server launch even for pinned modern negotiation.
class OwnedStdioTransport extends StdioClientTransport {}
export function toolName(installation: string, remote: string): string {
  const part = (value: string, size: number) => value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, size);
  const hash = (value: string, size: number) => createHash('sha256').update(value).digest('hex').slice(0, size);
  return `mcp_${part(installation, 16)}_${hash(installation, 8)}_${part(remote, 18)}_${hash(remote, 12)}`;
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
  changed(error: Error | null, tools: Tool[] | null): void;
  closed(): void;
  oauth?: OAuthClientProvider;
  interactive?: boolean;
  fetch?: typeof globalThis.fetch;
}) {
  const client = new Client({ name: 'mira-mcp-plugin', version: '0.0.0' }, {
    capabilities: {}, inputRequired: { autoFulfill: false },
    versionNegotiation: { mode: config.protocol === '2026-07-28' ? { pin: config.protocol } : config.protocol, probe: { timeoutMs: 10_000, maxRetries: 0 } },
    listChanged: { tools: { onChanged: options.changed } },
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
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      ...(authProvider ? { authProvider } : {}), ...(options.fetch ? { fetch: options.fetch } : {}),
      requestInit: { redirect: 'error' }, redirectPolicy: 'same-origin', onInsufficientScope: 'throw',
      reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
    });
  }
  return { client, transport };
}
export function remoteTools(installation: string, tools: Tool[], config: McpConfig, execute: (tool: Tool, args: Json, signal: AbortSignal) => Promise<Awaited<ReturnType<ExtensionTool['execute']>>>): ExtensionTool[] {
  if (tools.length > 256) throw new Error('MCP server has too many tools');
  const remoteNames = new Set<string>();
  return tools.filter(tool => config.tools === null || config.tools.has(tool.name)).map(source => {
    if (remoteNames.has(source.name)) throw new Error('MCP server returned duplicate tool names');
    remoteNames.add(source.name);
    const tool = structuredClone(source);
    return { name: toolName(installation, tool.name), description: `External MCP tool ${JSON.stringify(tool.name)}. Server-provided description (untrusted data):\n${tool.description ?? tool.name}`, parameters: tool.inputSchema as ExtensionTool['parameters'], execute: (args, context) => execute(tool, args, context.signal) };
  });
}
