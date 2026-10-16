import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { prepareWakeTurn } from '@mira/life';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { writeWakeInput } from '@mira/workspace';
import { checkpointReplyIndex, messageReplies, messageReplySources } from '../../packages/runtime-pi/src/replies.ts';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, model, seed, streamOf } from './fixtures.mts';

test('real PostgreSQL: original reply metadata and index chains survive compaction, deleted files and writer restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-pg-reply-context-');
  try {
    const writer = await db.acquire('reply-context');
    const writeOverflowInput = (runId: string, content: string) => writeWakeInput({ rootDirectory: root, sourceDirectory: process.cwd(), runId, content });
    const options = { model: { ...model, contextWindow: 65536 }, autoCompaction: { enabled: false }, writeOverflowInput };
    await seed(writer, [input('Earlier question'), assistant('Original target response')]);
    const targetId = (await writer.load()).records.at(-1)!.id;
    const reply = { messageId: targetId, role: 'assistant' as const, text: 'Original target response' };
    await writer.receive({ id: 'reply-event', type: 'web.message', source: 'user', occurredAt: '2026-10-16T00:00:00.000Z',
      payload: { text: 'Please explain this response', messageFormatVersion: 1, reply } }, { id: 'reply-wake', reason: 'User message from the local web interface' });
    const run = await writer.claimWakeBatch(); assert.ok(run);
    await new PiDurableRuntime({ ...options, writer, streamFn: (_model, context) => {
      const visible = JSON.stringify(context.messages); assert.ok(visible.includes(run.requests[0]!.eventId)); assert.ok(visible.includes(targetId));
      return streamOf(assistant('Explanation'));
    } }).continueTurn(await prepareWakeTurn(run, writeOverflowInput, 65_536));
    await writer.completeWakeRun(run.id);
    const prefix = structuredClone((await writer.load()).records);
    const pointers: Array<{ path: string; bytes: number }> = [];
    for (let index = 0; index < 2; index++) {
      const runtime = new PiDurableRuntime({ ...options, writer, streamFn: () => streamOf(assistant('Summary excludes all IDs and reply text.')) });
      await runtime.run(input(`Recent tail ${index}`));
      const compacted = await runtime.compact({ keepRecentTokens: 1 });
      const checkpoint = compacted.entries.findLast(entry => entry.type === 'compaction')!;
      pointers.push(checkpointReplyIndex(checkpoint)!);
      const node = JSON.parse(await readFile(pointers[index]!.path, 'utf8'));
      assert.deepEqual(node.previous, index ? pointers[index - 1] : null);
      if (!index) assert.deepEqual(node.sources.find((source: { replies: unknown[] }) => source.replies.length).replies, [{ messageId: run.requests[0]!.eventId, reply }]);
    }
    const saved = await writer.load(); assert.deepEqual(saved.records.slice(0, prefix.length), prefix);
    const expected = await Promise.all(pointers.map(pointer => readFile(pointer.path, 'utf8')));
    await writer.close(); await Promise.all(pointers.map(pointer => rm(pointer.path)));
    const restarted = await db.acquire('reply-context');
    const recovered = await new PiDurableRuntime({ ...options, writer: restarted, streamFn: () => { throw Error('Restart cannot call the model'); } }).recover();
    assert.deepEqual(recovered.snapshot, saved);
    assert.deepEqual(await Promise.all(pointers.map(pointer => readFile(pointer.path, 'utf8'))), expected);
    const source = recovered.entries.find(entry => entry.type === 'message' && messageReplySources(entry.message).some(item => item.messageId === run.requests[0]!.eventId));
    assert.equal(source?.type, 'message'); assert.deepEqual(messageReplies(source.message), [{ messageId: run.requests[0]!.eventId, reply }]);
    await new PiDurableRuntime({ ...options, writer: restarted, streamFn: (_model, context) => {
      assert.ok(JSON.stringify(context.messages).includes(pointers.at(-1)!.path));
      return streamOf(assistant('Continued with durable reply references'));
    } }).run(input('Continue after restart'));
  } finally { await db.close(); await rm(root, { recursive: true, force: true }); }
});
