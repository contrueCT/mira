import type { ExtensionHostOptions } from '@mira/extension-host';
import type { ScheduledDelivery, ScheduledDeliveryInput, ScheduledMutation, SchedulingWriter } from '@mira/life';

type Factory = NonNullable<ExtensionHostOptions['schedules']>;
type Service = ReturnType<Factory>;
type Input = Parameters<Service['create']>[0];
type Delivery = NonNullable<Awaited<ReturnType<Service['get']>>>;
/** Domain data remains opaque to Life. Only this ingress assembly binds origin
 * and reserves a namespace disjoint from immediate extension events. */
export function extensionScheduling(writer: SchedulingWriter): Factory {
  return (owner, extensionId) => {
    const input = (value: Input): ScheduledDeliveryInput => ({
      key: value.key, dueAt: value.dueAt, ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
      event: { id: JSON.stringify(['scheduled', owner, value.key, 'event']), type: value.event.type,
        source: 'extension', occurredAt: value.event.occurredAt,
        payload: { extensionId, eventId: value.event.id, data: value.event.payload, ...(value.event.message === undefined ? {} : { scheduleOwner: owner, scheduleKey: value.key, message: { ...value.event.message } }),
          ...(value.wake ? { wakeId: value.wake.id } : {}) } },
      ...(value.wake ? { wake: { id: JSON.stringify(['scheduled', owner, value.key, 'wake']), reason: value.wake.reason } } : {}),
    });
    const delivery = (value: ScheduledDelivery): Delivery => {
      const payload = value.event.payload as unknown as { eventId: string; data: Input['event']['payload']; wakeId?: string; message?: Input['event']['message'] };
      return { key: value.key, dueAt: value.dueAt, ...(value.expiresAt === undefined ? {} : { expiresAt: value.expiresAt }),
        event: { id: payload.eventId, type: value.event.type, occurredAt: value.event.occurredAt, payload: payload.data, ...(payload.message === undefined ? {} : { message: payload.message }) },
        ...(value.wake ? { wake: { id: payload.wakeId!, reason: value.wake.reason } } : {}),
        version: value.version, status: value.status, createdAt: value.createdAt, updatedAt: value.updatedAt };
    };
    const result = (value: ScheduledMutation): Awaited<ReturnType<Service['create']>> => value.status === 'missing'
      ? value : { status: value.status, delivery: delivery(value.delivery) };
    return {
      create: async value => result(await writer.createScheduledDelivery(owner, input(value))),
      get: async key => { const value = await writer.getScheduledDelivery(owner, key); return value ? delivery(value) : null; },
      list: async () => (await writer.listScheduledDeliveries(owner)).map(delivery),
      replace: async (version, value) => result(await writer.replaceScheduledDelivery(owner, version, input(value))),
      cancel: async (key, version) => result(await writer.cancelScheduledDelivery(owner, key, version)),
    };
  };
}

/** A timer is merely a wake-up hint. Every pass rechecks PostgreSQL; the bounded
 * rescan also observes wall-clock corrections and Cordis dependency/HMR changes. */
export class DeliveryTimer {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | undefined;
  #again = false;
  #closed = false;
  readonly #check: () => Promise<string | null>;
  readonly #onError: (error: unknown) => void;
  constructor(check: () => Promise<string | null>, onError: (error: unknown) => void) { this.#check = check; this.#onError = onError; }
  schedule(): void {
    if (this.#closed) return;
    clearTimeout(this.#timer); this.#timer = undefined;
    if (this.#running) { this.#again = true; return; }
    this.#running = Promise.resolve().then(this.#check).then(next => {
      if (this.#closed || this.#again) return;
      const remaining = next === null ? 30_000 : Date.parse(next) - Date.now();
      // PostgreSQL decides eligibility. A locally overdue hint can still be
      // future on its clock; never turn clock skew into a millisecond SQL loop.
      const delay = remaining <= 0 ? 1_000 : Math.min(30_000, remaining);
      if (!Number.isFinite(delay)) throw new Error('Invalid delivery deadline');
      this.#timer = setTimeout(() => { this.#timer = undefined; this.schedule(); }, delay);
      this.#timer.unref();
    }).catch(error => { this.#again = false; this.#onError(error); }).finally(() => {
      this.#running = undefined;
      if (this.#again && !this.#closed) { this.#again = false; this.schedule(); }
    });
  }
  async close(): Promise<void> {
    this.#closed = true; this.#again = false;
    clearTimeout(this.#timer); this.#timer = undefined;
    await this.#running;
  }
}
