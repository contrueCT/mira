import type { HistoryEntry } from '@mira/life';

export interface ExtensionMessageSource {
  kind: 'extension'; extensionId: string; label: string; direction: 'inbound' | 'outbound';
  /** Extension-reported identity and verification; not host/user authorization. */
  senderId?: string; senderVerified?: boolean;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Only the immutable assembly-bound envelope can project a sourced message. */
export function extensionMessage(entry: HistoryEntry): { id: string; role: 'user' | 'assistant'; text: string; occurredAt: string; source: ExtensionMessageSource } | null {
  if (entry.kind !== 'event' || entry.event.source !== 'extension') return null;
  const payload = entry.event.payload;
  if (!object(payload) || typeof payload['extensionId'] !== 'string' || typeof payload['eventId'] !== 'string'
    || (entry.event.id !== JSON.stringify(['extension', payload['extensionId'], payload['eventId']])
      && !(typeof payload['scheduleOwner'] === 'string' && typeof payload['scheduleKey'] === 'string' && entry.event.id === JSON.stringify(['scheduled', payload['scheduleOwner'], payload['scheduleKey'], 'event'])))) return null;
  const message = payload['message'];
  if (!object(message) || (message['direction'] !== 'inbound' && message['direction'] !== 'outbound')
    || typeof message['text'] !== 'string' || !message['text'] || message['text'].length > 100_000
    || typeof message['sourceLabel'] !== 'string' || !message['sourceLabel'] || message['sourceLabel'].length > 80 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(message['sourceLabel'])
    || (message['senderId'] !== undefined && (typeof message['senderId'] !== 'string' || message['senderId'].length > 512))
    || (message['senderVerified'] !== undefined && (typeof message['senderVerified'] !== 'boolean' || !message['senderId']))) return null;
  return { id: entry.id, role: message['direction'] === 'inbound' ? 'user' : 'assistant', text: message['text'], occurredAt: entry.occurredAt,
    source: { kind: 'extension', extensionId: payload['extensionId'], label: message['sourceLabel'], direction: message['direction'],
      ...(typeof message['senderId'] === 'string' ? { senderId: message['senderId'] } : {}), ...(typeof message['senderVerified'] === 'boolean' ? { senderVerified: message['senderVerified'] } : {}) } };
}
/** DTO whitelist for both Timeline HTTP read routes. */
export function messageSource(source: ExtensionMessageSource): ExtensionMessageSource {
  return { kind: 'extension', extensionId: source.extensionId, label: source.label, direction: source.direction,
    ...(source.senderId === undefined ? {} : { senderId: source.senderId }), ...(source.senderVerified === undefined ? {} : { senderVerified: source.senderVerified }) };
}
