import { registerHooks } from 'node:module';
import { createModelTransport, listBuiltinCatalog } from '@mira/server';
import { normalizeContext } from '@earendil-works/pi-ai';
import { retryConfiguration, retrySelection, retryFailure, retryResponse } from './model-retry-fixtures.mts';

const api = process.argv[2];
const scenario = process.argv[3];
const builtin = process.argv[4] === 'builtin';
if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(api ?? '') || !['auth', 'lazy'].includes(scenario ?? '')) throw Error('Unknown synthetic SDK guard probe');
const variable = api === 'anthropic-messages' ? 'ANTHROPIC_LOG' : 'OPENAI_LOG';
const key = 'sk-synthetic-sdk-guard-probe';
let armed = false, lazyLoads = 0, reads = 0, calls = 0;
// Installed after transport import. A safe eager implementation has no adapter
// import left after authentication; the old lazy wrapper opens this exact gap.
const hook = registerHooks({ resolve(specifier, context, next) {
  const resolved = next(specifier, context);
  if (armed && resolved.url.endsWith(`/api/${api}.js`)) { lazyLoads++; process.env[variable] = 'debug'; }
  return resolved;
} });
const providers = { 'openai-completions': 'groq', 'openai-responses': 'openai', 'anthropic-messages': 'anthropic' };
const provider = providers[api as keyof typeof providers];
const selected = listBuiltinCatalog(provider).providers[0]!.models.find(model => model.protocol.id === api)!;
const configuration = builtin ? { builtinCredentials: { [provider]: { apiKeyEnv: 'SYNTHETIC_GUARD_KEY' } }, customConnections: [] }
  : { ...retryConfiguration, customConnections: retryConfiguration.customConnections.map(connection => ({ ...connection, api: api as 'openai-completions' | 'openai-responses' | 'anthropic-messages' })) };
const selection = builtin ? { kind: 'builtin' as const, provider, model: selected.id } : retrySelection;
function success(): Response {
  if (api === 'openai-completions') return retryResponse();
  const events = api === 'anthropic-messages' ? [
    { type: 'message_start', message: { id: 'guard', type: 'message', role: 'assistant', content: [], model: 'guard', stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Synthetic success' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ] : [
    { type: 'response.created', response: { id: 'guard', status: 'in_progress' } },
    { type: 'response.completed', response: { id: 'guard', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 0, input_tokens_details: { cached_tokens: 0 } } } },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
try {
  const transport = createModelTransport(configuration, selection, {
    resolveApiKey: async () => {
      if (++reads === 2) { if (scenario === 'auth') process.env[variable] = 'debug'; else armed = true; }
      return key;
    },
    fetch: async () => { const response = ++calls === 1 ? retryFailure(503) : success(); response.headers.set('x-debug-key', key); return response; },
  });
  const message = await (await transport.streamFn(transport.model, normalizeContext({ messages: [{ role: 'user', content: 'Synthetic guard test', timestamp: 1 }] }), { maxTokens: 128 })).result();
  process.stdout.write(`GUARD_RESULT=${JSON.stringify({ reads, calls, lazyLoads, stopReason: message.stopReason, errorMessage: message.errorMessage })}\n`);
} finally { hook.deregister(); delete process.env[variable]; }
