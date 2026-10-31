import { serviceKey, type Cleanup, type ExtensionContext, type ExtensionEvent, type ExtensionMessage, type ExtensionTool, type ExtensionWake, type Json } from './index.ts';

/**
 * Error shape an extension sees when the writer rejects a delivery.
 * `name` is `PersistenceError` so extension code can branch on the same name
 * the host surfaces. This is not the writer's `DurableOperationError`: the private
 * `event-content-conflict` brand lives in `@mira/life`, which this package
 * cannot import. Use `isEventContentConflict` for the observable check.
 */
export class FakePersistenceError extends Error {
  readonly code: 'duplicate' | 'invalid';
  constructor(code: 'duplicate' | 'invalid', message: string) {
    super(message);
    this.name = 'PersistenceError';
    this.code = code;
  }
}

/** True for a real writer conflict and for the fake's copy of that observable shape. */
export function isEventContentConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  return candidate.name === 'PersistenceError' && candidate.code === 'duplicate'
    && (candidate.message === 'Event ID was reused with different data or wake' || candidate.message === 'Wake ID already belongs to another event');
}

/** JSON clone of one accepted event, in insertion order. Conflicts are absent. */
export interface FakeRecordedEvent {
  id: Json;
  type: string;
  occurredAt: string;
  payload: Json;
  message?: ExtensionMessage;
}
/** JSON clone of one accepted Wake, in insertion order. */
export interface FakeRecordedWake {
  id: Json;
  reason: string;
  eventId: Json;
}
/** One successful `emitEvent` or `requestWake` call. Conflicts are absent. */
export interface FakeEventReceipt {
  operation: 'event' | 'wake';
  /** String ids are kept; any other JSON id is `JSON.stringify`'d. */
  eventId: string;
  wakeId?: string;
  receipt: 'inserted' | 'duplicate';
}
export interface FakeRegisteredTool {
  name: string;
  description: string;
  parameters: ExtensionTool['parameters'];
  execute: ExtensionTool['execute'];
}
export interface FakeInterval {
  callback: () => void;
  milliseconds: number;
}
export interface FakeHostOptions {
  /** Installation id. Defaults to `fake-extension`. One fake is one extension namespace. */
  id?: string;
  /** Unprefixed names from `defineExtension({ requires })`. */
  requires?: readonly string[];
}
export interface FakeHost {
  readonly id: string;
  emitEvent(event: ExtensionEvent): Promise<'inserted' | 'duplicate'>;
  requestWake(request: ExtensionWake): Promise<'inserted' | 'duplicate'>;
  events(): FakeRecordedEvent[];
  wakes(): FakeRecordedWake[];
  receipts(): FakeEventReceipt[];
  tools(): FakeRegisteredTool[];
  intervals(): FakeInterval[];
  /** Registered callbacks in registration order. Functions are not cloned. */
  cleanups(): Cleanup[];
  /** Context for `apply`. Event and Wake methods share this fake's store. */
  extensionContext(): ExtensionContext;
}

/**
 * Stateful stand-in for the event and Wake receipt API extensions actually await.
 *
 * The same event id with a deeply identical JSON body and the same Wake choice
 * (none, or the same id and reason) returns `duplicate`. The first delivery
 * returns `inserted`. A changed field, or adding, removing, or retargeting the
 * Wake, rejects. A Wake id that already belongs to another event rejects. Stored
 * values are JSON clones, so later mutation of the caller's objects does not
 * rewrite history. Object key order is not part of body equality. `-0` is
 * normalized to `0`, matching the writer's JSON round-trip.
 *
 * Conflict errors use `name: 'PersistenceError'` and `code: 'duplicate'` with
 * the writer's messages and no public `category`. `DurableOperationError.categoryOf`
 * on them is `undefined`. `instanceof PersistenceError` is false.
 *
 * One fake is one extension namespace. It does not model a shared writer across
 * extensions, process restart, History UUIDs, the Wake queue, dreaming, owner
 * fencing, retired activations, real timers, schedules, credentials, settings,
 * or toolset stale execution. `extensionContext()` throws for those APIs.
 * Tool registration checks the host's name, description, execute, and plain
 * finite JSON object rules. It does not compile JSON Schema.
 */
