import assert from 'node:assert/strict';
import test from 'node:test';
import { DurableOperationError } from '@mira/life';
import { PersistenceError } from '@mira/persistence';
import type { ExtensionEvent, ExtensionWake, Json } from '@mira/extension-sdk';
import { FakePersistenceError, createFakeHost, isEventContentConflict, type FakeHost } from '@mira/extension-sdk/testing';
import {
  cloneRejectionCases, contractScenarios, detailedScenarioNames, hostNormalizedDeliveries, hostValidationCases,
  replayScenarioNames, scenarioNames, sourceObservation, writerValidationCases, type ContractScenario, type ContractSubmission,
} from '../shared/extension-event-contract-cases.mts';

const TIMESTAMP = '2026-10-07T08:15:00.000Z';

function deliver(host: FakeHost, submission: ContractSubmission): Promise<'inserted' | 'duplicate'> {
  if (submission.wake) return host.requestWake({ ...submission.wake, event: submission.event });
  return host.emitEvent(submission.event);
}

async function runScenario(scenario: ContractScenario): Promise<FakeHost> {
  const host = createFakeHost();
  const receipts: Array<'inserted' | 'duplicate'> = [];
  const operations: Array<'event' | 'wake'> = [];
  let events = 0;
  let wakes = 0;
  for (const item of scenario.steps) {
    const submission = item.create();
    if (item.outcome === 'event-content-conflict') {
      await assert.rejects(() => deliver(host, submission), (error: unknown) => {
        assert.equal(isEventContentConflict(error), true, `${scenario.name}/${item.name}`);
        assert.ok(error instanceof FakePersistenceError, item.name);
        assert.equal(error instanceof PersistenceError, false, item.name);
        assert.equal(error.message, item.message, item.name);
        assert.equal(error.code, 'duplicate', item.name);
        assert.equal(DurableOperationError.categoryOf(error), undefined, item.name);
        assert.equal(Object.hasOwn(error, 'category'), false, item.name);
        return true;
      }, item.name);
    } else {
      assert.equal(await deliver(host, submission), item.outcome, `${scenario.name}/${item.name}`);
      receipts.push(item.outcome);
      operations.push(submission.wake ? 'wake' : 'event');
      if (item.outcome === 'inserted') { events += 1; if (submission.wake) wakes += 1; }
    }
    assert.deepEqual(host.receipts().map(entry => entry.receipt), receipts, item.name);
    assert.deepEqual(host.receipts().map(entry => entry.operation), operations, item.name);
    assert.equal(host.events().length, events, item.name);
    assert.equal(host.wakes().length, wakes, item.name);
  }
  return host;
}

test('shared scenario names are the cases both the fake and PostgreSQL run', () => {
  assert.deepEqual(contractScenarios().map(item => item.name), [...scenarioNames]);
  assert.deepEqual(detailedScenarioNames, ['event-only', 'event-and-wake']);
  assert.deepEqual([...detailedScenarioNames, ...replayScenarioNames], [...scenarioNames]);
});

test('createFakeHost agrees with every shared Event and Wake case', async () => {
  for (const scenario of contractScenarios()) {
    const host = await runScenario(scenario);
    if (scenario.name === 'event-only') assert.deepEqual(host.events()[0], sourceObservation());
    if (scenario.name === 'event-and-wake') {
      const inserted = scenario.steps[0]!.create();
      const revised = scenario.steps.at(-1)!.create();
      assert.deepEqual(host.events()[0], inserted.event);
      assert.deepEqual(host.events()[1], revised.event);
      assert.deepEqual(host.wakes()[0], { id: inserted.wake!.id, reason: inserted.wake!.reason, eventId: inserted.event.id });
      assert.deepEqual(host.wakes()[1], { id: revised.wake!.id, reason: revised.wake!.reason, eventId: revised.event.id });
    }
    if (scenario.name === 'normalization') {
      const payload = host.events()[0]!.payload as { n: number; a: number; b: number };
      assert.equal(Object.is(payload.n, 0), true);
      assert.equal(payload.a, 2);
      assert.equal(payload.b, 1);
      assert.equal(host.events().length, 1);
    }
    if (scenario.name === 'wake-id-reuse') {
      assert.equal(host.wakes()[0]!.id, 'shared-wake-id');
      assert.equal(host.wakes()[1]!.id, 'other-wake-id');
      assert.notEqual(host.wakes()[0]!.eventId, host.wakes()[1]!.eventId);
    }
  }
});

