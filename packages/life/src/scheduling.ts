import type { LifeEvent, WakeReceipt } from './index.ts';

/** One opaque delivery. Calendar interpretation and recurrence belong to callers. */
export interface ScheduledDeliveryInput {
  key: string;
  /** Canonical UTC ISO-8601 millisecond timestamp. */
  dueAt: string;
  expiresAt?: string;
  event: LifeEvent;
  wake?: WakeReceipt;
}
export interface ScheduledDelivery extends ScheduledDeliveryInput {
  owner: string;
  version: number;
  status: 'pending' | 'enqueued' | 'cancelled' | 'expired';
  createdAt: string;
  updatedAt: string;
}
export type ScheduledMutation =
  | { status: 'updated' | 'duplicate' | 'conflict' | 'settled'; delivery: ScheduledDelivery }
  | { status: 'missing'; delivery: null };
/** Optional capability on the same fenced writer. No separate worker or lease. */
export interface SchedulingWriter {
  createScheduledDelivery(owner: string, input: ScheduledDeliveryInput): Promise<ScheduledMutation>;
  getScheduledDelivery(owner: string, key: string): Promise<ScheduledDelivery | null>;
  listScheduledDeliveries(owner?: string): Promise<ScheduledDelivery[]>;
  replaceScheduledDelivery(owner: string, expectedVersion: number, input: ScheduledDeliveryInput): Promise<ScheduledMutation>;
  /** Settled/enqueued means cancellation cannot retract the Event or Wake. */
  cancelScheduledDelivery(owner: string, key: string, expectedVersion: number): Promise<ScheduledMutation>;
  /** Eligible owner identities are supplied from current host lifecycle state.
   * Due Event/Wake insertion and the enqueued marker commit atomically. */
  dispatchScheduledDeliveries(owners: readonly string[]): Promise<{ enqueued: number; nextDueAt: string | null }>;
}
