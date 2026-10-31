import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { getCurrentSystemPrompt, type TranscriptContext } from '@earendil-works/pi-ai';
import { LocalWebService, personaPresets, type Persona } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, deferred, streamOf } from './fixtures.mts';

async function settled(service: LocalWebService): Promise<void> {
  const deadline = Date.now() + 10_000;
  while ((await service.status()).state === 'working') {
    if (Date.now() > deadline) throw Error('Service did not settle');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
const preset = (id: string): Persona => structuredClone(personaPresets.find(item => item.id === id)!.persona!);
const profileName = (context: TranscriptContext) => /<persona_profile>\nName: ([^\n]+)/.exec(getCurrentSystemPrompt(context.messages))?.[1]
  ?? (getCurrentSystemPrompt(context.messages).includes('No custom profile is configured') ? 'default' : 'missing');

test('persona saves do not wake, add one Timeline notice, freeze per Wake and survive restart', { timeout: 60_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-persona-service-'));
  let service: LocalWebService | undefined; const seen: string[] = []; const gate = deferred(); const entered = deferred(); let block = false;
  try {
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'persona',
      sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      memoryRoot: path.join(root, 'memory'), miraHome: root, synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: async (_model: unknown, context: TranscriptContext) => {
        seen.push(profileName(context));
        if (block && seen.length === 2) {
          entered.resolve(); await gate.promise;
          return streamOf({ ...assistant(), stopReason: 'toolUse' as const, content: [{ type: 'toolCall' as const, id: 'persona-ls', name: 'ls', arguments: { path: root } }] });
        }
        return streamOf(assistant(`Reply ${seen.length}`));
      } };
    service = await LocalWebService.open(options); await settled(service);
    assert.deepEqual((await service.status()).identity, { name: 'Mira', ring: 'lavender', avatar: null });
    await service.submit({ id: 'p-1', text: 'hello', occurredAt: '2026-10-30T01:00:00.000Z' }); await settled(service);
    assert.deepEqual(seen, ['default']);

    const initial = await service.persona();
    assert.equal(initial.persona, null); assert.ok(initial.applied, 'the first Wake recorded what it used');
    const saved = await service.savePersona(initial.revision, preset('partner'));
    assert.equal(saved.changed, true); assert.equal(saved.version, 1);
    assert.equal((await stat(path.join(root, 'persona.json'))).mode & 0o777, 0o600);
    await settled(service);
    assert.deepEqual(seen, ['default'], 'saving never wakes Mira');
    assert.deepEqual((await service.status()).identity, { name: '小满', ring: 'sky', avatar: null });
    const same = await service.savePersona(saved.revision, preset('partner'));
    assert.equal(same.changed, false);
    let notices = (await service.timeline()).items.filter(item => item.role === 'notice' && item.text.startsWith('人设已更新'));
    assert.deepEqual(notices.map(item => item.text), ['人设已更新为「小满」（第 1 版）· 从下一次唤醒开始生效'], 'one notice per real change');

    // A Wake that started under 小满 keeps it for its later tool-loop requests even after a save.
    block = true;
    await service.submit({ id: 'p-2', text: 'list files', occurredAt: '2026-10-30T01:01:00.000Z' });
    await entered.promise;
    const during = await service.savePersona(saved.revision, preset('tsundere'));
    assert.equal(during.applied!.revision, saved.revision, 'the running Wake still applies the previous revision');
    gate.resolve(); await settled(service);
    assert.deepEqual(seen.slice(1), ['小满', '小满']);
    block = false;
    await service.submit({ id: 'p-3', text: 'next', occurredAt: '2026-10-30T01:02:00.000Z' }); await settled(service);
    assert.equal(seen.at(-1), '小凛');
    assert.equal((await service.persona()).applied!.revision, during.revision);

    // Restoring the default persona is a real change and is shown as such.
    const reset = await service.savePersona(during.revision, null);
    notices = (await service.timeline()).items.filter(item => item.role === 'notice' && item.text.startsWith('人设已更新'));
    assert.deepEqual(notices.map(item => item.text).slice(-2), ['人设已更新为「小凛」（第 2 版）· 从下一次唤醒开始生效', '人设已更新为默认 Mira（第 3 版）· 从下一次唤醒开始生效']);
    const restored = await service.restorePersona((await service.personaHistory()).find(item => item.version === 1)!.revision, reset.revision);
    assert.equal(restored.persona!.name, '小满'); assert.equal(restored.version, 4);

    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(service);
    assert.deepEqual((await service.status()).identity, { name: '小满', ring: 'sky', avatar: null });
    assert.equal((await service.persona()).applied, null, 'applied state is per process; nothing has woken yet');
    await service.submit({ id: 'p-4', text: 'after restart', occurredAt: '2026-10-30T01:03:00.000Z' }); await settled(service);
    assert.equal(seen.at(-1), '小满');
  } finally {
    gate.resolve();
    await service?.close(); await db.close(); await rm(root, { recursive: true, force: true });
  }
});

test('a damaged persona file keeps chat available as the default Mira and reports the persona as unavailable', { timeout: 30_000 }, async () => {
  const db = await createTestDatabase(); const root = await realpath(await mkdtemp('/tmp/mira-persona-damaged-'));
  let service: LocalWebService | undefined; const seen: string[] = [];
  try {
    await writeFile(path.join(root, 'persona.json'), '{damaged', { mode: 0o600 });
    service = await LocalWebService.open({ connectionString: db.connectionString, schema: db.schema, miraId: 'persona-damaged',
      sourceDirectory: process.cwd(), spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'),
      memoryRoot: path.join(root, 'memory'), miraHome: root, synthetic: true, dreaming: { enabled: false }, autoCompaction: { enabled: false },
      syntheticStream: async (_model: unknown, context: TranscriptContext) => { seen.push(profileName(context)); return streamOf(assistant('ok')); } });
    assert.deepEqual((await service.status()).identity, { name: 'Mira', ring: 'lavender', avatar: null });
    await assert.rejects(service.persona(), /unavailable/);
    await service.submit({ id: 'd-1', text: 'hello', occurredAt: '2026-10-30T02:00:00.000Z' }); await settled(service);
    assert.deepEqual(seen, ['default']);
    assert.equal(await readFile(path.join(root, 'persona.json'), 'utf8'), '{damaged', 'never silently reset');
  } finally { await service?.close(); await db.close(); await rm(root, { recursive: true, force: true }); }
});
