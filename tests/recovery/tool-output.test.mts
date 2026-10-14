import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHistoryTools, type RecoveredContext } from '@mira/runtime-pi';
import type { ToolCall } from '@earendil-works/pi-ai';
import type { HistoryTextPage } from '@mira/life';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, model, runtime, scripted, streamOf, toolCalls } from './fixtures.mts';
import { fullOutput, largeToolText, outputPath, outputSpool } from './tool-output-fixtures.mts';

const exec = promisify(execFile);
const worker = new URL('./tool-output-worker.mts', import.meta.url).pathname;
const guard = new URL('../deny-model-network.mts', import.meta.url).pathname;

test('real PostgreSQL process death after outcome commit restores full evidence, readable files and bounded provider projection without replay', async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-tool-output-postgres-');
  try {
    const miraId = 'large-output-process', spool = path.join(root, 'spool'), counter = path.join(root, 'effect');
    const child = (mode: string) => exec(process.execPath, ['--import', guard, worker, db.schema, miraId, mode, spool, counter], { timeout: 30_000, maxBuffer: 10_000_000 });
    await assert.rejects(child('crash-after-outcome'), error => error instanceof Error && 'code' in error && error.code === 75);
    const writer = await db.acquire(miraId), before = await writer.load();
    assert.ok(before.executions[0]?.outcome); await writer.close();
    const state = JSON.parse((await child('recover')).stdout) as RecoveredContext;
    assert.deepEqual(state.snapshot.executions, before.executions); assert.deepEqual(state.recovery.operations, []);
    const output = state.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
    assert.ok(!JSON.stringify(output.content).includes('FULL_ORIGINAL_TAIL'));
    assert.deepEqual(await fullOutput(output), before.executions[0]?.outcome?.payload);
    const original = await readFile(outputPath(output), 'utf8'); await rm(outputPath(output));
    const restarted = JSON.parse((await child('recover')).stdout) as RecoveredContext;
    assert.equal(await readFile(outputPath(output), 'utf8'), original);
    assert.deepEqual(restarted.snapshot.executions, before.executions);
    assert.equal(await readFile(counter, 'utf8'), 'once\n');
    const compactWriter = await db.acquire(miraId);
    const compacting = runtime(compactWriter, scripted([assistant('Recent answer'), assistant(`Earlier complete evidence is available at ${outputPath(output)}`)]), {
      model: { ...model, contextWindow: 200_000 }, writeOverflowInput: outputSpool(spool) });
    await compacting.run(input('Recent unrelated question'));
    const compacted = await compacting.compact({ keepRecentTokens: 256, reserveTokens: 512 });
    assert.ok(!compacted.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'durable-large'));
    assert.match(JSON.stringify(compacted.messages), /batch.txt/);
    await compactWriter.close(); await rm(outputPath(output));
    const archived = JSON.parse((await child('recover')).stdout) as RecoveredContext;
    assert.equal(await readFile(outputPath(output), 'utf8'), original, 'fresh process restores evidence outside the compacted tail');
    assert.deepEqual(archived.snapshot, compacted.snapshot, 'file recovery never changes durable history');
    assert.equal(await readFile(counter, 'utf8'), 'once\n');

  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real runtime history_read reaches a >1 MiB original tail through revision-bound pages across restart', async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-tool-output-history-');
  try {
    const writer = await db.acquire('history-large-tool');
    const original = { id: 'huge-original', type: 'fixture', source: 'external' as const, occurredAt: new Date().toISOString(), payload: { text: largeToolText.repeat(5) + 'BEYOND_ONE_MIB_TAIL' } };
    await writer.receive(original);
    const id = (await db.admin.query<{ history_id: string }>('SELECT history_id FROM life_events WHERE mira_id=$1 AND event_id=$2', [writer.miraId, original.id])).rows[0]!.history_id;
    let requests = 0, first: HistoryTextPage | undefined;
    const tools = createHistoryTools(db.store.history(writer.miraId));
    const call = (callId: string, args: ToolCall['arguments']) => ({ ...toolCalls(callId), content: [{ type: 'toolCall' as const, id: callId, name: 'history_read', arguments: args }] });
    const state = await runtime(writer, (_model, context) => {
      requests++;
      if (requests === 1) return streamOf(call('whole-too-large', { id, maxBytes: 1_048_576 }));
      const prior = context.messages.filter(message => message.role === 'toolResult').at(-1); assert.ok(prior?.role === 'toolResult');
      const text = prior.content[0]; assert.ok(text?.type === 'text');
      const response = JSON.parse(text.text);
      if (requests === 2) { assert.equal(response.error, 'too_large'); return streamOf(call('page-start', { id, offset: 0 })); }
      if (requests === 3) { first = response as HistoryTextPage; assert.ok(first.totalBytes > 1_048_576); return streamOf(call('page-tail', { id, offset: first.totalChars - 200, revision: first.revision })); }
      assert.equal(requests, 4); assert.match(response.text, /BEYOND_ONE_MIB_TAIL/); assert.equal(response.nextOffset, null);
      return streamOf(assistant('Read the first and tail pages; middle pages remain unreviewed.'));
    }, { model: { ...model, contextWindow: 200_000 }, tools, writeOverflowInput: outputSpool(path.join(root, 'spool')) }).run(input());
    assert.equal(state.snapshot.executions.length, 3); assert.ok(first);
    await writer.close();
    const restarted = await db.acquire('history-large-tool');
    const after = await runtime(restarted, undefined, { model: { ...model, contextWindow: 200_000 }, tools }).recover();
    assert.deepEqual(after.messages, state.messages);
    assert.equal((await db.store.history(restarted.miraId).readText({ id, offset: first.totalChars - 200, revision: first.revision }))?.nextOffset, null);
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
