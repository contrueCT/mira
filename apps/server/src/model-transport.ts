import { createModels, createProvider, createAssistantMessageEventStream, type Api, type Model, type Provider, type ProviderStreams, type SimpleStreamOptions, type AssistantMessageEventStream, type AssistantMessage, type AssistantMessageEvent } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { ModelRequestFailure, containsPercentEncodedSecret, providerFailureReason, secretVariants, transportFailureReason, type ModelFailureContext } from './model-errors.ts';
import { builtinApiKeySupport, createBuiltinCatalog, protocolDescription } from './model-catalog.ts';
import { parseModelConfiguration, validateBaseUrl, type CustomProtocol, type ModelConfiguration } from './model-config.ts';

export type ModelSelection = { kind: 'builtin'; provider: string; model: string } | { kind: 'custom'; connection: string; model: string };
export interface ModelTransportOptions {
  /** Request-local sanitized failure; null clears an earlier attempt. */
  onFailure?: (failure: ModelRequestFailure | null) => void;
  /** Only the selected, explicitly configured variable is read, at request time. */
  env?: (name: string) => string | undefined;
  /** Server-owned literal credential resolver; when present, no environment key is read. */
  resolveApiKey?: (signal: AbortSignal) => Promise<string | undefined>;
  /** Test injection; production uses global fetch with redirect and origin guards. */
  fetch?: typeof globalThis.fetch;
}
export interface ModelTransport {
  model: Model<Api>;
  /** Complete-message events only; upstream SSE deltas are consumed internally. */
  streamFn: StreamFn;
  description: { source: 'builtin' | 'custom'; provider: string; model: string; protocol: { id: string; name: string }; pricing: 'catalog-estimate' | 'unknown' };
}
const adapters: Record<CustomProtocol, () => ProviderStreams> = {
  'openai-completions': openAICompletionsApi,
  'openai-responses': openAIResponsesApi,
  'anthropic-messages': anthropicMessagesApi,
};
export function resolveConfiguredApiKey(name: string, env: (name: string) => string | undefined): string {
  let value: string | undefined;
  try { value = env(name); } catch { throw Error('Unable to read the explicitly configured API-key environment variable'); }
  if (!value || !/^[\x21-\x7e]{1,16384}$/u.test(value)) throw Error('The explicitly configured API-key environment variable is missing or invalid');
  if (value.includes('sk-ant-oat')) throw Error('OAuth tokens are not supported by this API-key connection');
  return value;
}
/** Redirects are disabled even on the same host; a new destination needs explicit configuration. */
function scopedModelFetch(baseUrl: string, fetch: typeof globalThis.fetch, headers: () => Headers, failure: ModelFailureContext, secret: () => string | undefined): typeof globalThis.fetch {
  const origin = new URL(validateBaseUrl(baseUrl)).origin;
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.origin !== origin || url.username || url.password) throw Error('Model request destination does not match the configured origin');
    try {
      const response = await fetch(input, { ...init, headers: headers(), redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' });
      if (!response.ok) {
        failure.status = response.status;
        const id = response.headers.get('x-request-id') ?? response.headers.get('request-id');
        if (id) failure.requestId = id;
      }
      if (response.status >= 300 && response.status < 400) { void response.body?.cancel().catch(() => undefined); throw Error('Redirect rejected'); }
      if (!response.ok) {
        failure.providerReason = await providerFailureReason(response, secret());
        // The SDK receives only selected, sanitized error text, never a huge raw
        // body whose truncation could erase the useful provider message/code.
        return new Response(JSON.stringify({ error: { message: failure.providerReason } }), { status: response.status, headers: { 'content-type': 'application/json' } });
      }
      return response;
    }
    catch (error) { failure.transportReason = transportFailureReason(error, secret()); throw Error(failure.transportReason); }
  };
}
function safeOptions(options: SimpleStreamOptions | undefined, model: Model<Api>, fetch: typeof globalThis.fetch | undefined): SimpleStreamOptions {
  if (options?.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0 || options.maxTokens > model.maxTokens)) throw Error('Requested output limit exceeds the configured model limit');
  // Credentials, arbitrary request headers, provider env and telemetry callbacks
  // are not accepted from the runtime. The selected connection owns transport.
  return {
    ...(options?.signal ? { signal: options.signal } : {}),
    ...(options?.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options?.reasoning === undefined ? {} : { reasoning: options.reasoning }),
    ...(options?.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
    ...(fetch ? { fetch } : {}), transport: 'sse', maxRetries: 0,
  };
}
function containsSecret(value: unknown, secret: string | undefined): boolean {
  if (!secret) return false;
  if (typeof value === 'string') return secretVariants(secret).some(variant => value.includes(variant)) || containsPercentEncodedSecret(value, secret);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secret));
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => secretVariants(secret).some(variant => key.includes(variant)) || containsPercentEncodedSecret(key, secret) || containsSecret(item, secret));
}
function sanitizeMessage(message: AssistantMessage, failure: ModelFailureContext, secret: string | undefined): void {
  // Provider error/diagnostic fields may contain raw response text even in an
  // earlier partial. Keep normalized stopReason, never raw error metadata.
  delete message.rawStopReason;
  delete message.diagnostics;
  if (message.errorMessage !== undefined) message.errorMessage = message.stopReason === 'aborted' ? 'Model request was cancelled' : ModelRequestFailure.from(message.errorMessage, failure, secret).message;
}
function maskProviderErrors(source: AssistantMessageEventStream, model: Model<Api>, secret: () => string | undefined, signal: AbortSignal | undefined, failure: ModelFailureContext, onFailure: ModelTransportOptions['onFailure']): AssistantMessageEventStream {
  const output = createAssistantMessageEventStream();
  const fail = (detail?: unknown): void => {
    const diagnostic = ModelRequestFailure.from(detail, failure, secret());
    const reason = signal?.aborted ? 'aborted' : 'error';
    if (reason === 'error') onFailure?.(diagnostic);
    output.push({ type: 'error', reason, error: { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: reason, timestamp: Date.now(), errorMessage: reason === 'aborted' ? 'Model request was cancelled' : diagnostic.message, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
  };
  void (async () => {
    let terminal = false;
    try {
      for await (const event of source) {
        // No UI consumes incremental deltas in this composition. Forward only
        // complete messages so a credential split across text deltas cannot be
        // reconstructed by a streaming subscriber before terminal redaction.
        if (event.type !== 'done' && event.type !== 'error') continue;
        const safe: AssistantMessageEvent = structuredClone(event);
        if (safe.type === 'done') { sanitizeMessage(safe.message, failure, secret()); terminal = true; }
        if (safe.type === 'error') {
          sanitizeMessage(safe.error, failure, secret());
          if (signal?.aborted) { safe.reason = 'aborted'; safe.error.stopReason = 'aborted'; }
          if (safe.reason === 'aborted') safe.error.errorMessage = 'Model request was cancelled';
          terminal = true;
        }
        // Never rewrite valid tool arguments/IDs/content into a different
        // executable message. A credential echo rejects the complete response.
        if (signal?.aborted || containsSecret(safe, secret())) { terminal = true; fail('Response contained a credential echo and was withheld'); break; }
        if (safe.type === 'error' && safe.reason !== 'aborted') {
          const diagnostic = ModelRequestFailure.from(event.type === 'error' ? event.error.errorMessage : undefined, failure, secret());
          safe.error.errorMessage = diagnostic.message; onFailure?.(diagnostic);
        }
        output.push(safe);
      }
      if (!terminal) fail('Provider stream ended without a terminal message');
    } catch (error) { fail(transportFailureReason(error, secret())); }
  })();
  return output;
}
function checkSdkEnvironment(model: Model<Api>): void {
  const logVariable = model.api === 'anthropic-messages' ? 'ANTHROPIC_LOG' : ['openai-completions', 'openai-responses'].includes(model.api) ? 'OPENAI_LOG' : undefined;
  if (logVariable && process.env[logVariable] !== undefined) throw Error(`Unset ${logVariable} before using this explicit connection; SDK logging can expose credentials`);
  if (model.api === 'google-generative-ai' && (process.env['GOOGLE_GENAI_USE_VERTEXAI'] !== undefined || process.env['GOOGLE_GENAI_USE_ENTERPRISE'] !== undefined)) {
    throw Error('Unset GOOGLE_GENAI_USE_VERTEXAI and GOOGLE_GENAI_USE_ENTERPRISE before using this explicit Gemini API-key connection');
  }
}
/** Pure setup: no credentials are read and no model request occurs until streamFn is called. */
export function createModelTransport(configuration: ModelConfiguration, selection: ModelSelection, options: ModelTransportOptions = {}): ModelTransport {
  const config = parseModelConfiguration(configuration);
  const builtins = createBuiltinCatalog();
  for (const id of Object.keys(config.builtinCredentials)) if (!builtins.getProvider(id)) throw Error('Unknown built-in credential provider');
  let model: Model<Api>; let provider: Provider; let apiKeyEnv: string;
  if (selection.kind === 'builtin') {
    const selected = builtins.getProvider(selection.provider); const selectedModel = builtins.getModel(selection.provider, selection.model);
    if (!selected || !selectedModel) throw Error('Unknown built-in provider/model');
    if (!builtinApiKeySupport(selected).supported) throw Error('This built-in integration requires a login or cloud configuration not supported in this phase');
    const credential = config.builtinCredentials[selection.provider];
    if (!credential) throw Error('Configure an explicit API-key environment reference for this built-in provider');
    apiKeyEnv = credential.apiKeyEnv;
    model = structuredClone(selectedModel);
    validateBaseUrl(model.baseUrl);
    // Keep provider-owned protocol behavior and catalog model metadata. Auth is
    // replaced below; no OAuth, credential store, ambient config, or refresh.
    provider = selected;
  } else if (selection.kind === 'custom') {
    const connection = config.customConnections.find(item => item.id === selection.connection);
    const selected = connection?.models.find(item => item.id === selection.model);
    if (!connection || !selected) throw Error('Unknown custom connection/model');
    apiKeyEnv = connection.apiKeyEnv;
    const id = `custom:${connection.id}`;
    if (builtins.getProvider(id)) throw Error('Custom provider ID collides with a built-in provider');
    model = { id: selected.id, name: selected.name ?? selected.id, api: connection.api, provider: id, baseUrl: connection.baseUrl,
      contextWindow: selected.contextWindow, maxTokens: selected.maxTokens, reasoning: selected.reasoning, input: [...selected.input],
      // Pi requires numeric rates; these are calculation placeholders, not prices.
      // Mira's public connection descriptor reports unknown, never free.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
    provider = createProvider({ id, name: connection.name ?? connection.id, models: [model], api: { [connection.api]: adapters[connection.api]() }, auth: { apiKey: { name: 'Explicit custom API key', resolve: async () => undefined } } });
  } else throw Error('Unknown model selection kind');
  const canonicalModel = structuredClone(model);
  const env = options.env ?? (name => process.env[name]);
  // Pi's Google SDK adapter rejects custom fetch and does not expose its SDK
  // cloud-mode constructor flags. Reject ambient cloud mode rather than silently
  // changing the selected protocol. Never mutate global environment variables.
  if (canonicalModel.api === 'google-generative-ai' && options.fetch) throw Error('The Pi Google adapter does not support injected fetch');
  checkSdkEnvironment(canonicalModel);
  return {
    model: structuredClone(canonicalModel),
    description: { source: selection.kind, provider: canonicalModel.provider, model: canonicalModel.id, protocol: protocolDescription(canonicalModel.api), pricing: selection.kind === 'custom' ? 'unknown' : 'catalog-estimate' },
    streamFn: (requested, context, streamOptions) => {
      if (requested.id !== canonicalModel.id || requested.provider !== canonicalModel.provider || requested.api !== canonicalModel.api) throw Error('Injected transport is bound to a different model');
      checkSdkEnvironment(canonicalModel);
      options.onFailure?.(null);
      const failure: ModelFailureContext = {};
      let key: string | undefined;
      let betas: string[] = [];
      // Request-local state prevents concurrent calls or key rotation from
      // sharing credentials/header state. No credential is stored in the model.
      const collection = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
      collection.setProvider({ ...provider, auth: { apiKey: { name: 'Explicit configured API key', resolve: async ({ signal }) => {
        signal.throwIfAborted();
        if (options.resolveApiKey) {
          try { key = await options.resolveApiKey(signal); } catch { throw Error('Unable to read the configured API key'); }
          signal.throwIfAborted();
          if (!key || !/^[\x21-\x7e]{1,16384}$/u.test(key) || key.includes('sk-ant-oat')) throw Error('The configured API key is missing or invalid');
        } else key = resolveConfiguredApiKey(apiKeyEnv, env);
        // Pi treats a non-sk- credential at this exact endpoint as ChatGPT
        // sign-in and silently removes output/sampling fields. That auth mode
        // is outside this API-key-only composition.
        if (canonicalModel.provider === 'openai' && canonicalModel.baseUrl === 'https://api.openai.com/v1' && !key.startsWith('sk-')) throw Error('The built-in OpenAI connection requires an API key, not a ChatGPT access token');
        return { auth: { apiKey: key }, source: options.resolveApiKey ? 'explicit server credential' : 'explicit environment reference' };
      } } } });
      const headers = (): Headers => {
        if (!key) throw Error('Explicit API key was not resolved');
        // SDK constructors also read *_CUSTOM_HEADERS, organization and project
        // variables. Rebuild from request-owned data instead of filtering that
        // already-contaminated header bag or altering process.env.
        const result = new Headers({ accept: 'text/event-stream', 'content-type': 'application/json' });
        for (const source of [provider.headers, canonicalModel.headers]) for (const [name, value] of Object.entries(source ?? {})) {
          if (value !== null) result.set(name, value);
        }
        result.delete('authorization'); result.delete('x-api-key');
        if (canonicalModel.api === 'anthropic-messages') {
          result.set('x-api-key', key); result.set('anthropic-version', '2023-06-01');
          if (betas.length) result.set('anthropic-beta', betas.join(','));
        } else result.set('authorization', `Bearer ${key}`);
        return result;
      };
      const fetch = canonicalModel.api === 'google-generative-ai' ? undefined : scopedModelFetch(canonicalModel.baseUrl, options.fetch ?? globalThis.fetch, headers, failure, () => key);
      const requestOptions = safeOptions(streamOptions, canonicalModel, fetch);
      const cap = streamOptions?.maxTokens ?? canonicalModel.maxTokens;
      requestOptions.onPayload = payload => {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw Error('Invalid model request payload');
        const body = payload as Record<string, unknown>;
        let limits: unknown[];
        switch (canonicalModel.api) {
          case 'openai-completions': limits = [body['max_tokens'], body['max_completion_tokens']].filter(value => value !== undefined); break;
          case 'openai-responses': limits = [body['max_output_tokens']]; break;
          case 'anthropic-messages': limits = [body['max_tokens']]; break;
          case 'mistral-conversations': limits = [body['maxTokens']]; break;
          case 'google-generative-ai': {
            const config = body['config'];
            limits = [config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>)['maxOutputTokens'] : undefined];
            break;
          }
          default: throw Error('This model protocol has no verified output-cap mapping in this composition');
        }
        if (!limits.length || limits.some(value => typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0 || value > cap)) throw Error('Protocol request must contain an output limit within the explicitly configured/requested cap');
        // Capture Pi-authored beta names before the SDK adds ambient headers.
        if (Array.isArray(body['betas']) && body['betas'].every(value => typeof value === 'string')) betas = [...body['betas']] as string[];
        return undefined;
      };
      return maskProviderErrors(collection.streamSimple(structuredClone(canonicalModel), context, requestOptions), canonicalModel, () => key, streamOptions?.signal, failure, options.onFailure);
    },
  };
}
