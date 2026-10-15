import type { ExtensionMessage } from '@mira/extension-sdk';

/** Whitelist public text only; it remains an extension assertion, never authority. */
export function validatedMessage(value: ExtensionMessage): ExtensionMessage {
  const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000\u0008\u000b\u000c]/u.test(value);
  const label = (value: unknown, max: number): value is string => text(value, max) && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value);
  if (!value || !['inbound', 'outbound'].includes(value.direction) || !text(value.text, 100_000) || !label(value.sourceLabel, 80)
    || (value.senderId !== undefined && !label(value.senderId, 512))
    || (value.senderVerified !== undefined && (typeof value.senderVerified !== 'boolean' || !value.senderId))) throw new Error('Invalid extension message projection');
  return { direction: value.direction, text: value.text, sourceLabel: value.sourceLabel,
    ...(value.senderId === undefined ? {} : { senderId: value.senderId }), ...(value.senderVerified === undefined ? {} : { senderVerified: value.senderVerified }) };
}
