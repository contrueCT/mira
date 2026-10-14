import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PiDurableRuntime, type PiRuntimeActivity } from '@mira/runtime-pi';
import { MemoryWriter, assistant, streamOf, model, seed, input } from '../recovery/fixtures.mts';

async function history(writer: MemoryWriter) {
  await seed(writer, [
    { role: 'system', content: 'Task-scoped read-only worker. Do not publish.', timestamp: 1000 },
    input('Read the assigned sources'), assistant('source findings '.repeat(200)),
    input('Continue the investigation'), assistant('more source findings '.repeat(200)), input('Preserve source IDs'),
  ]);
}

test('summary activity observer failure stops before provider dispatch and checkpoint', async () => {
  const writer = new MemoryWriter(); await history(writer); let requests = 0;
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task',
    streamFn: () => { requests++; return streamOf(assistant('summary')); },
    onActivity: async event => { if (event.phase === 'started') throw Error('synthetic activity write failure'); } });
  await assert.rejects(runtime.compact({ keepRecentTokens: 200 }), /synthetic activity write failure/);
  assert.equal(requests, 0); assert.equal(writer.state.records.filter(record => record.kind === 'checkpoint').length, 0);
});

test('summary activity distinguishes durable checkpoint completion from cancellation after append', async () => {
  const writer = new MemoryWriter(); await history(writer); const events: PiRuntimeActivity[] = []; const controller = new AbortController();
  const append = writer.append.bind(writer);
  writer.append = async (version, record, signal) => {
    const next = await append(version, record, signal);
    if (record.kind === 'checkpoint') { controller.abort(Error('cancel after checkpoint commit')); throw Error('lost append response'); }
    return next;
  };
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(assistant('summary')),
    onActivity: async event => { events.push(event); } });
  await assert.rejects(runtime.compact({ keepRecentTokens: 200, signal: controller.signal }));
  assert.equal(writer.state.records.filter(record => record.kind === 'checkpoint').length, 1);
  assert.deepEqual(events.map(event => [event.name, event.phase, event.status]), [
    ['context-compaction', 'started', null], ['context-compaction', 'finished', 'completed'],
  ]);
});

test('summary publication failure reports failed activity and never completes the checkpoint', async () => {
  const writer = new MemoryWriter(); await history(writer); const events: PiRuntimeActivity[] = [];
  writer.beforeAppend = async record => { if (record.kind === 'checkpoint') throw Error('synthetic checkpoint failure'); };
  const runtime = new PiDurableRuntime({ writer, model, compactionScope: 'task', streamFn: () => streamOf(assistant('summary')),
    onActivity: async event => { events.push(event); } });
  await assert.rejects(runtime.compact({ keepRecentTokens: 200 }), /synthetic checkpoint failure/);
  assert.equal(writer.state.records.filter(record => record.kind === 'checkpoint').length, 0);
  assert.equal(events.at(-1)?.status, 'failed');
});
