import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import test from 'node:test';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { ExtensionHost } from '@mira/extension-host';
import { createHistoryTools, PiDurableRuntime } from '@mira/runtime-pi';
import { createModelTransport, extensionManagementTools, extensionTools, type CustomProtocol, type ModelTransportOptions } from '@mira/server';
import { createExtensionFixture, fixtureParameters } from '../recovery/extension-fixtures.mts';
import { input, MemoryWriter } from '../recovery/fixtures.mts';

type ToolProtocol = CustomProtocol | 'mistral-conversations';
const canonicalNames = ['history_search', 'history_read', 'extension_inspect', 'extension_stage', 'extension_manage'];
const validName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const key = 'synthetic-tool-wire-key';
interface Call { id: string; name: string; arguments: Record<string, unknown> }
interface WireBlock { type: string; id?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: string | WireBlock[]; text?: string }
interface WireMessage {
  type?: string; role?: string; name?: string; call_id?: string; tool_call_id?: string;
  arguments?: string; output?: string; content?: string | WireBlock[];
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
}
interface WireBody {
  tools?: Array<{ name?: string; parameters?: unknown; input_schema?: unknown; function?: { name: string; parameters: unknown } }>;
  messages?: WireMessage[]; input?: WireMessage[];
}

/** Only synthetic bytes reach the real Pi protocol parsers. No global fetch or live credentials. */
function sse(events: Array<string | Record<string, unknown>>, named = false): Response {
  return new Response(events.map(event => `${named && typeof event !== 'string' ? `event: ${event['type']}\n` : ''}data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function reply(api: ToolProtocol, calls: Call[] = [], text = 'Canonical tools completed'): Response {
  if (api === 'openai-completions' || api === 'mistral-conversations') return sse([
    { id: 'synthetic-response', choices: [{ index: 0, delta: calls.length
      ? { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }
      : { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'synthetic-response', choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }, '[DONE]',
  ]);
  if (api === 'openai-responses') {
    const output = calls.length
      ? calls.map(call => ({ id: `fc_${call.id}`, type: 'function_call' as const, call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments), status: 'completed' }))
      : [{ id: 'msg_synthetic', type: 'message' as const, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }];
    return sse([
      { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } },
      ...output.flatMap((item, output_index) => [
        { type: 'response.output_item.added', output_index, item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, content: [] } },
        ...(item.type === 'function_call' ? [{ type: 'response.function_call_arguments.delta', output_index, item_id: item.id, delta: item.arguments }]
          : [{ type: 'response.output_text.delta', output_index, item_id: item.id, content_index: 0, delta: text }]),
        { type: 'response.output_item.done', output_index, item },
      ]),
      { type: 'response.completed', response: { id: 'resp_synthetic', status: 'completed', output, usage: { input_tokens: 20, output_tokens: 5, total_tokens: 25, input_tokens_details: { cached_tokens: 0 } } } },
    ]);
  }
  return sse([
    { type: 'message_start', message: { id: 'msg_synthetic', type: 'message', role: 'assistant', content: [], model: 'manual-id', stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    ...(calls.length ? calls.flatMap((call, index) => [
      { type: 'content_block_start', index, content_block: { type: 'tool_use', id: call.id, name: call.name, input: {} } },
      { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.arguments) } },
      { type: 'content_block_stop', index },
    ]) : [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
    ]),
    { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ], true);
}
function declaredTools(api: ToolProtocol, body: WireBody): Array<{ name: string | undefined; parameters: unknown }> {
  assert.ok(body.tools, 'the real adapter emits a tool registry');
  return body.tools.map(tool => (api === 'openai-completions' || api === 'mistral-conversations')
    ? { name: tool.function?.name, parameters: tool.function?.parameters }
    : { name: tool.name, parameters: api === 'anthropic-messages' ? tool.input_schema : tool.parameters });
}
function textContent(content: string | WireBlock[] | undefined): string {
  return typeof content === 'string' ? content : content?.map(block => block.text ?? textContent(block.content)).join('\n') ?? '';
}
function conversation(api: ToolProtocol, body: WireBody): { calls: Call[]; results: Array<{ id: string | undefined; text: string }> } {
  const calls: Call[] = []; const results: Array<{ id: string | undefined; text: string }> = [];
  for (const message of api === 'openai-responses' ? body.input ?? [] : body.messages ?? []) {
    if (api === 'openai-completions' || api === 'mistral-conversations') {
      for (const call of message.tool_calls ?? []) calls.push({ id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) });
      if (message.role === 'tool') results.push({ id: message.tool_call_id, text: textContent(message.content) });
    } else if (api === 'openai-responses') {
      if (message.type === 'function_call') calls.push({ id: message.call_id!, name: message.name!, arguments: JSON.parse(message.arguments!) });
      if (message.type === 'function_call_output') results.push({ id: message.call_id, text: message.output ?? '' });
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_use') calls.push({ id: block.id!, name: block.name!, arguments: block.input! });
        if (block.type === 'tool_result') results.push({ id: block.tool_use_id, text: textContent(block.content) });
      }
    }
  }
  return { calls, results };
}

for (const api of ['openai-completions', 'openai-responses', 'anthropic-messages', 'mistral-conversations'] as const) {
  test(`${api} keeps canonical names through real adapter dispatch, dynamic tools and restart`, { timeout: 20_000 }, async () => {
    const fixture = await createExtensionFixture();
    let writer = new MemoryWriter(); let host: ExtensionHost | undefined;
    const historyRequests: unknown[] = []; const requests: WireBody[] = [];
    // Nine alphanumeric characters also satisfy Mistral's native call-ID contract.
    const firstCalls: Call[] = [
      { id: 'search001', name: 'history_search', arguments: { query: 'synthetic history', mode: 'substring' } },
      { id: 'read00001', name: 'history_read', arguments: { id: '10000000-0000-4000-8000-000000000001' } },
      { id: 'inspect01', name: 'extension_inspect', arguments: {} },
      { id: 'stage0001', name: 'extension_stage', arguments: { sourceRoot: fixture.root, entryRelative: 'fixture.mjs' } },
      { id: 'enable001', name: 'extension_manage', arguments: { id: 'manual', action: 'enable' } },
    ];
    const nextCalls: Call[] = [
      { id: 'echo00001', name: 'generated_echo', arguments: { count: 7, label: 'synthetic' } },
      { id: 'disable01', name: 'extension_manage', arguments: { id: 'manual', action: 'disable' } },
    ];
    const allCalls = [...firstCalls, ...nextCalls];
    const runtimeId = (id: string) => api === 'openai-responses' ? `${id}|fc_${id}` : id;
    const history = createHistoryTools({ miraId: writer.miraId,
      page: async () => ({ hits: [], nextCursor: null }),
      search: async request => {
        historyRequests.push(request);
        return { query: request.query, mode: request.mode ?? 'full_text', fullTextPrefixChars: 65536, hits: [], hasMore: false };
      },
      read: async request => { historyRequests.push(request); return null; },
    });
    const startHost = async () => {
      const instance = new ExtensionHost({ entries: [{ id: 'manual', path: fixture.modulePath, enabled: false, config: { ...fixture.config, toolName: 'generated_echo' } }],
        reservedToolNames: canonicalNames, receive: async () => { throw Error('This offline fixture must not emit events'); } });
      host = instance; await instance.start(); return instance;
    };
    const verifyRequest = (body: WireBody, round: number) => {
      const declarations = declaredTools(api, body);
      const expectedNames = round === 2 ? [...canonicalNames, 'generated_echo'] : canonicalNames;
      assert.deepEqual(declarations.map(tool => tool.name), expectedNames, 'wire names equal canonical runtime names directly');
      for (const tool of declarations) assert.match(tool.name!, validName);
      if (round === 2) {
        // Pi's Anthropic adapter emits its supported input_schema fields only.
        const expected = api === 'anthropic-messages'
          ? { type: fixtureParameters.type, properties: fixtureParameters['properties'], required: fixtureParameters['required'] }
          : fixtureParameters;
        assert.deepEqual(declarations.at(-1)!.parameters, expected);
      }
      if (round > 1) {
        const transcript = conversation(api, body);
        const expectedCalls = round === 2 ? firstCalls : allCalls;
        assert.deepEqual(transcript.calls, expectedCalls, 'replayed calls retain their canonical names, IDs and arguments');
        assert.deepEqual(transcript.results.map(result => result.id), expectedCalls.map(call => call.id), 'every replayed call is paired with its exact result');
        if (api === 'mistral-conversations') assert.deepEqual(body.messages!.filter(message => message.role === 'tool').map(message => message.name), expectedCalls.map(call => call.name));
        assert.match(transcript.results.find(result => result.id === 'search001')!.text, /synthetic history/);
        assert.equal(transcript.results.find(result => result.id === 'read00001')!.text, 'null');
        assert.match(transcript.results.find(result => result.id === 'inspect01')!.text, /"extensions"/);
        // This fixture intentionally has no artifact store. The real stage tool
        // must dispatch and return its honest rejection, not an unknown-tool error.
        assert.match(transcript.results.find(result => result.id === 'stage0001')!.text, /Generated extensions require artifactsDirectory/);
        assert.match(transcript.results.find(result => result.id === 'enable001')!.text, /"status":"accepted"/);
        if (round >= 3) {
          assert.match(transcript.results.find(result => result.id === 'echo00001')!.text, /Synthetic extension result/);
          assert.match(transcript.results.find(result => result.id === 'disable01')!.text, /"status":"accepted"/);
        }
      }
      assert.ok(round <= 4, 'one same-round continuation per completed tool batch, one restart request');
    };
    const transportOptions: ModelTransportOptions = {
      env: name => { assert.equal(name, 'SYNTHETIC_TOOL_KEY'); return key; },
      fetch: async (url, init) => {
        assert.equal(new URL(String(url)).origin, api === 'mistral-conversations' ? 'https://api.mistral.ai' : 'https://offline.example');
        const body = JSON.parse(String(init?.body)) as WireBody; requests.push(body);
        const round = requests.length;
        return reply(api, round === 1 ? firstCalls : round === 2 ? nextCalls : [], round === 4 ? 'Recovered canonical history' : undefined);
      },
    };
    const transport = api === 'mistral-conversations'
      ? createModelTransport({ builtinCredentials: { mistral: { apiKeyEnv: 'SYNTHETIC_TOOL_KEY' } }, customConnections: [] },
        { kind: 'builtin', provider: 'mistral', model: builtinModels().getModels('mistral').find(model => model.api === api && !model.reasoning)!.id }, transportOptions)
      : createModelTransport({ builtinCredentials: {}, customConnections: [{
        id: 'tool-wire', baseUrl: 'https://offline.example/proxy', api, apiKeyEnv: 'SYNTHETIC_TOOL_KEY',
        models: [{ id: 'manual-id', contextWindow: 32768, maxTokens: 1024, reasoning: false, input: ['text'] }],
      }] }, { kind: 'custom', connection: 'tool-wire', model: 'manual-id' }, transportOptions);
    const runtimeFor = (instance: ExtensionHost) => {
      const management = extensionManagementTools(instance);
      assert.deepEqual([...history, ...management].map(tool => tool.name), canonicalNames);
      return new PiDurableRuntime({ writer, model: transport.model, streamFn: transport.streamFn,
        prepareTools: async (): Promise<AgentTool[]> => [...history, ...management, ...extensionTools(await instance.prepare())],
        finishTools: () => instance.finish(),
      });
    };
    try {
      const firstHost = await startHost();
      const recovered = await runtimeFor(firstHost).run(input('Inspect history, enable the synthetic tool, use it, then disable it'));
      assert.equal(requests.length, 3);
      requests.forEach((body, index) => verifyRequest(body, index + 1));
      assert.deepEqual(historyRequests, firstCalls.slice(0, 2).map(call => call.arguments));
      assert.equal(firstHost.inspect()[0]!.status, 'disabled');
      assert.deepEqual(firstHost.changeStatus().map(change => [change.action, change.status]), [['enable', 'applied'], ['disable', 'applied']]);
      assert.deepEqual(await fixture.effects(), [{ extensionId: 'manual', revision: 1, callId: runtimeId('echo00001'), arguments: nextCalls[0]!.arguments }]);
      assert.deepEqual(writer.state.executions.map(execution => [execution.intent.callId, execution.intent.toolName, execution.intent.arguments]), allCalls.map(call => [runtimeId(call.id), call.name, call.arguments]));
      for (const execution of writer.state.executions) {
        assert.ok(execution.outcome);
        const saved = recovered.messages.find(message => message.role === 'toolResult' && message.toolCallId === execution.intent.callId);
        assert.ok(saved?.role === 'toolResult');
        assert.equal(saved.toolName, execution.intent.toolName);
        assert.deepEqual(execution.outcome.payload, saved, 'canonical outcomes and transcript results are identical');
      }
      const updates = recovered.messages.filter(message => message.role === 'system');
      assert.ok(updates.some(message => message.toolsAdded?.some(tool => tool.name === 'generated_echo')));
      assert.ok(updates.some(message => message.toolsRemoved?.some(tool => tool.name === 'generated_echo')));
      assert.deepEqual(getCurrentTools(recovered.messages).map(tool => tool.name), canonicalNames);
      const beforeRestart = structuredClone(writer.state);
      await firstHost.close(); await writer.close();
      writer = new MemoryWriter(); writer.state = structuredClone(beforeRestart);
      const secondHost = await startHost(); const restored = runtimeFor(secondHost);
      const loaded = await restored.recover();
      assert.deepEqual(loaded.snapshot, beforeRestart, 'recovery preserves canonical durable records without migration');
      assert.equal(requests.length, 3, 'recovery does not call a provider');
      await restored.run(input('Continue from the recovered canonical tool conversation'));
      assert.equal(requests.length, 4);
      verifyRequest(requests[3]!, 4);
      assert.deepEqual(writer.state.executions, beforeRestart.executions, 'restart never replays completed tool effects');
      assert.deepEqual(writer.state.records.slice(0, beforeRestart.records.length), beforeRestart.records);
      assert.equal((await fixture.effects()).length, 1);
      assert.equal(historyRequests.length, 2);
      assert.doesNotMatch(JSON.stringify(writer.state), /synthetic-tool-wire-key|Bearer/);
    } finally { await host?.close(); await writer.close(); await rm(fixture.root, { recursive: true, force: true }); }
  });
}