test('stored events are clones, and two fakes do not share a namespace', async () => {
  const host = createFakeHost();
  const event = sourceObservation();
  const expected = structuredClone(event);
  assert.equal(await host.emitEvent(event), 'inserted');
  event.payload.data.count = 9;
  assert.deepEqual(host.events()[0], expected);
  const inspected = host.events()[0]!;
  (inspected.payload as { data: { count: number } }).data.count = 8;
  assert.deepEqual(host.events()[0], expected);
  host.receipts().pop();
  assert.equal(host.receipts().length, 1);
  const other = createFakeHost({ id: 'other-extension' });
  assert.equal(await other.emitEvent(expected), 'inserted');
  assert.equal(host.events().length, 1);
  assert.equal(other.events().length, 1);
});

test('conflict classification matches the observable writer shape and not the private brand', () => {
  const real = new PersistenceError('duplicate', 'Event ID was reused with different data or wake', 'event-content-conflict');
  const taken = new PersistenceError('duplicate', 'Wake ID already belongs to another event', 'event-content-conflict');
  assert.equal(isEventContentConflict(real), true);
  assert.equal(isEventContentConflict(taken), true);
  assert.equal(DurableOperationError.categoryOf(real), 'event-content-conflict');
  assert.equal(isEventContentConflict(new PersistenceError('duplicate', 'different message', 'event-content-conflict')), false);
  assert.equal(isEventContentConflict({ name: 'PersistenceError', code: 'duplicate', category: 'event-content-conflict', message: 'Event ID was reused with different data or wake' }), true);
});

test('host validation errors match the shared cases', async () => {
  const host = createFakeHost();
  for (const item of hostValidationCases()) {
    await assert.rejects(async () => {
      if (item.wake) await host.requestWake({ id: item.wake.id, reason: item.wake.reason, event: item.event } as ExtensionWake);
      else await host.emitEvent(item.event as ExtensionEvent);
    }, (error: unknown) => {
      assert.ok(error instanceof Error, item.name);
      assert.equal(error.name, item.errorName, item.name);
      assert.equal(error.message, item.message, item.name);
      assert.equal(Object.hasOwn(error, 'code'), false, item.name);
      return true;
    });
  }
  assert.deepEqual(host.events(), []);
  assert.deepEqual(host.receipts(), []);
});

test('writer validation errors match the shared cases and leave the fake usable', async () => {
  const host = createFakeHost();
  for (const item of writerValidationCases()) {
    await assert.rejects(() => host.emitEvent(item.event as ExtensionEvent), (error: unknown) => {
      assert.ok(error instanceof Error, item.name);
      assert.equal(error.name, item.errorName, item.name);
      assert.equal(error.message, item.message, item.name);
      if (item.code) {
        assert.ok(error instanceof FakePersistenceError, item.name);
        assert.equal(error.code, item.code, item.name);
        assert.equal(error instanceof PersistenceError, false, item.name);
        assert.equal(DurableOperationError.categoryOf(error), undefined, item.name);
      } else assert.equal(error instanceof FakePersistenceError, false, item.name);
      return true;
    });
  }
  assert.deepEqual(host.events(), []);
  assert.equal(await host.emitEvent(sourceObservation('after-invalid')), 'inserted');
  assert.equal(host.events().length, 1);
});

