import { createAssistantMessageEventStream, type AssistantMessageEventStream, type AssistantMessageEvent, type Model, type Api } from '@earendil-works/pi-ai';
import { ModelRequestFailure, type ModelFailureContext } from './model-errors.ts';

export type ModelRetryReason = 'rate-limit' | 'server' | 'timeout' | 'connection';
/** Request-local observation only. No provider body, URL, headers or credentials. */
export interface ModelRetryStatus {
  phase: 'waiting' | 'requesting';
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  reason: ModelRetryReason;
}
const maxAttempts = 3;
const delays = [250, 1_000] as const;
const maxRetryAfterMs = 10_000;

export function retryableHttpStatus(status: number): ModelRetryReason | undefined {
  if (status === 429) return 'rate-limit';
  if (status === 408) return 'timeout';
  if ([500, 502, 503, 504, 529].includes(status)) return 'server';
  return undefined;
}
/** Do not infer retryability from arbitrary provider error text or generic TypeError. */
export function retryableTransportError(error: unknown): ModelRetryReason | undefined {
  const seen = new Set<unknown>();
  for (let current = error, depth = 0; current && typeof current === 'object' && depth < 3 && !seen.has(current); depth++) {
    seen.add(current);
    const value = current as Record<string, unknown>;
    if (['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(String(value['code']))) return 'timeout';
    if (['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_SOCKET'].includes(String(value['code']))) return 'connection';
    current = value['cause'];
  }
  return undefined;
}
export function boundedRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.length > 128) return undefined;
  const milliseconds = /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) * 1_000 : Date.parse(value) - now;
  return Number.isFinite(milliseconds) && milliseconds >= 0 ? Math.min(maxRetryAfterMs, milliseconds) : undefined;
}
async function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}
/** Only a buffered, uncommitted request is retried. The first terminal published to
 * runtime ends this wrapper permanently, so tool intent/effects are never replayed. */
export function retryModelRequest(
  model: Model<Api>,
  start: (failure: ModelFailureContext, onFailure: (failure: ModelRequestFailure | null) => void) => AssistantMessageEventStream,
  signal: AbortSignal | undefined,
  onRetry: ((status: ModelRetryStatus | null) => void) | undefined,
  onFailure: ((failure: ModelRequestFailure | null) => void) | undefined,
  attemptLimit: number = maxAttempts,
): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  onRetry?.(null); onFailure?.(null);
  void (async () => {
    let first: ModelRequestFailure | undefined;
    let attemptNumber = 0;
    let terminal: Extract<AssistantMessageEvent, { type: 'error' }> | undefined;
    try {
      for (let attempt = 1; attempt <= attemptLimit; attempt++) {
        attemptNumber = attempt;
        const failure: ModelFailureContext = {};
        let diagnostic: ModelRequestFailure | undefined;
        const stream = start(failure, value => { diagnostic = value ?? undefined; });
        for await (const event of stream) {
          if (event.type !== 'done' && event.type !== 'error') continue;
          if (event.type === 'done') { output.push(event); return; }
          terminal = event;
          first ??= diagnostic;
          if (event.reason === 'aborted' || signal?.aborted) { output.push(event); return; }
          if (!failure.retryReason || attempt === attemptLimit) {
            if (diagnostic) {
              const final = ModelRequestFailure.afterAttempts(first ?? diagnostic, diagnostic, attempt);
              // Runtime/Pi classification must see only the terminal failure;
              // an earlier 429 must not veto a later context-overflow recovery.
              // Keep attempt history in the separate sanitized UI diagnostic.
              onFailure?.(final);
            }
            output.push(event); return;
          }
          const delayMs = Math.max(delays[attempt - 1]!, failure.retryAfterMs ?? 0);
          const status = { phase: 'waiting' as const, attempt: attempt + 1, maxAttempts: attemptLimit, delayMs, reason: failure.retryReason };
          onRetry?.(status);
          await wait(delayMs, signal);
          signal?.throwIfAborted();
          onRetry?.({ ...status, phase: 'requesting', delayMs: 0 });
          break;
        }
      }
    } catch {
      // Cancellation during backoff must settle the same stream promptly without
      // dispatching another attempt, publishing partial content or an error notice.
      terminal = terminal ? structuredClone(terminal) : { type: 'error', reason: 'error', error: {
        role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
        stopReason: 'error', timestamp: Date.now(),
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      } };
      terminal.error.content = [];
      if (signal?.aborted) {
        terminal.reason = 'aborted'; terminal.error.stopReason = 'aborted';
        terminal.error.errorMessage = 'Model request was cancelled';
      } else {
        // Setup/observer failures are never reclassified as a provider retry.
        const failure = ModelRequestFailure.from(undefined, {});
        terminal.error.errorMessage = failure.message; onFailure?.(first ? ModelRequestFailure.afterAttempts(first, failure, attemptNumber) : failure);
      }
      output.push(terminal);
    } finally { onRetry?.(null); }
  })();
  return output;
}
