import http from 'node:http';
import { McpServer, createMcpHandler, fromJsonSchema } from '@modelcontextprotocol/server';
import { allowLocalTestHttp } from '../../deny-model-network.mts';
export async function httpFixture() {
  let revision = 1;
  let effects = 0;
  let mode: 'normal' | 'lost' | 'unauthorized' | 'header-mismatch' | 'input-required' = 'normal';
  const calls: unknown[] = [];
  const handler = createMcpHandler(() => {
    const captured = revision;
    const server = new McpServer({ name: 'synthetic-http', version: '1.0.0' });
    server.registerTool('echo', { description: `revision ${captured}`, inputSchema: fromJsonSchema<{ text?: string; count?: number }>(captured === 1 ? { type: 'object', properties: { text: { type: 'string' } } } : { type: 'object', properties: { count: { type: 'number' } } }) }, async args => {
      effects++; return { content: [{ type: 'text', text: JSON.stringify({ revision: captured, ...args }) }] };
    });
    server.registerTool('structured', { inputSchema: fromJsonSchema<{ value: 0 | false | null | '' }>({ type: 'object', properties: { value: { enum: [0, false, null, ''] } }, required: ['value'] }) }, async args => ({ content: [], structuredContent: args.value }));
    return server;
  }, { legacy: 'stateless' });
  let origin = '';
  const listener = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      const message = body ? JSON.parse(body) : null;
      if (message?.method === 'tools/call') {
        calls.push(message);
        if (mode === 'lost') { effects++; res.destroy(); return; }
        if (mode === 'unauthorized') { res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }); res.end(); return; }
        if (mode === 'header-mismatch') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32020, message: 'Header mismatch' } })); return; }
        if (mode === 'input-required') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { resultType: 'input_required', inputRequests: {}, requestState: 'synthetic-state' } })); return; }
      }
      const controller = new AbortController(); res.once('close', () => controller.abort());
      const headers = new Headers(); for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(origin + req.url, { method: req.method!, headers, signal: controller.signal, ...(body ? { body } : {}) });
      const response = await handler.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.flushHeaders();
      if (response.body) for await (const chunk of response.body) { if (res.destroyed) break; res.write(chunk); }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(500); res.end(); }
  });
  await new Promise<void>((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const address = listener.address(); if (!address || typeof address === 'string') throw Error('No fixture address');
  origin = `http://127.0.0.1:${address.port}`;
  const revoke = allowLocalTestHttp(origin);
  return { url: origin + '/mcp', calls, effects: () => effects,
    change: () => { revision++; handler.notify.toolsChanged(); },
    mode: (value: typeof mode) => { mode = value; },
    close: async () => { await handler.close(); listener.closeAllConnections(); await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve())); revoke(); },
  };
}