test('structuredClone normalization is what a later exact body observes', async () => {
  const host = createFakeHost();
  for (const item of hostNormalizedDeliveries()) {
    const event = item.event() as ExtensionEvent;
    assert.equal(await host.emitEvent(event), 'inserted', item.name);
  }
  assert.deepEqual(host.events().map(event => event.payload), hostNormalizedDeliveries().map(item => item.storedPayload));
  const plain = hostNormalizedDeliveries().map(item => item.storedPayload);
  for (const [index, item] of hostNormalizedDeliveries().entries()) {
    const event = item.event() as ExtensionEvent;
    assert.equal(await host.emitEvent({ id: event.id, type: event.type, occurredAt: event.occurredAt, payload: plain[index] as Json }), 'duplicate', item.name);
  }
});

test('values structuredClone cannot copy reject before a receipt', async () => {
  const host = createFakeHost();
  for (const item of cloneRejectionCases()) {
    await assert.rejects(() => host.emitEvent({ id: item.name, type: 'fixture.validation', occurredAt: TIMESTAMP, payload: item.payload() as Json }), (error: unknown) => {
      assert.ok(error instanceof Error, item.name);
      assert.equal(error.name, 'DataCloneError', item.name);
      assert.match(error.message, /could not be cloned/, item.name);
      return true;
    });
  }
  assert.deepEqual(host.receipts(), []);
});

test('numeric event ids stay distinct from their string form', async () => {
  const host = createFakeHost();
  const body = { type: 'fixture.validation', occurredAt: TIMESTAMP, payload: null };
  assert.equal(await host.emitEvent({ ...body, id: 1 } as unknown as ExtensionEvent), 'inserted');
  assert.equal(await host.emitEvent({ ...body, id: '1' }), 'inserted');
  assert.equal(host.events()[0]!.id, 1);
  assert.equal(host.events()[1]!.id, '1');
});

test('extensionContext captures tools, services, listeners and timers without running them', async () => {
  const host = createFakeHost({ id: 'local-template-test', requires: ['clock'] });
  const context = host.extensionContext();
  assert.equal(context.id, 'local-template-test');
  assert.equal(context.privateDirectory, null);
  assert.throws(() => context.service('missing'), /Declare required service: missing/);
  assert.throws(() => context.service('clock'), /Required service unavailable: clock/);
  context.provideService('clock', { hour: 1 });
  assert.deepEqual(context.service<{ hour: number }>('clock'), { hour: 1 });
  const seen: Json[] = [];
  context.onEvent('ping', payload => seen.push(payload));
  context.onEvent('ping', payload => { if (payload && typeof payload === 'object' && !Array.isArray(payload)) payload['mutated'] = true; });
  context.publish('ping', { value: 1 });
  assert.deepEqual(seen, [{ value: 1 }]);
  assert.throws(() => context.interval(() => {}, 0), /Interval must be positive/);
  let ticks = 0;
  context.interval(() => { ticks += 1; }, 5);
  assert.equal(host.intervals().length, 1);
  assert.equal(host.intervals()[0]!.milliseconds, 5);
  host.intervals()[0]!.callback();
  assert.equal(ticks, 1);
  let cleaned = 0;
  context.onCleanup(() => { cleaned += 1; });
  await host.cleanups()[0]!();
  assert.equal(cleaned, 1);
  const tool = { name: 'hello_world', description: 'Hi', parameters: { type: 'object' as const }, async execute() { return { text: 'ok' }; } };
  context.registerTool(tool);
  assert.equal(host.tools()[0]!.name, 'hello_world');
  assert.deepEqual(await host.tools()[0]!.execute(null, { callId: 'c', signal: new AbortController().signal }), { text: 'ok' });
  assert.throws(() => context.registerTool(tool), /Duplicate registered tool: hello_world/);
  assert.throws(() => context.registerTool({ ...tool, name: 'bad name' }), /Invalid extension tool name/);
  await assert.rejects(context.credentials.get('token'), /createFakeHost does not implement credentials/);
  assert.throws(() => context.registerToolset([]), /createFakeHost does not implement registerToolset/);
  assert.throws(() => context.registerSettings({ fields: [], actions: [], status: () => ({ state: 'unconfigured' }) }), /createFakeHost does not implement registerSettings/);
});
