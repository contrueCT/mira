import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { getCurrentSystemPrompt, type TranscriptContext } from '@earendil-works/pi-ai';
import { MiraLifeHost, SimulatedCrash, personaPresets, resetJournalFile, memoryRefreshFile, restoreArchivedLife, type LifeHostOptions, type ResetStep, type ResetView } from '@mira/server';
import { migrate } from '@mira/persistence';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

type Db = Awaited<ReturnType<typeof createTestDatabase>>;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const exists = (file: string) => stat(file).then(() => true, () => false);
async function settled(host: MiraLifeHost): Promise<void> {
  const deadline = Date.now() + 15_000;
  while ((await host.status()).state === 'working') {
    if (Date.now() > deadline) throw Error('Service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function finished(host: MiraLifeHost, id: string): Promise<ResetView> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const view = host.resetStatus(id)!;
    if (view.state === 'completed' || view.state === 'failed') return view;
    if (Date.now() > deadline) throw Error(`Reset stuck in ${view.state}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const memoryText = (context: TranscriptContext) => /<memory_state>([\s\S]*?)<\/memory_state>/.exec(getCurrentSystemPrompt(context.messages))?.[1] ?? getCurrentSystemPrompt(context.messages);
async function setup(slot: string, db: Db, extra: Partial<LifeHostOptions> = {}, seen: TranscriptContext[] = []) {
  const root = await realpath(await mkdtemp(`/tmp/mira-reset-${slot}-`));
  const options: LifeHostOptions = { slot, miraHome: root, ...extra, service: { connectionString: db.connectionString, schema: db.schema, sourceDirectory: process.cwd(),
    spoolDirectory: path.join(root, 'wake-input'), settingsFile: path.join(root, 'models.json'), memoryRoot: path.join(root, 'memory'), miraHome: root,
    synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
    syntheticStream: async (_model: unknown, context: TranscriptContext) => { seen.push(context); return streamOf(assistant(`Reply ${seen.length}`)); } } };
  return { root, options, seen };
}
const count = async (db: Db, table: string, miraId: string) => Number((await db.admin.query(`SELECT count(*) FROM ${table} WHERE mira_id = $1`, [miraId])).rows[0].count);

test('从头开始 starts a new life: archive, cancel deliveries, keep persona, fresh context; CLI restore round-trips', { timeout: 90_000 }, async () => {
  const db = await createTestDatabase(); const { root, options, seen } = await setup('lifeb', db);
  let host: MiraLifeHost | undefined;
  try {
    host = await MiraLifeHost.open(options); await settled(host);
    assert.equal(host.lifeId, 'lifeb'); assert.equal((await host.status()).lifeId, 'lifeb');
    const persona = await host.backend.persona();
    await host.backend.savePersona(persona.revision, structuredClone(personaPresets.find(item => item.id === 'partner')!.persona!));
    await host.backend.submit({ id: 'b-1', text: 'remember that I like oolong', occurredAt: '2026-10-30T01:00:00.000Z' }); await settled(host);
    await writeFile(path.join(options.service.memoryRoot, 'MEMORY.md'), '- likes oolong\n');
    await writeFile(path.join(options.service.memoryRoot, 'notes.md'), 'old notes\n');
    await db.admin.query(`INSERT INTO scheduled_deliveries(mira_id, owner_id, schedule_key, due_at, input) VALUES ($1, 'reminders', 'tea', '2030-01-01T00:00:00Z', $2)`,
      ['lifeb', JSON.stringify({ key: 'tea', dueAt: '2030-01-01T00:00:00.000Z', event: { id: 'tea', type: 'reminder', source: 'extension', occurredAt: '2026-10-30T01:00:00.000Z', payload: {} } })]);
    const before = { history: await count(db, 'history_records', 'lifeb'), context: await count(db, 'context_records', 'lifeb') };
    const repository = JSON.parse(await readFile(path.join(options.service.memoryRoot, '.git', 'mira-memory-workspace.json'), 'utf8')).repositoryId as string;

    const preview = await host.backend.previewReset('life');
    assert.deepEqual(preview.impact, { memoryFiles: 2, memoryBytes: 25, compactions: 0, messages: 2, pendingWakes: 0, pendingDeliveries: 1 });
    assert.deepEqual(preview.persona, { name: '小满', custom: true });
    assert.deepEqual(preview.busy, { running: false, subagents: 0 });
    assert.match(preview.archivePath!, new RegExp(`^${root}/archive/lifeb-\\d{4}-\\d\\d-\\d\\dT\\d{6}Z$`));
    await assert.rejects(host.backend.reset({ scope: 'memory', token: preview.token, stopRunning: false, resetPersona: false }), { code: 'conflict' }, 'a token is bound to its scope');
    const fresh = await host.backend.previewReset('life');
    const { resetId } = await host.backend.reset({ scope: 'life', token: fresh.token, stopRunning: false, resetPersona: false });
    await assert.rejects(host.backend.reset({ scope: 'life', token: fresh.token, stopRunning: false, resetPersona: false }), { code: 'busy' });
    const view = await finished(host, resetId);
    assert.equal(view.state, 'completed', view.error ?? ''); assert.equal(view.lifeId, 'lifeb~g1');
    await assert.rejects(host.backend.reset({ scope: 'life', token: fresh.token, stopRunning: false, resetPersona: false }), { code: 'conflict' }, 'tokens are single use');
    assert.equal(host.lifeId, 'lifeb~g1'); assert.equal((await host.status()).lifeId, 'lifeb~g1');
    assert.deepEqual((await host.backend.timeline()).items, [], 'the new life starts with an empty Timeline');
    assert.deepEqual((await host.status()).identity, { name: '小满', ring: 'sky', avatar: null }, 'persona is kept by default');
    assert.equal(await exists(resetJournalFile(root)), false);
    // Old life: rows untouched, pending one-shot cancelled, files archived intact.
    assert.deepEqual({ history: await count(db, 'history_records', 'lifeb'), context: await count(db, 'context_records', 'lifeb') }, before);
    assert.equal((await db.admin.query(`SELECT status FROM scheduled_deliveries WHERE mira_id = 'lifeb'`)).rows[0].status, 'cancelled');
    assert.equal(await readFile(path.join(fresh.archivePath!, 'memory', 'notes.md'), 'utf8'), 'old notes\n');
    assert.equal(JSON.parse(await readFile(path.join(fresh.archivePath!, 'life.json'), 'utf8')).nextLifeId, 'lifeb~g1');
    assert.equal(await readFile(path.join(options.service.memoryRoot, 'MEMORY.md'), 'utf8'), '');
    assert.notEqual(JSON.parse(await readFile(path.join(options.service.memoryRoot, '.git', 'mira-memory-workspace.json'), 'utf8')).repositoryId, repository);
    const lives = await host.lives.list('lifeb');
    assert.deepEqual(lives.map(life => [life.miraId, life.generation, life.active, life.archivePath]), [['lifeb', 0, false, fresh.archivePath], ['lifeb~g1', 1, true, null]]);

    await host.backend.submit({ id: 'b-2', text: 'hello again', occurredAt: '2026-10-30T02:00:00.000Z' }); await settled(host);
    const latest = getCurrentSystemPrompt(seen.at(-1)!.messages);
    assert.doesNotMatch(JSON.stringify(seen.at(-1)!.messages), /remember that I like oolong/, 'no old conversation reaches the new life');
    assert.doesNotMatch(latest, /likes oolong/);

    // A second reset can also restore the default persona.
    const again = await host.backend.previewReset('life');
    const second = await finished(host, (await host.backend.reset({ scope: 'life', token: again.token, stopRunning: false, resetPersona: true })).resetId);
    assert.equal(second.lifeId, 'lifeb~g2');
    assert.deepEqual((await host.status()).identity, { name: 'Mira', ring: 'lavender', avatar: null });

    // Rolling the schema down is refused once later generations exist.
    await host.close(); host = undefined;
    // The later background-job (ADR 0049) and usage-index (ADR 0048) slices roll back first; the lives slice then refuses.
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' });
    await assert.rejects(migrate({ connectionString: db.connectionString, schema: db.schema, direction: 'down' }), /Refusing to drop Mira lives/);
    // CLI restore of the original life brings its files and Timeline back.
    const restored = await restoreArchivedLife({ connectionString: db.connectionString, schema: db.schema, slot: 'lifeb', miraHome: root, memoryRoot: options.service.memoryRoot, spoolDirectory: options.service.spoolDirectory, target: 'lifeb' });
    assert.deepEqual([restored.from, restored.to], ['lifeb~g2', 'lifeb']);
    assert.equal(await readFile(path.join(options.service.memoryRoot, 'notes.md'), 'utf8'), 'old notes\n');
    host = await MiraLifeHost.open(options); await settled(host);
    assert.equal(host.lifeId, 'lifeb');
    assert.ok((await host.backend.timeline()).items.some(item => item.text === 'remember that I like oolong'));
    assert.equal(JSON.parse(await readFile(path.join(options.service.memoryRoot, '.git', 'mira-memory-workspace.json'), 'utf8')).repositoryId, repository);
  } finally { await host?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('a busy reset needs 停止工作并重置; stopping interrupts the Wake and expired tokens are refused', { timeout: 60_000 }, async () => {
  const db = await createTestDatabase(); let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const { root, options } = await setup('busy', db, { tokenTtlMs: 200 });
  options.service.syntheticStream = (_model, _context, streamOptions) => {
    entered();
    return new Promise((_resolve, reject) => { streamOptions?.signal?.addEventListener('abort', () => reject(streamOptions.signal!.reason), { once: true }); });
  };
  let host: MiraLifeHost | undefined;
  try {
    host = await MiraLifeHost.open(options);
    const expired = await host.backend.previewReset('life');
    await new Promise(resolve => setTimeout(resolve, 250));
    await assert.rejects(host.backend.reset({ scope: 'life', token: expired.token, stopRunning: true, resetPersona: false }), { code: 'conflict' });
    await host.backend.submit({ id: 'busy-1', text: 'a long task', occurredAt: '2026-10-30T01:00:00.000Z' });
    await started;
    const preview = await host.backend.previewReset('life');
    assert.deepEqual(preview.busy, { running: true, subagents: 0 });
    await assert.rejects(host.backend.reset({ scope: 'life', token: preview.token, stopRunning: false, resetPersona: false }), { code: 'busy' });
    const view = await finished(host, (await host.backend.reset({ scope: 'life', token: preview.token, stopRunning: true, resetPersona: false })).resetId);
    assert.equal(view.state, 'completed', view.error ?? '');
    assert.equal((await db.admin.query(`SELECT completed FROM wake_runs WHERE mira_id = 'busy'`)).rows[0].completed, false, 'the stopped Wake stays interrupted in the archived life');
    assert.equal((await host.status()).state, 'idle');
  } finally { await host?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

test('只清空长期记忆 commits a revertible clear, keeps the conversation and refreshes the frozen Memory at the next Wake', { timeout: 60_000 }, async () => {
  const db = await createTestDatabase(); const { root, options, seen } = await setup('lifea', db);
  let host: MiraLifeHost | undefined;
  try {
    host = await MiraLifeHost.open(options); await settled(host);
    await writeFile(path.join(options.service.memoryRoot, 'MEMORY.md'), '- OLD_FACT likes oolong\n');
    await writeFile(path.join(options.service.memoryRoot, 'friends.md'), 'friend notes\n');
    await host.backend.submit({ id: 'a-1', text: 'tell me what you remember', occurredAt: '2026-10-30T01:00:00.000Z' }); await settled(host);
    assert.match(memoryText(seen.at(-1)!), /OLD_FACT/);
    const preview = await host.backend.previewReset('memory');
    assert.equal(preview.archivePath, null); assert.equal(preview.impact.memoryFiles, 2);
    const view = await finished(host, (await host.backend.reset({ scope: 'memory', token: preview.token, stopRunning: false, resetPersona: false })).resetId);
    assert.equal(view.state, 'completed', view.error ?? ''); assert.equal(view.lifeId, 'lifea'); assert.match(view.commit!, /^[0-9a-f]{40}$/);
    assert.equal(git(options.service.memoryRoot, 'rev-parse', 'HEAD'), view.commit);
    assert.match(git(options.service.memoryRoot, 'show', '-s', '--format=%B', 'HEAD'), /Mira-Reset-Phase: clear/);
    assert.equal(await readFile(path.join(options.service.memoryRoot, 'MEMORY.md'), 'utf8'), '');
    assert.equal(await exists(path.join(options.service.memoryRoot, 'friends.md')), false);
    const items = (await host.backend.timeline()).items;
    assert.ok(items.some(item => item.text === 'tell me what you remember'), 'the conversation is kept');
    assert.deepEqual(items.filter(item => item.role === 'notice').map(item => item.text), [`长期记忆已清空 · 旧内容保存在 Memory Git 提交 ${view.commit!.slice(0, 7)}，可回退`]);
    assert.ok(await exists(memoryRefreshFile(root)));
    const requests = seen.length;
    await host.backend.submit({ id: 'a-2', text: 'and now?', occurredAt: '2026-10-30T01:05:00.000Z' }); await settled(host);
    assert.equal(seen.length, requests + 2, 'one compaction refresh, then the reply');
    assert.doesNotMatch(memoryText(seen.at(-1)!), /OLD_FACT/);
    assert.equal(await exists(memoryRefreshFile(root)), false, 'the marker is cleared after the refresh commits');
    assert.equal(Number((await db.admin.query(`SELECT count(*) FROM context_records WHERE mira_id = 'lifea' AND envelope->>'kind' = 'checkpoint'`)).rows[0].count), 1);
  } finally { await host?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});

const lifeSteps: ResetStep[] = ['journal-prepared', 'stopped', 'switched', 'archived', 'started', 'finalized'];
const memorySteps: ResetStep[] = ['journal-prepared', 'stopped', 'cleared', 'started', 'finalized'];
for (const [scope, steps] of [['life', lifeSteps], ['memory', memorySteps]] as const) {
  test(`a crash at every ${scope} reset step resumes or rolls back from the journal`, { timeout: 120_000 }, async () => {
    for (const step of steps) {
      const db = await createTestDatabase(); const slot = `crash${scope}${steps.indexOf(step)}`;
      let crash = true;
      const { root, options } = await setup(slot, db, { fault: target => { if (crash && target === step) throw new SimulatedCrash(target); } });
      let host: MiraLifeHost | undefined;
      try {
        host = await MiraLifeHost.open(options); await settled(host);
        await writeFile(path.join(options.service.memoryRoot, 'notes.md'), 'old notes\n');
        await host.backend.submit({ id: `${slot}-1`, text: 'before the crash', occurredAt: '2026-10-30T01:00:00.000Z' }); await settled(host);
        const preview = await host.backend.previewReset(scope);
        const view = await finished(host, (await host.backend.reset({ scope, token: preview.token, stopRunning: false, resetPersona: false })).resetId);
        assert.equal(view.state, 'failed', `${step}: the simulated process died`);
        assert.equal(host.crashed, true);
        await host.close(); host = undefined; crash = false;
        host = await MiraLifeHost.open(options); await settled(host);
        assert.equal(await exists(resetJournalFile(root)), false, `${step}: the journal is resolved at startup`);
        const items = (await host.backend.timeline()).items;
        const rolledBack = scope === 'life' && (step === 'journal-prepared' || step === 'stopped');
        if (scope === 'life') {
          assert.equal(host.lifeId, rolledBack ? slot : `${slot}~g1`, step);
          assert.equal(await exists(path.join(options.service.memoryRoot, 'notes.md')), rolledBack, step);
          assert.equal(items.some(item => item.text === 'before the crash'), rolledBack, step);
          if (!rolledBack) assert.equal(await readFile(path.join(preview.archivePath!, 'memory', 'notes.md'), 'utf8'), 'old notes\n', step);
          assert.deepEqual((await host.lives.list(slot)).filter(life => life.active).length, rolledBack ? 0 : 1, step);
        } else {
          assert.equal(host.lifeId, slot);
          assert.equal(await exists(path.join(options.service.memoryRoot, 'notes.md')), false, step);
          assert.equal(items.filter(item => item.role === 'notice').length, 1, `${step}: exactly one reset notice`);
          assert.ok(items.some(item => item.text === 'before the crash'), step);
          assert.equal(git(options.service.memoryRoot, 'log', '--format=%s', '--grep=Mira-Reset-Phase: clear').split('\n').length, 1, `${step}: one clear commit`);
        }
        await host.backend.submit({ id: `${slot}-2`, text: 'after recovery', occurredAt: '2026-10-30T02:00:00.000Z' }); await settled(host);
        assert.equal((await host.status()).state, 'idle', step);
      } finally { await host?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
    }
  });
}
