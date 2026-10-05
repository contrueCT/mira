import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { runDemo } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';
import type { LifeEvent } from '@mira/life';

const event = (id: string): LifeEvent => ({ id, type: 'synthetic-message', source: 'user', occurredAt: '2026-10-05T00:00:00.000Z', payload: { text: `Synthetic message ${id}` } });

test('server composition coalesces, restarts same Mira, deduplicates and leaves event-only history asleep', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const spool = await mkdtemp('/tmp/mira-demo-pg-');
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'demo-mira', sourceDirectory: process.cwd(), spoolDirectory: spool };
    const events = ['a', 'b', 'c'].map(id => ({ event: event(id), wake: { id: `wake-${id}`, reason: 'message' } }));
    const first = await runDemo({ ...options, events });
    assert.equal(first.completedRuns, 1); assert.equal(first.modelCalls, 1);
    const duplicate = await runDemo({ ...options, events });
    assert.equal(duplicate.completedRuns, 0); assert.equal(duplicate.modelCalls, 0); assert.equal(duplicate.version, first.version);
    const historyOnly = await runDemo({ ...options, events: [{ event: event('history') }] });
    assert.equal(historyOnly.modelCalls, 0); assert.equal(historyOnly.version, first.version);
    const second = await runDemo({ ...options, events: [{ event: event('d'), wake: { id: 'wake-d', reason: 'next message' } }] });
    assert.equal(second.miraId, first.miraId); assert.equal(second.completedRuns, 1); assert.ok(second.version > first.version);
    const runs = await db.admin.query('SELECT completed FROM wake_runs WHERE mira_id = $1', [first.miraId]);
    assert.equal(runs.rows.length, 2); assert.ok(runs.rows.every(row => row.completed));
  } finally { await db.close(); await rm(spool, { recursive: true, force: true }); }
});

test('overflow is one run and the model can read the ordinary file through the ordinary tool', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const spool = await mkdtemp('/tmp/mira-demo-overflow-');
  let calls = 0; let filePath = ''; let observedToolText = '';
  try {
    const outcome = await runDemo({ connectionString: db.connectionString, schema: db.schema, miraId: 'overflow-mira', sourceDirectory: process.cwd(), spoolDirectory: spool, maxInlineBytes: 1,
      events: ['a', 'b', 'c'].map(id => ({ event: event(id), wake: { id: `wake-${id}`, reason: 'message' } })),
      streamFn: (_model, context) => {
        calls++;
        if (calls === 1) {
          const user = context.messages.find(message => message.role === 'user');
          const text = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content);
          const match = /stored at ("[^"\n]+")/.exec(text ?? '');
          if (!match) throw Error('Missing ordinary file path in overflow notice');
          filePath = JSON.parse(match[1]!);
          return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'ordinary-read', name: 'read', arguments: { path: filePath } }] });
        }
        const result = context.messages.find(message => message.role === 'toolResult');
        observedToolText = JSON.stringify(result?.content);
        return streamOf(assistant('Read the synthetic file.'));
      },
    });
    assert.equal(outcome.completedRuns, 1); assert.equal(calls, 2); // One turn, tool round trip.
    assert.match(filePath, /batch\.txt$/);
    const content = await readFile(filePath, 'utf8');
    for (const id of ['a', 'b', 'c']) { assert.match(content, new RegExp(`Synthetic message ${id}`)); assert.match(observedToolText, new RegExp(`Synthetic message ${id}`)); }
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 1);
  } finally { await db.close(); await rm(spool, { recursive: true, force: true }); }
});
