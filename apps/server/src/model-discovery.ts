import { parseModelConfiguration, type CustomConnection, type CustomModelConfiguration } from './model-config.ts';

export type DiscoveredModel = Pick<CustomModelConfiguration, 'id' | 'name'> & Partial<Omit<CustomModelConfiguration, 'id' | 'name'>>;
export interface ModelDiscoveryResult {
  endpoint: string;
  models: DiscoveredModel[];
}
export interface ModelDiscoveryOptions {
  fetch?: typeof globalThis.fetch;
  env?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
}
export const modelDiscoveryLimits = Object.freeze({
  timeoutMs: 15_000,
  maxPages: 20,
  maxModels: 10_000,
  maxResponseBytes: 2_000_000,
});

class DiscoveryError extends Error {}
const invalidResponse = (): DiscoveryError => new DiscoveryError('Model discovery returned an invalid response');
const aborted = (): DiscoveryError => new DiscoveryError('Model discovery was cancelled or timed out');

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidResponse();
  return value as Record<string, unknown>;
}
function validText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value);
}
function text(value: unknown): string {
  if (!validText(value)) throw invalidResponse();
  return value;
}
/** Explicit fields only. OpenAI's standard ID-only list leaves these absent.
 * OpenRouter-style limits/modalities are documented additions, not name heuristics.
 * Reasoning support is not permission to send a protocol-specific control.
 */
