import { normalizeContext } from '@earendil-works/pi-ai';
import { createModelTransport, type ModelSelection, type ModelTransportOptions } from './model-transport.ts';
import type { ModelConfiguration } from './model-config.ts';
import type { ModelRequestFailure } from './model-errors.ts';

export type ReasoningFormat = 'openai' | 'openrouter' | 'litellm';
export interface ModelProbeAttempt { format: ReasoningFormat; status: 'accepted' | 'unsupported' | 'failed'; message?: string }
export type ModelProbeResult = { status: 'supported'; format: ReasoningFormat; attempts: ModelProbeAttempt[] }
  | { status: 'failed'; attempts: ModelProbeAttempt[] };

/** A format switch requires an explicit rejection of this format's field.
 * Authentication, rate limits, bad values and generic 400s do not qualify. */
function unsupportedParameter(failure: ModelRequestFailure | undefined, format: ReasoningFormat): boolean {
  if (!failure || ![400, 422].includes(failure.httpStatus ?? 0)) return false;
  const text = failure.providerMessage;
  if (!text) return false;
  // Capture the rejected name or bracketed list immediately after the rejection,
  // never a later suggestion, accepted-parameter list, request ID or bad value.
  const rejected = /(?:\b(?:unsupported|unknown|unrecognized)\s+(?:(?:request|keyword)\s+)?(?:parameters?|arguments?|fields?)|\bdoes not support\s+(?:the\s+)?(?:parameters?|arguments?|fields?))\s*[:=]?\s*(\[[^\]]{1,256}\]|["'`][\w.]+["'`]|[\w.]+)/giu;
  const expected = format !== 'openrouter' ? ['reasoning_effort'] : ['reasoning', 'reasoning.effort'];
  for (const match of text.matchAll(rejected)) {
    const names = match[1]!.replace(/[\[\]"'`\s]/gu, '').split(',');
    if (names.some(name => expected.includes(name))) return true;
  }
  const fieldFirst = /(?:^|[.;:]\s*)\s*(?:the\s+)?(?:parameter|argument|field)\s+["'`]?([\w.]+)["'`]?\s+(?:is\s+)?(?:not supported|unsupported|unrecognized)\b/giu;
  return [...text.matchAll(fieldFirst)].some(match => expected.includes(match[1]!));
}

/** Settings-only short requests: no conversation, tools, history or retries. */
export async function probeReasoningFormat(configuration: ModelConfiguration, selection: Extract<ModelSelection, { kind: 'custom' }>, options: Pick<ModelTransportOptions, 'fetch' | 'resolveApiKey'> & { signal?: AbortSignal }): Promise<ModelProbeResult> {
  const connection = configuration.customConnections.find(item => item.id === selection.connection);
  const selected = connection?.models.find(item => item.id === selection.model);
  if (!connection || connection.api !== 'openai-completions' || !selected?.reasoning) throw Error('Reasoning probe requires a reasoning Chat Completions model');
  const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(options.signal ? [options.signal] : [])]);
  const attempts: ModelProbeAttempt[] = [];
  const formats: ReasoningFormat[] = ['openai'];
  for (const format of formats) {
    signal.throwIfAborted();
    let failure: ModelRequestFailure | undefined;
    const transport = createModelTransport({ ...configuration, customConnections: [{ ...connection, models: [{ ...selected, reasoningFormat: format }] }] }, selection,
      { ...options, maxAttempts: 1, onFailure: value => { failure = value ?? undefined; } });
    // Even an 'off' preference must test a real control field. This short probe
    // uses low in that case; it never changes the saved preference.
    const reasoning = transport.thinkingLevel === 'off' ? 'low' : transport.thinkingLevel;
    const stream = await transport.streamFn(transport.model, normalizeContext({ messages: [{ role: 'user', content: 'Reply with OK.', timestamp: 0 }] }),
      { reasoning, maxTokens: Math.min(selected.maxTokens, 1024), signal });
    const result = await stream.result();
    signal.throwIfAborted();
    if (result.stopReason !== 'error' && result.stopReason !== 'aborted') {
      attempts.push({ format, status: 'accepted' });
      return { status: 'supported', format, attempts };
    }
    const unsupported = unsupportedParameter(failure, format);
    attempts.push({ format, status: unsupported ? 'unsupported' : 'failed', message: failure?.message ?? 'Model probe failed without a supported diagnostic' });
    if (!unsupported || format !== 'openai') break;
    // Only the primary, sanitized provider error can identify this compatibility
    // path. Do not switch a LiteLLM rejection to OpenRouter's different wire field.
    const liteLLM = /\blitellm\.UnsupportedParamsError\b/u.test(failure?.providerMessage ?? '');
    if (liteLLM) {
      if (!/\ballowed_openai_params\s*=\s*\[\s*['"`]reasoning_effort['"`]\s*\]/u.test(failure?.providerMessage ?? '')) break;
      formats.push('litellm');
    } else formats.push('openrouter');
  }
  return { status: 'failed', attempts };
}
