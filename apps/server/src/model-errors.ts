/** Only bounded, redacted model diagnostics cross persistence and public HTTP. */
const limit = 2_048;
const omitted = '[redacted]';
export function secretVariants(secret: string): string[] {
  const encoded = [encodeURIComponent(secret), new URLSearchParams({ key: secret }).toString().slice(4)];
  return [...new Set([secret, ...encoded, ...encoded.map(value => value.replace(/%[A-F0-9]{2}/gu, part => part.toLowerCase())), JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('base64url')])].sort((a, b) => b.length - a.length);
}
function redact(value: string, secret?: string): string {
  let text = value;
  // Redact before truncation, including common transport/JSON encodings.
  if (secret) {
    for (const variant of secretVariants(secret)) text = text.split(variant).join(omitted);
  }
  return text
    .replace(/(?:https?:\/\/)[^\s<>"']+/giu, '[URL omitted]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/giu, omitted)
    .replace(/(["']?(?:authorization|x-api-key|api[_-]?key|access[_-]?token|secret|password|cookie|set-cookie)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/giu, `$1${omitted}`)
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{20,})\b/gu, omitted)
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
    .replace(/\s+/gu, ' ').trim();
}
function clip(value: string, maximum: number): string { return value.length > maximum ? `${value.slice(0, maximum)}… [truncated]` : value; }
function bounded(value: string, secret?: string): string { return clip(redact(value, secret), limit); }
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function containsHtml(value: string): boolean { return /<\s*(?:!doctype\b|\/?[a-z][^>]*>)/iu.test(value); }
function fields(value: unknown, secret?: string): string {
  if (!record(value)) return '';
  const error = record(value['error']) ? value['error'] : value;
  return ['message', 'code', 'type', 'request_id'].flatMap(key => {
    const item = error[key] ?? (key === 'request_id' ? value[key] : undefined);
    if (typeof item !== 'string' && typeof item !== 'number') return [];
    const text = typeof item === 'string' && containsHtml(item) ? 'HTML error content omitted' : String(item);
    // Redact before field clipping; reserve room for codes and IDs even when
    // the provider's validation message is much longer than the display limit.
    return [`${key}: ${clip(redact(text, secret), key === 'message' ? 1_024 : 128)}`];
  }).join('; ');
}
/** Pi commonly prefixes its serialized provider error with an HTTP status. */
function reason(value: unknown, secret?: string): string {
  if (typeof value !== 'string') return '';
  if (value.length > 65_536) return 'Provider error text exceeded the diagnostic limit';
  const jsonStart = value.indexOf('{');
  const json = (jsonStart >= 0 ? value.slice(jsonStart) : value.replace(/^\s*\d{3}:?\s*/u, '')).trim();
  if (json.startsWith('{') || json.startsWith('[')) {
    try { return fields(JSON.parse(json) as unknown, secret) || 'Provider returned an error without a supported message field'; }
    catch { return 'Provider returned malformed error JSON'; }
  }
  if (containsHtml(json)) return 'Provider returned an HTML error page';
  return value;
}
export interface ModelFailureContext { status?: number; requestId?: string; transportReason?: string; providerReason?: string }
/** Minted at the credential-owning transport; never a raw Error or response. */
export class ModelRequestFailure {
  readonly message: string;
  private constructor(message: string) { this.message = message; Object.freeze(this); }
  static from(value: unknown, context: ModelFailureContext, secret?: string): ModelRequestFailure {
    const details = [context.status === undefined ? '' : `HTTP ${context.status}`,
      context.requestId ? `request ID: ${clip(redact(context.requestId, secret), 128)}` : '', context.transportReason ?? context.providerReason ?? reason(value, secret)].filter(Boolean);
    return new ModelRequestFailure(bounded(`Model request failed${details.length ? ` · ${details.join(' · ')}` : '; the provider supplied no diagnostic details'}`, secret));
  }
}
/** Select cause messages/codes only, never stack, request, response or headers. */
export function transportFailureReason(error: unknown, secret?: string): string {
  const parts: string[] = []; const seen = new Set<unknown>();
  for (let current = error, depth = 0; current && depth < 3 && !seen.has(current); depth++) {
    seen.add(current);
    if (!record(current)) break;
    if (typeof current['message'] === 'string') parts.push(clip(redact(reason(current['message'], secret), secret), 512));
    if (typeof current['code'] === 'string') parts.push(`code: ${clip(redact(current['code'], secret), 64)}`);
    current = current['cause'];
  }
  return bounded(parts.filter(Boolean).join('; ') || 'Network request failed without diagnostic details', secret);
}

/** Consume an HTTP error once, with a hard byte bound before SDK truncation. */
export async function providerFailureReason(response: Response, secret?: string): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return 'Provider returned an empty error response';
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > 65_536) { void reader.cancel().catch(() => undefined); return 'Provider error body exceeded the diagnostic limit'; }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const contentType = response.headers.get('content-type') ?? '';
  if (/html/iu.test(contentType)) return 'Provider returned an HTML error page';
  const body = Buffer.concat(chunks).toString('utf8');
  return bounded(reason(body, secret) || 'Provider returned an empty error response', secret);
}
