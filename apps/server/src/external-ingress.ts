import { parseExternalEvent, parseExternalWake, parseExternalNotification, type ExternalEvent, type ExternalWake, type ExternalNotification, type ExternalReceipt } from '@mira/external-sdk';
import type { DurableWriter } from '@mira/life';

/** Called only with a sender identity bound by the server's ingress boundary.
 * Authentication proves provenance, never user approval for model-selected actions. */
export interface ExternalIngress {
  emitEvent(senderId: string, event: ExternalEvent): Promise<ExternalReceipt>;
  requestWake(senderId: string, wake: ExternalWake): Promise<ExternalReceipt>;
  sendNotification(senderId: string, notification: ExternalNotification): Promise<ExternalReceipt>;
}
function validateSender(senderId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(senderId)) throw Error('Invalid external sender');
}
function sourceEvent(senderId: string, event: ExternalEvent) {
  validateSender(senderId);
  return {
    id: JSON.stringify(['external', senderId, event.id]), type: event.type, source: 'external' as const,
    occurredAt: event.occurredAt, payload: { senderId, operation: 'event', eventId: event.id, data: event.payload },
  };
}
/** Same immutable event + optional Wake transaction as in-process extensions.
 * An existing event cannot be upgraded to a Wake or silently rewritten. */
export function createExternalIngress(writer: Pick<DurableWriter, 'receive'>, onInsertedWake: () => void): ExternalIngress {
  return {
    async sendNotification(senderId, input) {
      validateSender(senderId);
      const notification = parseExternalNotification(input);
      const receipt = await writer.receive({
        id: JSON.stringify(['external-notification', senderId, notification.id]),
        type: 'external.notification', source: 'external', occurredAt: notification.occurredAt,
        payload: { senderId, operation: 'notification', notificationId: notification.id, text: notification.text },
      });
      return { operation: 'notification', id: notification.id, receipt, durability: 'persisted' };
    },
    async emitEvent(senderId, input) {
      const event = parseExternalEvent(input);
      const receipt = await writer.receive(sourceEvent(senderId, event));
      return { operation: 'event', id: event.id, receipt, durability: 'persisted' };
    },
    async requestWake(senderId, input) {
      const wake = parseExternalWake(input);
      const receipt = await writer.receive(sourceEvent(senderId, wake.event), {
        id: JSON.stringify(['external', senderId, wake.id]), reason: wake.reason,
      });
      // Rechecking an uncertain HTTP response cannot restart failed cognition.
      if (receipt === 'inserted') onInsertedWake();
      return { operation: 'wake', id: wake.id, eventId: wake.event.id, receipt, durability: 'persisted' };
    },
  };
}
