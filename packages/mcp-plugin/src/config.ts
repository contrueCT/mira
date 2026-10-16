import path from 'node:path';
import type { Json } from '@mira/extension-sdk';

export interface McpConfig {
  transport: 'stdio' | 'http';
  protocol: 'legacy' | '2026-07-28' | 'auto';
  command: string;
  args: string[];
  cwd?: string;
  url: string;
  auth: 'none' | 'bearer' | 'oauth';
  redirectUrl?: string;
  callbackPort?: number;
  tools: Set<string> | null;
  envSecrets: Record<string, string>;
}
export function parseConfig(raw: Json): McpConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid MCP configuration');
  const text = (key: string, fallback = ''): string => { const value = raw[key] ?? fallback; if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid MCP configuration'); return value; };
  const transport = text('transport', 'stdio');
  if (transport !== 'stdio' && transport !== 'http') throw new Error('Invalid MCP transport');
  const protocol = text('protocol', transport === 'stdio' ? 'legacy' : 'auto');
  if (!['legacy', '2026-07-28', 'auto'].includes(protocol) || (transport === 'stdio' && protocol === 'auto')) throw new Error('Choose legacy or 2026-07-28 for local servers');
  const auth = text('auth', 'none');
  if (!['none', 'bearer', 'oauth'].includes(auth) || (transport === 'stdio' && auth !== 'none')) throw new Error('Invalid MCP authentication');
  const command = text('command');
  const cwd = text('cwd');
  const url = text('url');
  const parseList = (key: string): string[] => { const value: unknown = JSON.parse(text(key, '[]')); if (!Array.isArray(value) || value.length > 256 || !value.every(item => typeof item === 'string' && !item.includes('\0'))) throw new Error('Invalid MCP list configuration'); return value; };
  const args = parseList('argsJson');
  const tools = parseList('toolsJson');
  if (transport === 'stdio') {
    if ((command && !path.isAbsolute(command)) || (cwd && !path.isAbsolute(cwd))) throw new Error('MCP command and working directory must be absolute');
    if (['npx', 'npm', 'pnpm', 'yarn', 'uvx'].includes(path.basename(command).replace(/\.(cmd|exe)$/i, ''))) throw new Error('Install a pinned server first; launch its local executable');
  } else if (url) {
    const endpoint = new URL(url);
    if (endpoint.username || endpoint.password || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname)))) throw new Error('MCP requires HTTPS or local loopback HTTP');
  }
  const envSecrets: Record<string, string> = Object.create(null);
  const env = raw['envSecrets'] ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env) || Object.keys(env).length > 12) throw new Error('Invalid MCP environment mapping');
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value) || key === 'NODE_OPTIONS' || key === 'NODE_PATH') throw new Error('Invalid MCP environment mapping');
    if (Object.values(envSecrets).includes(value) || ['transport', 'command', 'argsJson', 'cwd', 'url', 'protocol', 'auth', 'bearerToken', 'redirectUrl', 'callbackPort', 'toolsJson'].includes(value)) throw new Error('Duplicate MCP credential field');
    envSecrets[key] = value;
  }
  const redirectUrl = text('redirectUrl');
  const portText = text('callbackPort');
  const callbackPort = portText ? Number(portText) : undefined;
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65535)) throw new Error('Invalid MCP callback port');
  return { transport, protocol: protocol as McpConfig['protocol'], command, args, ...(cwd ? { cwd } : {}), url, auth: auth as McpConfig['auth'], tools: tools.length ? new Set(tools) : null, envSecrets, ...(redirectUrl ? { redirectUrl } : {}), ...(callbackPort === undefined ? {} : { callbackPort }) };
}