export function createFakeHost(options?: FakeHostOptions): FakeHost {
  const extensionId = options?.id ?? 'fake-extension';
  const required = new Set(options?.requires ?? []);
  const provided = new Set<string>();
  const services = new Map<string, unknown>();
  const eventsById = new Map<string, { event: FakeRecordedEvent; wake: { id: Json; reason: string } | null }>();
  const wakeOwners = new Map<string, string>();
  const eventOrder: string[] = [];
  const wakeOrder: string[] = [];
  const receiptLog: FakeEventReceipt[] = [];
  const toolList: FakeRegisteredTool[] = [];
  const intervalList: FakeInterval[] = [];
  const cleanupList: Cleanup[] = [];
  const listeners = new Map<string, Set<(payload: Json) => void>>();

  const record = (outcome: 'inserted' | 'duplicate', event: FakeRecordedEvent, wake: { id: Json; reason: string } | null): void => {
    const eventId = typeof event.id === 'string' ? event.id : JSON.stringify(event.id);
    receiptLog.push(wake
      ? { operation: 'wake', eventId, wakeId: typeof wake.id === 'string' ? wake.id : JSON.stringify(wake.id), receipt: outcome }
      : { operation: 'event', eventId, receipt: outcome });
  };
  const commit = (event: ExtensionEvent, wake: { id: string; reason: string } | null): 'inserted' | 'duplicate' => {
    const lifeId = JSON.stringify(['extension', extensionId, event.id]);
    const life = {
      id: lifeId, type: event.type, source: 'extension', occurredAt: event.occurredAt,
      payload: { extensionId, eventId: event.id, data: event.payload, ...(event.message === undefined ? {} : { message: event.message }) },
    };
    const lifeWake = wake === null ? null : { id: JSON.stringify(['extension', extensionId, wake.id]), reason: wake.reason };
    assertJson(life);
    if (lifeWake !== null) assertJson(lifeWake);
    if (typeof life.type !== 'string' || life.type.length === 0) throw new FakePersistenceError('invalid', 'Invalid event type');
    if (typeof life.occurredAt !== 'string' || life.occurredAt.length === 0 || !Number.isFinite(Date.parse(life.occurredAt))) throw new FakePersistenceError('invalid', 'Invalid timestamp');
    if (lifeWake !== null && (typeof lifeWake.id !== 'string' || lifeWake.id.length === 0)) throw new FakePersistenceError('invalid', 'Invalid wake ID');
    if (lifeWake !== null && (typeof lifeWake.reason !== 'string' || lifeWake.reason.length === 0)) throw new FakePersistenceError('invalid', 'Invalid wake reason');
    const canonical = JSON.parse(JSON.stringify({
      id: event.id, type: event.type, occurredAt: event.occurredAt, payload: event.payload,
      ...(event.message === undefined ? {} : { message: event.message }),
    })) as FakeRecordedEvent;
    const canonicalWake = wake === null ? null : JSON.parse(JSON.stringify({ id: wake.id, reason: wake.reason })) as { id: Json; reason: string };
    const previous = eventsById.get(lifeId);
    if (previous) {
      if (!deepEqual(previous.event, canonical) || !deepEqual(previous.wake, canonicalWake)) throw new FakePersistenceError('duplicate', 'Event ID was reused with different data or wake');
      record('duplicate', canonical, canonicalWake);
      return 'duplicate';
    }
    if (lifeWake !== null && wakeOwners.has(lifeWake.id)) throw new FakePersistenceError('duplicate', 'Wake ID already belongs to another event');
    eventsById.set(lifeId, { event: canonical, wake: canonicalWake });
    eventOrder.push(lifeId);
    if (lifeWake !== null) { wakeOwners.set(lifeWake.id, lifeId); wakeOrder.push(lifeWake.id); }
    record('inserted', canonical, canonicalWake);
    return 'inserted';
  };
  // Parameter name `event` matches the host so property-access failures stay on `id`.
  async function emitEvent(event: ExtensionEvent): Promise<'inserted' | 'duplicate'> {
    return commit(validatedEvent(event), null);
  }
  // `request` and `request.reason.trim` match the host's source text for TypeError messages.
  async function requestWake(request: ExtensionWake): Promise<'inserted' | 'duplicate'> {
    if (!request.id || !request.reason.trim()) throw new Error('Wake needs a stable ID and reason');
    return commit(validatedEvent(request.event), { id: request.id, reason: request.reason });
  }
  const unsupported = (name: string): never => { throw new Error(`createFakeHost does not implement ${name}`); };
  const context: ExtensionContext = {
    id: extensionId,
    privateDirectory: null,
    credentials: {
      get: async () => unsupported('credentials'),
      has: async () => unsupported('credentials'),
      set: async () => unsupported('credentials'),
      delete: async () => unsupported('credentials'),
    },
    schedules: {
      create: async () => unsupported('schedules'),
      get: async () => unsupported('schedules'),
      list: async () => unsupported('schedules'),
      replace: async () => unsupported('schedules'),
      cancel: async () => unsupported('schedules'),
    },
    registerSettings: () => unsupported('registerSettings'),
    registerToolset: () => unsupported('registerToolset'),
    registerContextProvider: () => unsupported('registerContextProvider'),
    registerTool: candidate => {
      const { name, description, parameters, execute } = candidate;
      if (typeof name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)) throw new Error('Invalid extension tool name: use 1-64 ASCII letters, digits, underscores or hyphens, starting with a letter or underscore');
      if (typeof description !== 'string' || !description.trim() || typeof execute !== 'function') throw new Error('Invalid extension tool');
      if (!parameters || parameters.type !== 'object' || (parameters.required !== undefined && (!Array.isArray(parameters.required) || !parameters.required.every(item => typeof item === 'string'))) || (parameters.properties !== undefined && (typeof parameters.properties !== 'object' || parameters.properties === null || Array.isArray(parameters.properties)))) throw new Error('Invalid extension tool schema');
      const seen = new Set<object>();
      const visit = (value: unknown): void => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return;
        if (typeof value !== 'object' || seen.has(value)) throw new Error('Extension schema must be finite JSON');
        seen.add(value);
        if (Array.isArray(value)) for (const item of value) visit(item);
        else {
          if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Extension schema must be plain JSON');
          for (const item of Object.values(value)) visit(item);
        }
        seen.delete(value);
      };
      visit(parameters);
      if (toolList.some(tool => tool.name === name)) throw new Error(`Duplicate registered tool: ${name}`);
      toolList.push({ name, description, parameters: structuredClone(parameters), execute: execute.bind(candidate) });
    },
    emitEvent,
    requestWake,
    provideService: (name, value) => { const key = serviceKey(name); provided.add(name); services.set(key, value); },
    service: <T>(name: string): T => {
      const key = serviceKey(name);
      if (!services.has(key)) {
        if (!required.has(name) && !provided.has(name)) throw new Error(`Declare required service: ${name}`);
        throw new Error(`Required service unavailable: ${name}`);
      }
      return services.get(key) as T;
    },
    onCleanup: cleanup => { cleanupList.push(cleanup); },
    onEvent: (name, listener) => {
      const current = listeners.get(name) ?? new Set<(payload: Json) => void>();
      current.add(listener);
      listeners.set(name, current);
    },
    publish: (name, payload) => { for (const listener of listeners.get(name) ?? []) listener(structuredClone(payload)); },
    interval: (callback, milliseconds) => {
      if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new Error('Interval must be positive');
      intervalList.push({ callback, milliseconds });
    },
  };
  return {
    id: extensionId,
    emitEvent,
    requestWake,
    events: () => eventOrder.map(key => structuredClone(eventsById.get(key)!.event)),
    wakes: () => wakeOrder.map(key => {
      const stored = eventsById.get(wakeOwners.get(key)!)!;
      return structuredClone({ id: stored.wake!.id, reason: stored.wake!.reason, eventId: stored.event.id });
    }),
    receipts: () => receiptLog.map(item => ({ ...item })),
    tools: () => toolList.map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) })),
    intervals: () => intervalList.map(item => ({ ...item })),
    cleanups: () => [...cleanupList],
    extensionContext: () => context,
  };
}

