/** Platform-independent JSON values accepted by the external ingress protocol. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ExternalEvent { id: string; type: string; occurredAt: string; payload: Json }
/** Records this event and its Wake atomically. Do not emit the same event first. */
export interface ExternalWake { id: string; reason: string; event: ExternalEvent }
/** A local Timeline notification, independent of Event and Wake. */
export interface ExternalNotification { id: string; occurredAt: string; text: string }

/** IDs belong to the caller. This confirms persistence, not cognition completion
 * or notification delivery, and does not promise a History UUID. */
export type ExternalReceipt =
  | { operation: 'event'; id: string; receipt: 'inserted' | 'duplicate'; durability: 'persisted' }
  | { operation: 'wake'; id: string; eventId: string; receipt: 'inserted' | 'duplicate'; durability: 'persisted' }
  | { operation: 'notification'; id: string; receipt: 'inserted' | 'duplicate'; durability: 'persisted' };

export const MAX_EXTERNAL_INPUT_BYTES = 65_536;
/** Count arrays/objects from the payload root, excluding the request envelope. */
export const MAX_EXTERNAL_PAYLOAD_DEPTH = 32;
export const MAX_EXTERNAL_NOTIFICATION_TEXT_LENGTH = 16_000;

/** Validation failures deliberately contain no input, property names or cause. */
export class ExternalProtocolError extends Error {
  readonly code = 'invalid_input';
  constructor() { super('Invalid external request'); this.name = 'ExternalProtocolError'; }
}

const encoder = new TextEncoder();
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
function invalid(): never { throw new ExternalProtocolError(); }

/** Read data descriptors, never input getters or toJSON methods. Null-prototype
 * dictionaries are plain JSON; all other nonstandard prototypes are rejected. */
function fields(input: unknown, expected: readonly string[]): Record<string, PropertyDescriptor> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== expected.length || keys.some(key => typeof key !== 'string' || !expected.includes(key))) invalid();
  for (const key of expected) {
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
  }
  return descriptors;
}

function id(input: unknown): string {
  if (typeof input !== 'string' || !identifier.test(input)) invalid();
  return input;
}

function timestamp(input: unknown): string {
  if (typeof input !== 'string' || input.length > 40) invalid();
  const value = new Date(input);
  if (!Number.isFinite(value.getTime()) || value.toISOString() !== input) invalid();
  return input;
}

function payload(input: unknown): Json {
  const ancestors = new Set<object>();
  // Charge the expanded JSON while walking, before allocating each branch.
  // A small repeated-reference DAG can otherwise expand exponentially despite
  // depth limits. The final envelope check still includes IDs/reason/metadata.
  let remaining = MAX_EXTERNAL_INPUT_BYTES;
  const charge = (bytes: number): void => { remaining -= bytes; if (remaining < 0) invalid(); };
  const scalar = (value: string | number | boolean | null): void => {
    if (typeof value === 'string' && value.length > remaining) invalid();
    charge(encoder.encode(JSON.stringify(value)).byteLength);
  };
  const clone = (value: unknown, depth: number): Json => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') { scalar(value); return value; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) invalid();
      scalar(value); return value === 0 ? 0 : value;
    }
    if (typeof value !== 'object' || ancestors.has(value) || depth >= MAX_EXTERNAL_PAYLOAD_DEPTH) invalid();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) invalid();
    charge(2); // [] or {}
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string')) invalid();
    ancestors.add(value);
    try {
      if (array) {
        const length = descriptors['length'];
        if (!length || !Object.hasOwn(length, 'value') || length.enumerable || !Number.isSafeInteger(length.value)
          || length.value < 0 || keys.length !== length.value + 1) invalid();
        const result: Json[] = [];
        for (let index = 0; index < length.value; index++) {
          if (index) charge(1);
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
          result.push(clone(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: { [key: string]: Json } = {};
      let first = true;
      for (const key of (keys as string[]).sort()) {
        if (!first) charge(1); first = false;
        scalar(key); charge(1); // quoted key and colon
        const descriptor = descriptors[key]!;
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
        // Define own data so keys such as __proto__ remain ordinary JSON data.
        Object.defineProperty(result, key, { value: clone(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  return clone(input, 0);
}

function event(input: unknown): ExternalEvent {
  const value = fields(input, ['id', 'type', 'occurredAt', 'payload']);
  return { id: id(value['id']!.value), type: id(value['type']!.value), occurredAt: timestamp(value['occurredAt']!.value), payload: payload(value['payload']!.value) };
}

function parse<T>(read: () => T): T {
  try {
    const result = read();
    if (encoder.encode(JSON.stringify(result)).byteLength > MAX_EXTERNAL_INPUT_BYTES) invalid();
    return result;
  } catch {
    // Proxy traps and native validation failures must not leak supplied errors.
    throw new ExternalProtocolError();
  }
}

/** Returns a defensive JSON snapshot; retries must reuse every original field. */
export function parseExternalEvent(input: unknown): ExternalEvent { return parse(() => event(input)); }

/** Returns the complete atomic event/Wake envelope as a defensive snapshot. */
export function parseExternalWake(input: unknown): ExternalWake {
  return parse(() => {
    const value = fields(input, ['id', 'reason', 'event']);
    const reason: unknown = value['reason']!.value;
    if (typeof reason !== 'string' || reason.length > 4096 || !reason.trim()) invalid();
    return { id: id(value['id']!.value), reason, event: event(value['event']!.value) };
  });
}

/** Returns a defensive snapshot; text is preserved exactly, including spacing. */
export function parseExternalNotification(input: unknown): ExternalNotification {
  return parse(() => {
    const value = fields(input, ['id', 'occurredAt', 'text']);
    const text: unknown = value['text']!.value;
    if (typeof text !== 'string' || text.length > MAX_EXTERNAL_NOTIFICATION_TEXT_LENGTH || !text.trim()) invalid();
    return { id: id(value['id']!.value), occurredAt: timestamp(value['occurredAt']!.value), text };
  });
}

/** Checks only the receipt shape. Clients must also match the original request
 * and the HTTP inserted/duplicate status before accepting persistence. */
export function parseExternalReceipt(input: unknown): ExternalReceipt {
  return parse(() => {
    if (input === null || typeof input !== 'object') invalid();
    const discriminator = Object.getOwnPropertyDescriptor(input, 'operation');
    if (!discriminator || !Object.hasOwn(discriminator, 'value')) invalid();
    const operation: unknown = discriminator.value;
    if (operation !== 'event' && operation !== 'wake' && operation !== 'notification') invalid();
    const value = fields(input, operation === 'wake'
      ? ['operation', 'id', 'eventId', 'receipt', 'durability']
      : ['operation', 'id', 'receipt', 'durability']);
    const receipt: unknown = value['receipt']!.value;
    if ((receipt !== 'inserted' && receipt !== 'duplicate') || value['durability']!.value !== 'persisted') invalid();
    const common = { id: id(value['id']!.value), receipt: receipt as 'inserted' | 'duplicate', durability: 'persisted' as const };
    return operation === 'wake'
      ? { operation, ...common, eventId: id(value['eventId']!.value) }
      : { operation, ...common };
  });
}