function metadata(item: Record<string, unknown>): Partial<Omit<DiscoveredModel, 'id' | 'name'>> {
  const result: Partial<Omit<DiscoveredModel, 'id' | 'name'>> = {};
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const top = object(item['top_provider']);
  const context = item['contextWindow'] ?? top['context_length'] ?? item['context_length'];
  const output = item['maxTokens'] ?? top['max_completion_tokens'];
  if (positive(context)) result.contextWindow = context;
  if (positive(output) && (!result.contextWindow || output <= result.contextWindow)) result.maxTokens = output;
  const input = item['input'] ?? object(item['architecture'])['input_modalities'];
  if (Array.isArray(input)) {
    const supported = [...new Set(input.filter((kind): kind is 'text' | 'image' => kind === 'text' || kind === 'image'))];
    if (supported.length) result.input = supported;
  }
  if (typeof item['reasoning'] === 'boolean') result.reasoning = item['reasoning'];
  // A reasoning parameter list may describe a different wire format. Keep the
  // control opt-in in the editor rather than silently mapping incompatible APIs.
  return result;
}
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}
/** Also bounds injected transports/readers that fail to honor the request's signal. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}
function cancelBody(response: Response): void {
  // Cancellation itself must not hold up the global deadline or leak a transport error.
  try { void response.body?.cancel().catch(() => undefined); } catch { /* Already locked/closed. */ }
}
async function readJson(response: Response, signal: AbortSignal, budget: { remaining: number }, checkActive: () => void): Promise<unknown> {
  const advertised = response.headers.get('content-length');
  if (advertised !== null && /^\d+$/u.test(advertised) && Number(advertised) > budget.remaining) {
    cancelBody(response);
    throw new DiscoveryError('Model discovery response exceeds the byte limit');
  }
  if (!response.body) throw invalidResponse();
  const reader = response.body.getReader();
  // One fixed buffer also bounds memory for millions of tiny/empty chunks.
  const body = new Uint8Array(budget.remaining);
  let bytes = 0;
  try {
    for (;;) {
      checkActive();
      const chunk = await withAbort(reader.read(), signal);
      if (chunk.done) break;
      if (!(chunk.value instanceof Uint8Array)) throw invalidResponse();
      budget.remaining -= chunk.value.byteLength;
      if (budget.remaining < 0) throw new DiscoveryError('Model discovery response exceeds the byte limit');
      body.set(chunk.value, bytes);
      bytes += chunk.value.byteLength;
    }
    checkActive();
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, bytes))) as unknown; }
    catch { throw invalidResponse(); }
  } catch (error) {
    try { void reader.cancel().catch(() => undefined); } catch { /* Preserve the sanitized error. */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Lists only the explicitly configured custom destination. Results are suggestions:
 * the provider's IDs/names do not establish context limits, modalities, prices, or access.
 * No endpoint probing, redirects, built-in credential lookup, or partial success.
 */
export async function discoverModels(connection: CustomConnection, options: ModelDiscoveryOptions = {}): Promise<ModelDiscoveryResult> {
  let custom: CustomConnection;
  try {
    const parsed = parseModelConfiguration({ customConnections: [connection] }).customConnections[0];
    if (!parsed) throw Error();
    custom = parsed;
  } catch { throw new DiscoveryError('Invalid custom connection for model discovery'); }

  let key: string | undefined;
  try {
    const env = options.env ?? process.env;
    key = Object.hasOwn(env, custom.apiKeyEnv) ? env[custom.apiKeyEnv] : undefined;
  } catch { /* Report the same safe missing/malformed credential error. */ }
  if (typeof key !== 'string' || !/^[\x21-\x7e]{1,16384}$/u.test(key) || key.includes('sk-ant-oat')) {
    throw new DiscoveryError('Model discovery requires a valid API key in the configured environment variable');
  }

  const endpoint = custom.modelsUrl ?? `${custom.baseUrl}${custom.api === 'anthropic-messages' ? '/v1/models' : '/models'}`;
  // Never return or request the resolved credential as a URL path token.
  let endpointPath: string;
  try { endpointPath = decodeURIComponent(new URL(endpoint).pathname); } catch { throw new DiscoveryError('Invalid model discovery endpoint'); }
  if (endpoint.includes(key) || endpointPath.includes(key)) throw new DiscoveryError('Model discovery endpoint must not contain the API key');
  // Configuration validation owns URL syntax; defense in depth prevents override drift.
  if (new URL(endpoint).origin !== new URL(custom.baseUrl).origin) {
    throw new DiscoveryError('Model discovery endpoint must have the same origin as the connection');
  }
  const headers = custom.api === 'anthropic-messages'
    ? { accept: 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { accept: 'application/json', authorization: `Bearer ${key}` };
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  const deadline = performance.now() + modelDiscoveryLimits.timeoutMs;
  const timer = setTimeout(onAbort, modelDiscoveryLimits.timeoutMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const signal = controller.signal;
  const checkActive = (): void => {
    // An endless synchronously supplied stream can starve timer callbacks.
    if (performance.now() >= deadline) controller.abort();
    throwIfAborted(signal);
  };
  const fetchModels = options.fetch ?? globalThis.fetch;
  const budget = { remaining: modelDiscoveryLimits.maxResponseBytes };
  const models: DiscoveredModel[] = [];
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let rowCount = 0;
  let cursor: string | undefined;
  try {
    for (let page = 0; page < modelDiscoveryLimits.maxPages; page++) {
      checkActive();
      const url = new URL(endpoint);
      if (cursor !== undefined) url.searchParams.set('after_id', cursor);
      const request = fetchModels(url.href, {
        method: 'GET', headers, signal, redirect: 'error', credentials: 'omit',
        referrerPolicy: 'no-referrer', cache: 'no-store',
      });
      // A non-compliant injected transport may return a body after cancellation.
      void request.then(response => { if (signal.aborted) cancelBody(response); }, () => undefined);
      const response = await withAbort(request, signal);
      if (response.redirected || (response.url && response.url !== url.href)) {
        cancelBody(response);
        throw new DiscoveryError('Model discovery redirects are not allowed');
      }
      if (!response.ok) {
        cancelBody(response);
        throw new DiscoveryError(`Model discovery request failed (HTTP ${response.status})`);
      }
      const payload = record(await readJson(response, signal, budget, checkActive));
      const compatibility = custom.api !== 'anthropic-messages' && !Object.hasOwn(payload, 'data');
      const rows = compatibility ? payload['models'] : payload['data'];
      if (!Array.isArray(rows)) throw invalidResponse();
      rowCount += rows.length;
      if (rowCount > modelDiscoveryLimits.maxModels) throw new DiscoveryError('Model discovery exceeds the model limit');
      for (const raw of rows) {
        const item = record(raw);
        const id = text(compatibility && validText(item['slug']) ? item['slug'] : item['id']);
        const rawName = custom.api === 'anthropic-messages' && Object.hasOwn(item, 'display_name') ? item['display_name'] : item['name'];
        const name = rawName === undefined ? undefined : text(rawName);
        if (id.includes(key) || name?.includes(key)) throw invalidResponse();
        if (!ids.has(id)) {
          ids.add(id);
          models.push({ id, ...(name === undefined ? {} : { name }), ...metadata(item) });
        }
      }
      checkActive();
      if (custom.api !== 'anthropic-messages') return { endpoint, models };
      if (typeof payload['has_more'] !== 'boolean') throw invalidResponse();
      if (!payload['has_more']) return { endpoint, models };
      cursor = text(payload['last_id']);
      if (cursor.includes(key)) throw invalidResponse();
      if (rows.length === 0 || cursors.has(cursor)) throw new DiscoveryError('Model discovery returned invalid pagination');
      cursors.add(cursor);
    }
    throw new DiscoveryError('Model discovery exceeds the page limit');
  } catch (error) {
    if (signal.aborted) throw aborted();
    if (error instanceof DiscoveryError) throw error;
    throw new DiscoveryError('Model discovery request failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}
