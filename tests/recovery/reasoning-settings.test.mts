import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, model, streamOf } from './fixtures.mts';

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > deadline) throw Error('Reasoning service did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('PostgreSQL Web settings drive main, child and Dreaming reasoning and remain authoritative after restart', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await mkdtemp('/tmp/mira-reasoning-service-'); let service: LocalWebService | undefined;
  const requests: { kind: string; level: string | undefined }[] = []; let spawned = false;
  try {
    const stream: StreamFn = (_model, context, options) => {
      const system = getCurrentSystemMessage(context.messages);
      const child = !!system && getSystemMessageText(system).includes('task-scoped worker');
      const latest = context.messages.filter(message => message.role === 'user').at(-1);
      const kind = child ? 'child' : JSON.stringify(latest).includes('memory.dreaming') ? 'dreaming' : 'main';
      requests.push({ kind, level: options?.reasoning });
      if (!child && !spawned) { spawned = true; return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'reasoning-child', name: 'subagent_spawn', arguments: { task: 'A synthetic reasoning check' } }] }); }
      return streamOf(assistant(kind === 'dreaming' ? '' : `Synthetic ${kind} answer`));
    };
    const configuration = { connectionString: db.connectionString, schema: db.schema, miraId: 'reasoning-service', sourceDirectory: process.cwd(), workingDirectory: root, miraHome: root,
      spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), memoryRoot: path.join(root, 'memory'), synthetic: true,
      syntheticModel: { ...model, reasoning: true, contextWindow: 100_000 }, syntheticStream: stream, dreaming: { intervalMs: 10 }, autoCompaction: { enabled: false } };
    service = await LocalWebService.open(configuration);
    await until(async () => (await service!.status()).state === 'idle');
    const initial = await service.settings();
    await service.saveSettings({ ...initial, configuration: { ...initial.configuration, defaultThinkingLevel: 'high' } });
    await service.submit({ id: 'reasoning-first', text: 'Run the synthetic child', occurredAt: '2026-10-14T01:00:00Z' });
    await until(async () => (await service!.status()).state === 'idle' && requests.some(item => item.kind === 'child') && requests.filter(item => item.kind === 'main').length >= 3 && (await db.admin.query("SELECT count(*) FROM life_events WHERE event->>'type'='subagent.result'")).rows[0].count === '1');
    assert.ok(requests.filter(item => item.kind === 'main').length >= 2); assert.ok(requests.every(item => item.level === 'high'));
    await db.admin.query("UPDATE dreaming_progress SET last_triggered_at = clock_timestamp() - interval '25 hours', idle_since = clock_timestamp() - interval '31 minutes'");
    await service.settings();
    await until(() => requests.some(item => item.kind === 'dreaming'));
    await until(async () => (await service!.status()).state === 'idle');
    assert.equal(requests.find(item => item.kind === 'dreaming')!.level, 'high');
    const current = await service.settings();
    await service.saveSettings({ ...current, configuration: { ...current.configuration, defaultThinkingLevel: 'low' } });
    await service.close(); service = await LocalWebService.open(configuration);
    assert.equal((await service.settings()).configuration.defaultThinkingLevel, 'low');
    const before = requests.length;
    await service.submit({ id: 'reasoning-after-restart', text: 'Continue the same Mira', occurredAt: '2026-10-14T01:01:00Z' });
    await until(async () => requests.length > before && (await service!.status()).state === 'idle');
    assert.equal(requests.at(-1)!.level, 'low');
    const records = await db.admin.query("SELECT envelope FROM context_records WHERE mira_id='reasoning-service'");
    assert.ok(JSON.stringify(records.rows).includes('Run the synthetic child'));
    assert.equal((await db.admin.query("SELECT count(*) FROM subagents")).rows[0].count, '1');
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
