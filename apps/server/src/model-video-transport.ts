import { randomUUID } from 'node:crypto';
import type { Api, Context, Model } from '@earendil-works/pi-ai';

/** Hydrated, request-local metadata only. Durable messages retain opaque refs,
 * never these bytes. A video is not represented as a Pi ImageContent. */
export interface NativeVideoInput {
  contentIndex: number;
  attachmentId: string;
  mimeType: string;
  data: string;
}
const MAX_INLINE_BYTES = 12 * 1024 * 1024;
// Leave headroom below Google's conservative 20 MB request boundary for SDK
// wire-field conversion/envelope overhead.
const MAX_REQUEST_BYTES = 19_000_000;
const MIME_TYPES = new Set(['video/mp4', 'video/webm']);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function video(value: unknown): NativeVideoInput {
  if (!record(value) || !Number.isSafeInteger(value['contentIndex']) || (value['contentIndex'] as number) < 0 ||
      typeof value['attachmentId'] !== 'string' || !value['attachmentId'] || value['attachmentId'].length > 256 ||
      typeof value['mimeType'] !== 'string' || !MIME_TYPES.has(value['mimeType']) ||
      typeof value['data'] !== 'string' || !value['data'] || value['data'].length > Math.ceil(MAX_INLINE_BYTES / 3) * 4 ||
      value['data'].length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value['data']) ||
      Buffer.from(value['data'], 'base64').toString('base64') !== value['data']) throw Error('Invalid native video attachment metadata');
  return value as unknown as NativeVideoInput;
}

/** Preserve Pi's own conversion and tool pairing. Fresh markers identify only
 * the designated content slots even when Pi inserts/coalesces protocol messages.
 * The public onPayload hook expands those slots back to reference + native video.
 * https://ai.google.dev/gemini-api/docs/video-understanding */
export function prepareNativeVideoRequest(model: Model<Api>, source: Context): { context: Context; apply: (payload: Record<string, unknown>) => void } {
  const hasMetadata = source.messages.some(message => 'miraNativeVideos' in message);
  if (!hasMetadata) return { context: source, apply: () => undefined };
  if (model.provider !== 'google' || model.api !== 'google-generative-ai' || !model.id.startsWith('gemini-')) {
    throw Error('Native video input is supported only by the built-in Google Gemini connection');
  }
  const context = structuredClone(source);
  const replacements = new Map<string, { text: string; input: NativeVideoInput }>();
  let totalVideoBytes = 0;
  for (const message of context.messages) {
    if (!('miraNativeVideos' in message)) continue;
    const inputs: unknown = message.miraNativeVideos;
    delete message.miraNativeVideos;
    if (message.role !== 'toolResult' || message.toolName !== 'read' || message.isError || !Array.isArray(message.content) || !Array.isArray(inputs) || !inputs.length) throw Error('Invalid native video attachment message');
    const slots = new Set<number>();
    for (const value of inputs) {
      const input = video(value);
      const part = message.content[input.contentIndex];
      if (!part || part.type !== 'text' || slots.has(input.contentIndex)) throw Error('Invalid native video attachment content slot');
      slots.add(input.contentIndex);
      totalVideoBytes += Buffer.byteLength(input.data, 'base64');
      if (totalVideoBytes > MAX_INLINE_BYTES) throw Error('Native video inline data exceeds the 12 MiB request limit');
      const marker = `mira-native-video-${randomUUID()}`;
      replacements.set(marker, { text: part.text, input });
      message.content[input.contentIndex] = { type: 'text', text: marker };
    }
  }
  return { context, apply: payload => {
    if (!Array.isArray(payload['contents'])) throw Error('Native video requires Google contents');
    const counts = new Map<string, number>();
    for (const content of payload['contents']) {
      if (!record(content) || !Array.isArray(content['parts'])) throw Error('Invalid Google content for native video');
      content['parts'] = content['parts'].flatMap((part: unknown) => {
        if (!record(part) || !record(part['functionResponse'])) return [part];
        const response = part['functionResponse'];
        if (!record(response['response']) || typeof response['response']['output'] !== 'string') return [part];
        let output = response['response']['output'];
        const nativeParts: unknown[] = [];
        for (const [marker, replacement] of replacements) {
          const occurrences = output.split(marker).length - 1;
          if (!occurrences) continue;
          if (content['role'] !== 'user' || response['name'] !== 'read') throw Error('Native video content slot changed during conversion');
          counts.set(marker, (counts.get(marker) ?? 0) + occurrences);
          output = output.replaceAll(marker, () => replacement.text);
          nativeParts.push({ text: `Video from read result ${replacement.input.attachmentId}:` },
            { inlineData: { mimeType: replacement.input.mimeType, data: replacement.input.data } });
        }
        response['response']['output'] = output;
        return [part, ...nativeParts];
      });
    }
    if ([...replacements.keys()].some(marker => counts.get(marker) !== 1)) throw Error('Native video content slot missing or duplicated during conversion');
    // Includes native images, system, tools and text. Conservative limits are
    // local transport bounds, not claims of a provider token/size guarantee.
    let inlineBytes = 0;
    const countInline = (value: unknown): void => {
      if (Array.isArray(value)) { for (const child of value) countInline(child); return; }
      if (!record(value)) return;
      if (record(value['inlineData']) && typeof value['inlineData']['data'] === 'string') inlineBytes += Buffer.byteLength(value['inlineData']['data'], 'base64');
      for (const child of Object.values(value)) countInline(child);
    };
    countInline(payload);
    if (inlineBytes > MAX_INLINE_BYTES || Buffer.byteLength(JSON.stringify(payload), 'utf8') > MAX_REQUEST_BYTES) throw Error('Native video request exceeds the inline request size limit');
  } };
}
