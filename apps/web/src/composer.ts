import type { MessageEnvelope } from './types.ts';
/** The server's request body limit for one message envelope, in bytes. */
export const MESSAGE_BODY_LIMIT = 65_536;
/** Start showing the remaining budget once this share of it is used. */
const NEAR_LIMIT = 0.8;
export function envelopeBytes(envelope: MessageEnvelope): number {
  return new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
}
export interface ComposerBudget { bytes: number; limit: number; over: boolean; near: boolean; label: string | null }
/** The UTF-8 size of the envelope this draft would send, since the limit is in
 * bytes (a CJK character is three) and JSON escaping counts too. */
export function composerBudget(draft: { text: string; replyToMessageId?: string | undefined; attachmentIds?: readonly string[] | undefined }): ComposerBudget {
  // Same shape and field lengths as a real envelope: a UUID and an ISO instant.
  const bytes = envelopeBytes({ ...(draft.replyToMessageId ? { replyToMessageId: draft.replyToMessageId } : {}), id: '00000000-0000-4000-8000-000000000000', text: draft.text.trim(), occurredAt: new Date(0).toISOString(), ...(draft.attachmentIds?.length ? { attachmentIds: [...draft.attachmentIds] } : {}) });
  const over = bytes > MESSAGE_BODY_LIMIT; const near = !over && bytes >= MESSAGE_BODY_LIMIT * NEAR_LIMIT;
  const kb = (value: number) => (Math.ceil(value / 102.4) / 10).toFixed(1);
  const label = over ? `超出 ${kb(bytes - MESSAGE_BODY_LIMIT)} KB，请缩短后再发送` : near ? `还可输入约 ${kb(MESSAGE_BODY_LIMIT - bytes)} KB` : null;
  return { bytes, limit: MESSAGE_BODY_LIMIT, over, near, label };
}
