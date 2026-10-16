import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LocalWebService } from '@mira/server';
import type { JsonObject, TranscriptContext } from '@earendil-works/pi-ai';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';
import type { TerminalResult } from '../../apps/server/src/terminals.ts';

async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!await check()) { if (Date.now() > deadline) throw Error(message); await new Promise(resolve => setTimeout(resolve, 10)); }
}
function call(id: string, name: string, args: JsonObject) {
  return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id, name, arguments: args }] });
}
function outcome(context: TranscriptContext, id: string): TerminalResult {
  const message = context.messages.findLast(message => message.role === 'toolResult' && message.toolCallId === id);
  assert.ok(message?.role === 'toolResult');
  return JSON.parse(message.content.filter(item => item.type === 'text').map(item => item.text).join('\n')) as TerminalResult;
}

test('real PG/service terminal survives completed wakes; close/restart preserves evidence and never replays', { timeout: 45_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-terminal-pg-')); let service: LocalWebService | undefined;
  let calls = 0; let session: TerminalResult | undefined; const effect = path.join(root, 'effect');
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'terminal-service', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, autoCompaction: { enabled: false }, dreaming: { enabled: false },
    syntheticStream: (_model: unknown, context: TranscriptContext) => {
      calls++;
      if (calls === 1) return call('start-terminal', 'exec_command', { command: `printf once >> ${JSON.stringify(effect)}; printf ready; read line; printf "received:%s" "$line"; read more`, yield_ms: 1000 });
      if (calls === 2) { session = outcome(context, 'start-terminal'); assert.equal(session.status, 'running'); assert.equal(session.output, 'ready'); return streamOf(assistant('Process is waiting between turns')); }
      if (calls === 3) return call('write-terminal', 'write_stdin', { session_id: session!.session_id, offset: session!.next_offset, chars: 'hello\n', yield_ms: 1000 });
      if (calls === 4) { session = outcome(context, 'write-terminal'); assert.equal(session.output, 'received:hello'); return streamOf(assistant('Input was received')); }
      if (calls === 5) return call('read-old-terminal', 'write_stdin', { session_id: session!.session_id, offset: session!.next_offset, yield_ms: 0 });
      assert.equal(calls, 6); assert.equal(outcome(context, 'read-old-terminal').status, 'unavailable'); return streamOf(assistant('Old handle is unavailable; no replay'));
    } };
  const submit = async (id: string) => {
    await service!.submit({ id, text: id, occurredAt: new Date().toISOString() });
    await until(async () => (await service!.status()).state !== 'working', 'Wake did not settle');
    assert.equal((await service!.status()).state, 'idle');
  };
  try {
    service = await LocalWebService.open(options); await submit('first-turn'); await submit('second-turn');
    assert.equal(calls, 4); assert.equal(await readFile(effect, 'utf8'), 'once');
    const prior = (await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows;
    assert.ok(session?.log_index); const index = JSON.parse(await readFile(session.log_index, 'utf8')) as { chunks: { path: string }[] };
    assert.equal((await Promise.all(index.chunks.map(chunk => readFile(chunk.path, 'utf8')))).join(''), 'readyreceived:hello');
    await service.close(); service = undefined; service = await LocalWebService.open(options);
    await until(async () => (await service!.status()).state !== 'working', 'Recovery did not settle');
    assert.equal(calls, 4); assert.equal(await readFile(effect, 'utf8'), 'once');
    assert.deepEqual((await db.admin.query('SELECT envelope FROM context_records ORDER BY version')).rows, prior);
    await submit('third-turn'); assert.equal(calls, 6); assert.equal(await readFile(effect, 'utf8'), 'once');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 3);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('real PG/service live input waits for the current bounded terminal call then skips old siblings', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-terminal-live-')); let service: LocalWebService | undefined;
  let calls = 0; const entered = path.join(root, 'entered'); const forbidden = path.join(root, 'forbidden');
  const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'terminal-live', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
    spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true, autoCompaction: { enabled: false }, dreaming: { enabled: false },
    syntheticStream: (_model: unknown, context: TranscriptContext) => {
      if (++calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'current-terminal', name: 'exec_command', arguments: { command: `touch ${JSON.stringify(entered)}; sleep 0.4; printf done`, yield_ms: 2000 } },
        { type: 'toolCall', id: 'old-sibling', name: 'exec_command', arguments: { command: `touch ${JSON.stringify(forbidden)}`, yield_ms: 0 } },
      ] });
      assert.equal(calls, 2); assert.match(JSON.stringify(context.messages), /new-direction/);
      assert.equal(outcome(context, 'current-terminal').output, 'done');
      return streamOf(assistant('Updated direction after current call'));
    } };
  try {
    service = await LocalWebService.open(options);
    await service.submit({ id: 'initial', text: 'Start work', occurredAt: new Date().toISOString() });
    await until(async () => stat(entered).then(() => true, () => false), 'Terminal never started');
    await service.submit({ id: 'new-direction', text: 'new-direction', occurredAt: new Date().toISOString() });
    await until(async () => (await service!.status()).state !== 'working', 'Live input did not settle');
    assert.equal((await service.status()).state, 'idle'); assert.equal(calls, 2);
    await assert.rejects(stat(forbidden), { code: 'ENOENT' });
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM tool_executions')).rows[0].n, 1);
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
