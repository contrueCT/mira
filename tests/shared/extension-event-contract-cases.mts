import type { Json } from '@mira/extension-sdk';

/**
 * Spec for extension-visible Event/Wake receipts. The fake duplicates these
 * outcome strings on purpose; neither side imports the other's literals.
 * `unit/extension-fake-host.test.mts` runs every scenario against `createFakeHost`.
 * `recovery/extension-event-contract.test.mts` runs the same steps through the
 * real Host and PostgreSQL. That recovery file is the authority for restart
 * and History identity.
 */
export const EVENT_REUSED = 'Event ID was reused with different data or wake';
export const WAKE_TAKEN = 'Wake ID already belongs to another event';
export const ORIGINAL_WAKE_REASON = 'Synthetic source status matched the configured rule';

const TIMESTAMP = '2026-10-07T08:15:00.000Z';

export interface ContractEvent {
  id: string;
  type: string;
  occurredAt: string;
  payload: Json;
  message?: { direction: 'inbound' | 'outbound'; text: string; sourceLabel: string; senderId?: string; senderVerified?: boolean };
}
interface SourceFact extends ContractEvent {
  payload: {
    source: string;
    recordId: string;
    revision: string;
    occurredAt: string;
    data: { status: string; count: number; labels: string[]; optional: null };
  };
}
export interface ContractSubmission {
  event: ContractEvent;
  wake?: { id: string; reason: string };
}
export interface ContractStep {
  name: string;
  outcome: 'inserted' | 'duplicate' | 'event-content-conflict';
  message?: string;
  create(): ContractSubmission;
}
export interface ContractScenario {
  name: string;
  steps: ContractStep[];
}

export const detailedScenarioNames = ['event-only', 'event-and-wake'] as const;
export const replayScenarioNames = ['wake-id-reuse', 'normalization', 'extra-wake-field'] as const;
export const scenarioNames = [...detailedScenarioNames, ...replayScenarioNames] as const;

/** Fixed synthetic source fact. Production facts keep their own source timestamp. */
export function sourceObservation(revision = 'revision-1'): SourceFact {
  return {
    id: JSON.stringify(['source-record', 'record-7', revision]),
    type: 'fixture.source-fact',
    occurredAt: TIMESTAMP,
    payload: {
      source: 'synthetic-source', recordId: 'record-7', revision, occurredAt: TIMESTAMP,
      data: { status: 'failed', count: 2, labels: ['original', 'bounded'], optional: null },
    } satisfies Json,
  };
}

const step = (name: string, outcome: ContractStep['outcome'], create: () => ContractSubmission, message?: string): ContractStep =>
  message === undefined ? { name, outcome, create } : { name, outcome, message, create };

const originalWake = (event: ContractEvent) => ({ id: event.id, reason: ORIGINAL_WAKE_REASON });

function eventOnly(): ContractScenario {
  return {
    name: 'event-only',
    steps: [
      step('insert', 'inserted', () => ({ event: sourceObservation() })),
      step('duplicate', 'duplicate', () => ({ event: sourceObservation() })),
      step('add-wake', 'event-content-conflict', () => ({
        event: sourceObservation(),
        wake: { id: 'later-wake', reason: 'A later wake is a different delivery' },
      }), EVENT_REUSED),
      step('retry-after-conflict', 'duplicate', () => ({ event: sourceObservation() })),
    ],
  };
}

function eventAndWake(): ContractScenario {
  const changed = (name: string, create: () => ContractSubmission): ContractStep => step(name, 'event-content-conflict', create, EVENT_REUSED);
  return {
    name: 'event-and-wake',
    steps: [
      step('insert', 'inserted', () => { const event = sourceObservation(); return { event, wake: originalWake(event) }; }),
      step('duplicate', 'duplicate', () => { const event = sourceObservation(); return { event, wake: originalWake(event) }; }),
      changed('occurredAt', () => {
        const event = sourceObservation();
        return { event: { ...event, occurredAt: '2026-10-07T08:15:01.000Z' }, wake: originalWake(event) };
      }),
      changed('payload', () => {
        const event = sourceObservation();
        return { event: { ...event, payload: { ...event.payload, data: { ...event.payload.data, count: 3 } } }, wake: originalWake(event) };
      }),
      changed('type', () => {
        const event = sourceObservation();
        return { event: { ...event, type: 'fixture.changed-type' }, wake: originalWake(event) };
      }),
      changed('wake-reason', () => {
        const event = sourceObservation();
        return { event, wake: { id: event.id, reason: 'Changed reason for the same source fact' } };
      }),
      changed('wake-id', () => {
        const event = sourceObservation();
        return { event, wake: { id: 'changed-wake-id', reason: ORIGINAL_WAKE_REASON } };
      }),
      changed('remove-wake', () => ({ event: sourceObservation() })),
      step('revised', 'inserted', () => {
        const event = sourceObservation('revision-2');
        const revised: SourceFact = {
          ...event, occurredAt: '2026-10-07T08:16:00.000Z',
          payload: { ...event.payload, occurredAt: '2026-10-07T08:16:00.000Z', data: { ...event.payload.data, count: 3 } },
        };
        return { event: revised, wake: { id: revised.id, reason: ORIGINAL_WAKE_REASON } };
      }),
    ],
  };
}

