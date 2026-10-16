import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { createOutputSchemaValidator } from '../../packages/mcp-plugin/src/output-schema.ts';

const { Client, InMemoryTransport } = createRequire(new URL('../../packages/mcp-plugin/package.json', import.meta.url))('@modelcontextprotocol/client');

for (const dialect of [undefined, 'https://json-schema.org/draft/2020-12/schema', 'http://json-schema.org/draft/2019-09/schema#', 'http://json-schema.org/draft-07/schema#', 'https://json-schema.org/draft-06/schema']) {
  test(`MCP output validation is quiet and preserves formats for ${dialect ?? 'default 2020-12'}`, async t => {
    const logs = ['log', 'warn', 'error', 'info', 'debug'].map(method => t.mock.method(console, method as 'log', () => {}));
    const schema = {
      ...(dialect ? { $schema: dialect } : {}), type: 'object',
      properties: { opaque: { type: 'string', format: 'synthetic-secret-never-log' }, email: { type: 'string', format: 'email' } },
      required: ['opaque', 'email'],
    };
    const tool = { name: 'synthetic', inputSchema: { type: 'object' }, outputSchema: schema };
    const [transport, peer] = InMemoryTransport.createLinkedPair();
    let output: unknown = { opaque: 'value', email: 'a@example.org' };
    let calls = 0;
    peer.onmessage = async (message: { id?: string | number; method?: string }) => {
      if (message.id === undefined) return;
      let result: unknown;
      if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: [tool] };
      else { calls++; result = { content: [], structuredContent: output }; }
      await peer.send({ jsonrpc: '2.0', id: message.id, result });
    };
    const client = new Client({ name: 'test', version: '1' }, { jsonSchemaValidator: createOutputSchemaValidator(), versionNegotiation: { mode: 'legacy' } });
    client.onerror = () => {};
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      assert.equal(listed.tools.length, 1);
      assert.deepEqual((await client.callTool({ name: tool.name }, { toolDefinition: listed.tools[0] })).structuredContent, output);
      output = { opaque: 'value', email: 'invalid-email' };
      await assert.rejects(client.callTool({ name: tool.name }, { toolDefinition: listed.tools[0] }));
      output = { opaque: 42, email: 'a@example.org' };
      await assert.rejects(client.callTool({ name: tool.name }, { toolDefinition: listed.tools[0] }));
      assert.equal(calls, 3);
      assert.equal(logs.reduce((count, log) => count + log.mock.callCount(), 0), 0);
    } finally { await client.close(); await peer.close(); }
  });
}

test('quiet output validator retains dialect-specific tuple and recursive semantics', () => {
  const validator = createOutputSchemaValidator();
  // SDK types describe 2020-12; older dialect keywords arrive as JSON on the wire.
  const compile = (schema: unknown) => validator.getValidator(schema as Parameters<typeof validator.getValidator>[0]);
  for (const $async of [true, 'true', 1, {}, []]) assert.throws(() => compile({ $async, type: 'object' }), /^Error: Async MCP output schemas are not supported$/);
  assert.equal(compile({ $async: false, type: 'string' })(42).valid, false);
  for (const $schema of [null, 42, false]) assert.throws(() => compile({ $schema, type: 'object' }), /^Error: Unsupported MCP output schema dialect$/);
  for (const $schema of [undefined, 'https://json-schema.org/draft/2020-12/schema#']) {
    const validate = compile({ ...($schema ? { $schema } : {}), type: 'array', prefixItems: [{ type: 'string' }], items: false });
    assert.equal(validate(['ok']).valid, true);
    assert.equal(validate([42]).valid, false);
    assert.equal(validate(['ok', 'extra']).valid, false);
  }
  for (const $schema of ['https://json-schema.org/draft-07/schema', 'http://json-schema.org/draft-06/schema#']) {
    const validate = compile({ $schema, type: 'array', items: [{ type: 'string' }], additionalItems: false });
    assert.equal(validate(['ok']).valid, true);
    assert.equal(validate([42]).valid, false);
    assert.equal(validate(['ok', 'extra']).valid, false);
  }
  const recursive = compile({ $schema: 'https://json-schema.org/draft/2019-09/schema', $recursiveAnchor: true, type: 'object', properties: { value: { type: 'string' }, child: { $recursiveRef: '#' } }, required: ['value'] });
  assert.equal(recursive({ value: 'ok', child: { value: 'ok' } }).valid, true);
  assert.equal(recursive({ value: 'ok', child: { value: 42 } }).valid, false);
  assert.throws(() => validator.getValidator({ $schema: 'https://example.invalid/secret-dialect', type: 'object' }), /^Error: Unsupported MCP output schema dialect$/);
});

test('quiet output validator permits revised schema IDs without changing begun validation closures', () => {
  const validator = createOutputSchemaValidator();
  const old = validator.getValidator({ $id: 'https://synthetic.invalid/schema', type: 'number' });
  const next = validator.getValidator({ $id: 'https://synthetic.invalid/schema', type: 'string' });
  assert.equal(old(42).valid, true); assert.equal(old('next').valid, false);
  assert.equal(next('next').valid, true); assert.equal(next(42).valid, false);
});


test('quiet output validator rejects IDs already used by dialect meta-schemas', () => {
  const validator = createOutputSchemaValidator();
  for (const $schema of ['https://json-schema.org/draft/2020-12/schema', 'https://json-schema.org/draft/2019-09/schema', 'http://json-schema.org/draft-07/schema#']) {
    for (const pattern of ['^ok$', '[']) {
      assert.throws(() => validator.getValidator({ $schema, $id: $schema, type: 'object', properties: { value: { type: 'string', pattern } }, required: ['value'], additionalProperties: false }), /^Error: Reserved MCP output schema ID$/);
    }
  }
});