function validatedEvent(event: ExtensionEvent): ExtensionEvent {
  if (!event.id || !event.type || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error('Event requires a stable ID, type and timestamp');
  return { id: event.id, type: event.type, occurredAt: event.occurredAt, payload: structuredClone(event.payload), ...(event.message === undefined ? {} : { message: validatedMessage(event.message) }) };
}
function validatedMessage(value: ExtensionMessage): ExtensionMessage {
  const text = (item: unknown, max: number): item is string => typeof item === 'string' && item.length > 0 && item.length <= max && !/[\u0000\u0008\u000b\u000c]/u.test(item);
  const label = (item: unknown, max: number): item is string => text(item, max) && !/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(item);
  if (!value || !['inbound', 'outbound'].includes(value.direction) || !text(value.text, 100_000) || !label(value.sourceLabel, 80)
    || (value.senderId !== undefined && !label(value.senderId, 512))
    || (value.senderVerified !== undefined && (typeof value.senderVerified !== 'boolean' || !value.senderId))) throw new Error('Invalid extension message projection');
  return { direction: value.direction, text: value.text, sourceLabel: value.sourceLabel,
    ...(value.senderId === undefined ? {} : { senderId: value.senderId }), ...(value.senderVerified === undefined ? {} : { senderVerified: value.senderVerified }) };
}

/** Same acceptance rules as the writer's JSON copy. Kept here so the SDK stays dependency-free. */
function assertJson(value: unknown): void {
  const seen = new Set<object>();
  const visit = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || item === null || seen.has(item)) throw new Error('Expected finite, acyclic JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error('Expected plain JSON object');
    if (Object.getOwnPropertySymbols(item).length) throw new Error('JSON cannot contain symbol keys');
    if (Array.isArray(item) && (Object.keys(item).length !== item.length || Array.from({ length: item.length }, (_, index) => Object.hasOwn(item, index)).some(present => !present))) throw new Error('JSON arrays must be dense and have no extra properties');
    seen.add(item);
    for (const child of Object.values(item)) visit(child);
    seen.delete(item);
  };
  visit(value);
}
function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  if (keys.length !== Object.keys(rightRecord).length) return false;
  return keys.every(key => Object.hasOwn(rightRecord, key) && deepEqual(leftRecord[key], rightRecord[key]));
}