function wakeIdReuse(): ContractScenario {
  const reason = 'Shared wake must stay on the first event';
  return {
    name: 'wake-id-reuse',
    steps: [
      step('insert', 'inserted', () => ({ event: sourceObservation(), wake: { id: 'shared-wake-id', reason } })),
      step('reused-wake', 'event-content-conflict', () => ({ event: sourceObservation('revision-2'), wake: { id: 'shared-wake-id', reason } }), WAKE_TAKEN),
      step('duplicate', 'duplicate', () => ({ event: sourceObservation(), wake: { id: 'shared-wake-id', reason } })),
      step('other-wake', 'inserted', () => ({ event: sourceObservation('revision-2'), wake: { id: 'other-wake-id', reason } })),
    ],
  };
}

function normalizationEvent(): ContractEvent {
  return {
    id: 'normalization-fact', type: 'fixture.normalization', occurredAt: '2026-10-07T09:00:00.000Z',
    payload: { b: 1, a: 2, n: -0, nested: { d: 4, c: 3 } },
  };
}

function normalization(): ContractScenario {
  return {
    name: 'normalization',
    steps: [
      step('insert', 'inserted', () => ({ event: normalizationEvent() })),
      step('reordered', 'duplicate', () => ({
        event: {
          id: 'normalization-fact', type: 'fixture.normalization', occurredAt: '2026-10-07T09:00:00.000Z',
          payload: { a: 2, b: 1, nested: { c: 3, d: 4 }, n: 0 },
        },
      })),
      step('extra-field', 'duplicate', () => ({ event: Object.assign(normalizationEvent(), { unexpected: true }) })),
      step('message', 'event-content-conflict', () => ({
        event: { ...normalizationEvent(), message: { direction: 'inbound', text: 'added later', sourceLabel: 'fixture' } },
      }), EVENT_REUSED),
      step('original-again', 'duplicate', () => ({ event: normalizationEvent() })),
    ],
  };
}

function extraWakeField(): ContractScenario {
  const event = () => sourceObservation('wake-extra');
  const reason = 'Keep the reason';
  return {
    name: 'extra-wake-field',
    steps: [
      step('insert', 'inserted', () => ({ event: event(), wake: { id: 'wake-extra-id', reason } })),
      step('extra-field', 'duplicate', () => ({
        event: event(),
        wake: Object.assign({ id: 'wake-extra-id', reason }, { unexpected: true }),
      })),
    ],
  };
}

export function contractScenarios(): ContractScenario[] {
  return [eventOnly(), eventAndWake(), wakeIdReuse(), normalization(), extraWakeField()];
}

export interface HostValidationCase {
  name: string;
  event: unknown;
  wake?: { id: unknown; reason: unknown };
  errorName: string;
  message: string;
}
const validEvent = (id = 'validation-event'): ContractEvent => ({ id, type: 'fixture.validation', occurredAt: TIMESTAMP, payload: null });

