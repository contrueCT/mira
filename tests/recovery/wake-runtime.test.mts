import assert from 'node:assert/strict';
import test from 'node:test';
import { Type, type TranscriptContext } from '@earendil-works/pi-ai';
import { renderWakeBatch } from '@mira/life';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, effectTool, result, runtime, scripted, streamOf, toolCalls } from './fixtures.mts';

test('real PostgreSQL: one Wake continues through unknown effect and read-only verification before atomic final', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('one-mira');
    await writer.receive({ id: 'request-1', type: 'user.message', source: 'user', occurredAt: '2026-10-05T08:00:00Z', payload: { text: 'Perform the synthetic operation and check its receipt' } }, { id: 'wake-1', reason: 'User request' });
    const run = await writer.claimWakeBatch(); assert.ok(run);
    const turn = { id: run.id, input: renderWakeBatch(run), occurredAt: run.claimedAt, inputRecordId: null, finalRecordId: null };
    const effects: string[] = []; const requests: TranscriptContext[] = [];
    const query = { ...toolCalls('receipt-query'), content: [{ type: 'toolCall' as const, id: 'receipt-query', name: 'query', arguments: {} }] };
    await runtime(writer, scripted([toolCalls('unknown-operation', 'unstarted-sibling'), query, assistant('Receipt remains unknown; I can continue other work')], (_model, context) => { requests.push(structuredClone(context)); return streamOf(assistant()); }), {
      tools: [effectTool(async id => { effects.push(id); throw Error('synthetic receipt loss after effect'); }),
        { name: 'query', label: 'query', description: 'Synthetic read-only receipt lookup', parameters: Type.Object({}), execute: async id => { effects.push(id); return result; } }],
    }).continueTurn(turn);
    assert.deepEqual(effects, ['unknown-operation', 'receipt-query']);
    assert.equal(requests.length, 3); assert.match(JSON.stringify(requests[1]), /may already have executed/);
    const savedRun = await writer.loadWakeRun(run.id); assert.ok(savedRun.inputRecordId); assert.ok(savedRun.finalRecordId);
    const saved = await writer.load();
    assert.equal(saved.executions.find(execution => execution.intent.callId === 'unknown-operation')!.outcome, null);
    assert.equal(saved.records.filter(record => (record.payload as { message?: { role: string } }).message?.role === 'user').length, 1);
    assert.equal(saved.records.at(-1)!.id, savedRun.finalRecordId);
    await assert.rejects(writer.finishTool({ callId: 'unknown-operation', occurredAt: new Date(1000).toISOString(),
      payload: { role: 'toolResult', toolCallId: 'unknown-operation', toolName: 'effect', content: [{ type: 'text', text: 'Late external receipt' }], isError: false, timestamp: 1000 } }),
    error => error instanceof Error && 'code' in error && error.code === 'version');
    assert.deepEqual(await writer.load(), saved);
    const afterLateReceipt = await runtime(writer).recover();
    assert.equal(afterLateReceipt.recovery.operations[0]?.status, 'outcome-unknown');
    await writer.close();
    const replacement = await db.acquire('one-mira');
    await runtime(replacement, () => { throw Error('Saved final must not rerun the model'); }).continueTurn({ ...turn, inputRecordId: 'stale-input', finalRecordId: 'stale-final' });
    await replacement.completeWakeRun(run.id);
    assert.equal(await replacement.claimWakeBatch(), null);
    assert.deepEqual((await replacement.load()).records, saved.records);
  } finally { await db.close(); }
});

test('real PostgreSQL: natural-language deferral preserves a reason and finishes Wake by asking the user', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire();
    await writer.receive({ id: 'request', type: 'user.message', source: 'user', occurredAt: '2026-10-05T08:00:00Z', payload: { text: 'Send it there' } }, { id: 'wake', reason: 'User request needs clarification' });
    const run = await writer.claimWakeBatch(); assert.ok(run); let effects = 0;
    await runtime(writer, scripted([toolCalls('deferred'), assistant('Which destination did you mean?')]), {
      tools: [effectTool(async () => { effects++; return result; })],
      authorize: async () => ({ allowed: false, reason: 'The destination is ambiguous in the user’s natural-language request' }),
    }).continueTurn({ id: run.id, input: renderWakeBatch(run), occurredAt: run.claimedAt, inputRecordId: null, finalRecordId: null });
    const recovered = await runtime(writer).recover();
    assert.equal(effects, 0); assert.equal(recovered.snapshot.executions.length, 0);
    assert.match(recovered.recovery.operations[0]!.reason!, /destination is ambiguous/);
    assert.ok((await writer.loadWakeRun(run.id)).finalRecordId);
  } finally { await db.close(); }
});

test('real PostgreSQL: nested multi-key recovery arguments and canonical notice survive json roundtrip', async () => {
  const db = await createTestDatabase();
  try {
    const writer = await db.acquire('argument-order');
    const args = { z: 'first key', a: { y: 2, b: 1 } };
    const call = { ...toolCalls('ordered-arguments'), content: [{ type: 'toolCall' as const, id: 'ordered-arguments', name: 'effect', arguments: args }] };
    const first = await runtime(writer, scripted([call, assistant('Receipt unavailable')]), {
      tools: [{ ...effectTool(async () => { throw Error('synthetic interrupted effect'); }),
        parameters: Type.Object({ z: Type.String(), a: Type.Object({ y: Type.Number(), b: Type.Number() }) }) }],
    }).run({ role: 'user', content: 'Synthetic request with ordered nested arguments', timestamp: 1000 });
    const notice = first.entries.find(entry => entry.type === 'custom_message'); assert.ok(notice?.type === 'custom_message');
    assert.match(String(notice.content), /"z":"first key","a":\{"y":2,"b":1\}/);
    assert.deepEqual(first.recovery.operations[0]!.requestedArguments, args);
    const snapshot = structuredClone(first.snapshot);
    await writer.close();
    const replacement = await db.acquire('argument-order');
    const recovered = await runtime(replacement).recover();
    assert.deepEqual(recovered.snapshot, snapshot);
    assert.deepEqual(recovered.recovery, first.recovery);
    assert.deepEqual(Object.keys(recovered.recovery.operations[0]!.requestedArguments as object), ['z', 'a']);
  } finally { await db.close(); }
});
