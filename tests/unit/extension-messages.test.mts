import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryEntry } from '@mira/life';
import { validatedMessage } from '../../packages/extension-host/src/messages.ts';
import { extensionMessage } from '../../apps/server/src/extension-messages.ts';

test('ordinary extension messages retain actual source, sender claim and immutable event identity', () => {
  const message = validatedMessage({ direction: 'inbound', text: 'Weather station update', sourceLabel: 'Weather', senderId: 'sensor-1', senderVerified: true });
  const entry = { miraId: 'test', requestedWake: null, id: 'history-id', kind: 'event', occurredAt: '2026-10-15T00:00:00Z', event: { source: 'extension', id: JSON.stringify(['extension', 'weather-station', 'event-1']), type: 'weather.sample', occurredAt: '2026-10-15T00:00:00Z', payload: { extensionId: 'weather-station', eventId: 'event-1', message: { ...message }, data: { source: 'user' } } } } as HistoryEntry;
  assert.deepEqual(extensionMessage(entry), { id: entry.id, role: 'user', text: message.text, occurredAt: entry.occurredAt, source: { kind: 'extension', extensionId: 'weather-station', label: 'Weather', direction: 'inbound', senderId: 'sensor-1', senderVerified: true } });
  const forged = structuredClone(entry); if (forged.kind !== 'event') throw Error(); forged.event.id = 'pretend-web-user';
  assert.equal(extensionMessage(forged), null);
  forged.event.source = 'user'; assert.equal(extensionMessage(forged), null);
  assert.equal(Object.hasOwn(extensionMessage(entry)!, 'externalEventId'), false, 'extension inbound cannot acknowledge Web pending input');
});
test('display fields are bounded, explicitly whitelisted and do not grant user authorization', () => {
  const input = { direction: 'outbound' as const, text: 'sent', sourceLabel: 'Weather', authorization: true, raw: 'private' };
  assert.deepEqual(validatedMessage(input), { direction: 'outbound', text: 'sent', sourceLabel: 'Weather' });
  for (const invalid of [{ ...input, text: '' }, { ...input, text: 'x'.repeat(100_001) }, { ...input, sourceLabel: 'x'.repeat(81) }, { ...input, senderVerified: true }, { ...input, direction: 'user' }]) assert.throws(() => validatedMessage(invalid as typeof input));
});