/** Host rejects these before `receive`. They are JSON so a config path can carry them. */
export function hostValidationCases(): HostValidationCase[] {
  const eventError = 'Event requires a stable ID, type and timestamp';
  const wakeError = 'Wake needs a stable ID and reason';
  const messageError = 'Invalid extension message projection';
  return [
    { name: 'empty-id', event: { ...validEvent(), id: '' }, errorName: 'Error', message: eventError },
    { name: 'empty-type', event: { ...validEvent(), type: '' }, errorName: 'Error', message: eventError },
    { name: 'bad-timestamp', event: { ...validEvent(), occurredAt: 'not-a-date' }, errorName: 'Error', message: eventError },
    { name: 'null-event', event: null, errorName: 'TypeError', message: "Cannot read properties of null (reading 'id')" },
    { name: 'empty-wake-id', event: validEvent(), wake: { id: '', reason: 'because' }, errorName: 'Error', message: wakeError },
    { name: 'blank-wake-reason', event: validEvent(), wake: { id: 'wake-1', reason: '   ' }, errorName: 'Error', message: wakeError },
    { name: 'null-wake-reason', event: validEvent(), wake: { id: 'wake-1', reason: null }, errorName: 'TypeError', message: "Cannot read properties of null (reading 'trim')" },
    { name: 'numeric-wake-reason', event: validEvent(), wake: { id: 'wake-1', reason: 1 }, errorName: 'TypeError', message: 'request.reason.trim is not a function' },
    { name: 'missing-wake-reason', event: validEvent(), wake: { id: 'wake-1' } as { id: unknown; reason: unknown }, errorName: 'TypeError', message: "Cannot read properties of undefined (reading 'trim')" },
    { name: 'wake-checked-before-event', event: null, wake: { id: '', reason: 'because' }, errorName: 'Error', message: wakeError },
    { name: 'empty-message-text', event: { ...validEvent(), message: { direction: 'inbound', text: '', sourceLabel: 'fixture' } }, errorName: 'Error', message: messageError },
    { name: 'bad-message-direction', event: { ...validEvent(), message: { direction: 'sideways', text: 'hello', sourceLabel: 'fixture' } }, errorName: 'Error', message: messageError },
    { name: 'sender-verified-without-sender', event: { ...validEvent(), message: { direction: 'inbound', text: 'hello', sourceLabel: 'fixture', senderVerified: true } }, errorName: 'Error', message: messageError },
    { name: 'null-message', event: { ...validEvent(), message: null }, errorName: 'Error', message: messageError },
  ];
}

export interface WriterValidationCase {
  name: string;
  event: unknown;
  errorName: string;
  message: string;
  code?: 'invalid';
}
/** Passes the host's id/type/timestamp checks, then fails in the writer's JSON copy or string checks. */
export function writerValidationCases(): WriterValidationCase[] {
  const base = { id: 'writer-invalid', type: 'fixture.validation', occurredAt: TIMESTAMP };
  const extra = [1, 2] as Json[] & { note?: string };
  extra.note = 'x';
  const sparse = [1, 2, 3];
  delete sparse[1];
  return [
    { name: 'infinity', event: { ...base, payload: { value: Infinity } }, errorName: 'Error', message: 'Expected finite, acyclic JSON' },
    { name: 'undefined', event: { ...base, payload: { missing: undefined } }, errorName: 'Error', message: 'Expected finite, acyclic JSON' },
    { name: 'date', event: { ...base, payload: { at: new Date(TIMESTAMP) } }, errorName: 'Error', message: 'Expected plain JSON object' },
    { name: 'array-extra', event: { ...base, id: 'array-extra', payload: extra }, errorName: 'Error', message: 'JSON arrays must be dense and have no extra properties' },
    { name: 'sparse-array', event: { ...base, id: 'sparse-array', payload: sparse }, errorName: 'Error', message: 'JSON arrays must be dense and have no extra properties' },
    { name: 'occurredAt-zero', event: { ...base, occurredAt: 0, payload: null }, errorName: 'PersistenceError', message: 'Invalid timestamp', code: 'invalid' },
    { name: 'type-number', event: { ...base, type: 1, payload: null }, errorName: 'PersistenceError', message: 'Invalid event type', code: 'invalid' },
    { name: 'occurredAt-date', event: { ...base, occurredAt: new Date(TIMESTAMP), payload: null }, errorName: 'Error', message: 'Expected plain JSON object' },
  ];
}

export interface NormalizedDelivery {
  name: string;
  /** Fresh value. `structuredClone` already normalizes these before the writer. */
  event(): unknown;
  storedPayload: unknown;
}
export function hostNormalizedDeliveries(): NormalizedDelivery[] {
  return [
    { name: 'symbol-key', storedPayload: { kept: 1 }, event: () => {
      const payload: Record<string | symbol, Json> = { kept: 1 };
      payload[Symbol('hidden')] = 2;
      return { id: 'symbol-key', type: 'fixture.normalization', occurredAt: TIMESTAMP, payload };
    } },
    { name: 'null-prototype', storedPayload: { status: 'ok' }, event: () => {
      const payload = Object.create(null) as { status: string };
      payload.status = 'ok';
      return { id: 'null-prototype', type: 'fixture.normalization', occurredAt: TIMESTAMP, payload };
    } },
  ];
}

export interface CloneRejectionCase {
  name: string;
  payload(): unknown;
}
/** `structuredClone` rejects these before the writer. Messages embed the value's own source text. */
export function cloneRejectionCases(): CloneRejectionCase[] {
  return [
    { name: 'function', payload: () => ({ fn() {} }) },
    { name: 'symbol', payload: () => ({ token: Symbol('v') }) },
  ];
}
