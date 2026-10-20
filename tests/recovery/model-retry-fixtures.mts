import { createModelTransport, type ModelTransportOptions } from '@mira/server';

export const retryConfiguration = { builtinCredentials: {}, customConnections: [{ id: 'retry-test', api: 'openai-completions' as const, baseUrl: 'https://model.invalid/v1', apiKeyEnv: 'SYNTHETIC_KEY', models: [{ id: 'retry-model', contextWindow: 100_000, maxTokens: 1024, reasoning: false, input: ['text' as const] }] }] };
export const retrySelection = { kind: 'custom' as const, connection: 'retry-test', model: 'retry-model' };
export const syntheticRetryKey = 'synthetic-retry-key';
/** Production attempt count and doubling with short, jitter-free delays (250, 500, 1000, 2000ms). */
export const fastRetryPolicy = { initialDelayMs: 250, jitterRatio: 0 } as const;
export function retryTransport(fetch: typeof globalThis.fetch, options: Omit<ModelTransportOptions, 'fetch' | 'env'> = {}) {
  return createModelTransport(retryConfiguration, retrySelection, { env: () => syntheticRetryKey, fetch, retryPolicy: fastRetryPolicy, ...options });
}
export function retryResponse(text = 'Recovered request', callId?: string, toolName = 'effect', args: Record<string, unknown> = {}): Response {
  const delta = callId ? { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: text };
  return new Response([
    { id: 'retry-response', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'retry-response', choices: [{ index: 0, delta: {}, finish_reason: callId ? 'tool_calls' : 'stop' }] }, '[DONE]',
  ].map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
export function retryFailure(status: number, message = 'synthetic temporary failure', requestId = 'request-1'): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json', 'x-request-id': requestId } });
}
export function brokenPartialResponse(): Response {
  let reads = 0;
  return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (++reads === 1) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'partial', choices: [{ index: 0, delta: { role: 'assistant', content: 'UNCOMMITTED_PARTIAL', tool_calls: [{ index: 0, id: 'partial-call', type: 'function', function: { name: 'effect', arguments: '{}' } }] }, finish_reason: null }] })}\n\n`));
    else controller.error(Object.assign(new Error('synthetic connection reset'), { code: 'ECONNRESET' }));
  } }), { headers: { 'content-type': 'text/event-stream' } });
}
