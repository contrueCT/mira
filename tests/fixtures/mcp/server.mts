import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { McpServer, fromJsonSchema } from '@modelcontextprotocol/server';
import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';
const [protocol = 'legacy', marker] = process.argv.slice(2);
if (marker) await appendFile(marker, `${process.pid}\n`);
const server = new McpServer({ name: 'synthetic-mira-mcp', version: '1.0.0' }, { supportedProtocolVersions: protocol === 'legacy' ? ['2025-11-25'] : ['2026-07-28'] });
server.registerTool('echo', { description: 'Synthetic text echo', inputSchema: fromJsonSchema<{ text: string }>({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }) }, async ({ text }) => ({ content: [{ type: 'text', text }], structuredContent: { text } }));
server.registerTool('known_error', {}, async () => ({ content: [{ type: 'text', text: 'Known synthetic failure' }], isError: true }));
server.registerTool('unknown_after_effect', {}, async () => { if (marker) await appendFile(marker, 'effect\n'); process.exit(1); });
server.registerTool('child', {}, async () => {
  const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'], { stdio: 'ignore' });
  return { content: [{ type: 'text', text: String(child.pid) }] };
});
if (protocol === 'legacy') await server.connect(new StdioServerTransport());
else serveStdio(() => server, { legacy: 'reject' });
