import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { getCurrentSystemMessage, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { createSkillLoader, LocalWebService, runDemo } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, input, runtime, streamOf } from './fixtures.mts';

async function files(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-skills-pg-'));
  const sourceDirectory = path.join(root, 'checkout'); const miraHome = path.join(root, 'mira-home');
  const userHome = path.join(root, 'user-home'); const globalRoot = path.join(userHome, '.agents');
  await mkdir(sourceDirectory);
  t.mock.method(os, 'homedir', () => userHome);
  const skill = async (home: string, name: string, description: string) => {
    const directory = path.join(home, 'skills', name); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nBODY_NOT_IN_PROMPT\n`);
  };
  return { root, sourceDirectory, miraHome, globalRoot, skill };
}
const prompt = { environmentContext: 'Isolated synthetic skills recovery test', authorizationContext: 'Synthetic user', now: () => new Date('2026-10-06T12:00:00Z') };

test('real PostgreSQL skill revisions preserve raw history and exact compaction system across restart', { timeout: 30_000 }, async t => {
  const db = await createTestDatabase(); const fileset = await files(t);
  try {
    const { sourceDirectory, miraHome, globalRoot, skill } = fileset;
    await skill(sourceDirectory, 'builtin', 'BUILTIN_METADATA'); await skill(miraHome, 'user-skill', 'FIRST_USER_METADATA');
    await skill(globalRoot, 'global-skill', 'FIRST_GLOBAL_METADATA');
    const loader = createSkillLoader({ sourceDirectory, miraHome }); let loads = 0; let memoryLoads = 0;
    const configured = { autoCompaction: { enabled: false }, loadSkills: async (signal: AbortSignal) => { loads++; return loader(signal); }, miraPrompt: { ...prompt, loadMemory: async () => { memoryLoads++; return 'FROZEN_MEMORY'; } } };
    const first = await db.acquire('skill-continuity');
    await runtime(first, (_model, context) => {
      assert.match(getCurrentSystemPrompt(context.messages), /BUILTIN_METADATA/); assert.match(getCurrentSystemPrompt(context.messages), /FIRST_USER_METADATA/);
      assert.match(getCurrentSystemPrompt(context.messages), /FIRST_GLOBAL_METADATA/);
      assert.doesNotMatch(JSON.stringify(context.messages), /BODY_NOT_IN_PROMPT/); return streamOf(assistant('Earlier answer '.repeat(100)));
    }, configured).run(input('Earlier discussion '.repeat(200)));
    const prefix = (await db.admin.query('SELECT version, record_id, envelope::text AS raw FROM context_records ORDER BY version')).rows;
    await first.close();
    await skill(miraHome, 'user-skill', 'SECOND_USER_METADATA');
    await skill(globalRoot, 'global-skill', 'SECOND_GLOBAL_METADATA');
    const restarted = await db.acquire('skill-continuity');
    const saved = await runtime(restarted, () => streamOf(assistant()), configured).recover();
    assert.match(getCurrentSystemPrompt(saved.messages), /FIRST_USER_METADATA/);
    assert.match(getCurrentSystemPrompt(saved.messages), /FIRST_GLOBAL_METADATA/); assert.equal(loads, 1);
    const system = getCurrentSystemMessage(saved.messages);
    const compacted = await runtime(restarted, () => streamOf(assistant('Synthetic durable skill summary')), configured).compact({ keepRecentTokens: 1 });
    const checkpoint = compacted.entries.findLast(entry => entry.type === 'compaction'); assert.ok(checkpoint?.type === 'compaction');
    assert.deepEqual(checkpoint.systemMessage, { ...system, timestamp: Date.parse(checkpoint.timestamp) }); assert.equal(loads, 1);
    await runtime(restarted, (_model, context) => {
      const text = getCurrentSystemPrompt(context.messages); assert.match(text, /SECOND_USER_METADATA/); assert.match(text, /SECOND_GLOBAL_METADATA/); assert.doesNotMatch(text, /FIRST_USER_METADATA|FIRST_GLOBAL_METADATA|BODY_NOT_IN_PROMPT/);
      assert.match(text, /FROZEN_MEMORY/); assert.equal((text.match(/<available_skills>/g) ?? []).length, 1); return streamOf(assistant());
    }, configured).run(input('Continue naturally'));
    assert.equal(loads, 2); assert.equal(memoryLoads, 2);
    assert.deepEqual((await db.admin.query('SELECT version, record_id, envelope::text AS raw FROM context_records ORDER BY version')).rows.slice(0, prefix.length), prefix);
  } finally { await db.close(); await rm(fileset.root, { recursive: true, force: true }); }
});

test('real PostgreSQL demo assembly discovers all three roots and refreshes user removal on the next wake', { timeout: 30_000 }, async t => {
  const db = await createTestDatabase(); const fileset = await files(t); let calls = 0;
  try {
    const { root, sourceDirectory, miraHome, globalRoot, skill } = fileset;
    await skill(sourceDirectory, 'builtin', 'DEMO_BUILTIN'); await skill(miraHome, 'personal', 'DEMO_PERSONAL');
    await skill(globalRoot, 'global', 'DEMO_GLOBAL');
    const run = (id: string) => runDemo({ connectionString: db.connectionString, schema: db.schema, miraId: 'skills-demo', sourceDirectory, miraHome, spoolDirectory: path.join(root, 'spool'),
      events: [{ event: { id, type: 'demo.message', source: 'user', occurredAt: '2026-10-06T12:00:00Z', payload: { text: 'Synthetic skills request' } }, wake: { id: `wake:${id}`, reason: 'Synthetic skills request' } }],
      streamFn: (_model, context) => {
        calls++; const text = getCurrentSystemPrompt(context.messages); assert.match(text, /DEMO_BUILTIN/); assert.doesNotMatch(text, /BODY_NOT_IN_PROMPT/);
        if (calls === 1) { assert.match(text, /DEMO_PERSONAL/); assert.match(text, /DEMO_GLOBAL/); }
        else assert.doesNotMatch(text, /DEMO_PERSONAL|DEMO_GLOBAL/);
        return streamOf(assistant());
      } });
    assert.equal((await run('first')).modelCalls, 1);
    await rm(path.join(miraHome, 'skills'), { recursive: true });
    await rm(path.join(globalRoot, 'skills'), { recursive: true });
    assert.equal((await run('second')).modelCalls, 1); assert.equal(calls, 2);
  } finally { await db.close(); await rm(fileset.root, { recursive: true, force: true }); }
});

test('real PostgreSQL Web assembly leaves skill edits idle until a user message and reloads metadata after restart', { timeout: 30_000 }, async t => {
  const db = await createTestDatabase(); const fileset = await files(t); let service: LocalWebService | undefined; let calls = 0;
  const settled = async () => { const deadline = Date.now() + 10_000; while ((await service!.status()).state === 'working') { if (Date.now() > deadline) throw Error('Web skills fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); } assert.equal((await service!.status()).state, 'idle'); };
  try {
    const { root, sourceDirectory, miraHome, globalRoot, skill } = fileset;
    await skill(sourceDirectory, 'builtin', 'WEB_BUILTIN');
    const options = { connectionString: db.connectionString, schema: db.schema, miraId: 'skills-web', sourceDirectory, miraHome, spoolDirectory: path.join(root, 'spool'), settingsFile: path.join(root, 'models.json'), synthetic: true,
      syntheticStream: (_model: Parameters<import('@earendil-works/pi-agent-core').StreamFn>[0], context: Parameters<import('@earendil-works/pi-agent-core').StreamFn>[1]) => {
        calls++; const text = getCurrentSystemPrompt(context.messages); assert.match(text, /WEB_BUILTIN/); assert.doesNotMatch(text, /BODY_NOT_IN_PROMPT/);
        if (calls === 1) assert.doesNotMatch(text, /WEB_PERSONAL|WEB_GLOBAL/);
        else { assert.match(text, /WEB_PERSONAL/); assert.match(text, /WEB_GLOBAL/); }
        return streamOf(assistant());
      } };
    service = await LocalWebService.open(options); await settled(); assert.equal(calls, 0);
    await service.submit({ id: 'web-first', text: 'First skills request', occurredAt: '2026-10-06T12:00:00Z' }); await settled(); assert.equal(calls, 1);
    await skill(miraHome, 'personal', 'WEB_PERSONAL'); await skill(globalRoot, 'global', 'WEB_GLOBAL'); await new Promise(resolve => setTimeout(resolve, 25)); await settled(); assert.equal(calls, 1);
    await service.submit({ id: 'web-second', text: 'Next skills request', occurredAt: '2026-10-06T12:01:00Z' }); await settled(); assert.equal(calls, 2);
    await service.close(); service = undefined;
    service = await LocalWebService.open(options); await settled(); assert.equal(calls, 2);
    await service.submit({ id: 'web-third', text: 'Continue after restart', occurredAt: '2026-10-06T12:02:00Z' }); await settled(); assert.equal(calls, 3);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM wake_runs')).rows[0].n, 3);
    assert.doesNotMatch(JSON.stringify(await service.timeline()), /WEB_BUILTIN|WEB_PERSONAL|WEB_GLOBAL|BODY_NOT_IN_PROMPT/);
  } finally { await service?.close(); await db.close(); await rm(fileset.root, { recursive: true, force: true }); }
});
