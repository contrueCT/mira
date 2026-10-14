import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { formatSkillsForPrompt, type LoadSkillsResult } from '@earendil-works/pi-coding-agent';
import { getCurrentSystemMessage, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { createSkillLoader, createWorkspaceTools } from '@mira/server';
import { MIRA_PROMPT_SECTION, PiDurableRuntime } from '@mira/runtime-pi';
import { assistant, effectTool, input, MemoryWriter, model, overrideWriter, result, streamOf, toolCalls } from '../recovery/fixtures.mts';

const signal = () => new AbortController().signal;
const prompt = { environmentContext: 'Offline skills fixture', authorizationContext: 'Synthetic user request', now: () => new Date('2026-10-06T12:00:00.000Z') };
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceDirectory = path.join(root, 'checkout'); const miraHome = path.join(root, 'mira home & <fixture>');
  await mkdir(sourceDirectory);
  return { root, sourceDirectory, miraHome };
}
async function skill(root: string, name: string, description: string, body = 'BODY_ONLY_SENTINEL', extra = ''): Promise<string> {
  const directory = path.join(root, 'skills', name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'SKILL.md');
  await writeFile(file, `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n${extra}---\n${body}\n`);
  return file;
}

test('only explicit repository/Mira-home roots load; absent user skills stay silent and may appear later', async t => {
  const { root, sourceDirectory, miraHome } = await fixture(t);
  const diagnostics: LoadSkillsResult['diagnostics'][] = [];
  await skill(sourceDirectory, 'builtin', 'Repository skill');
  await skill(path.join(sourceDirectory, '.pi'), 'pi-project', 'Must not discover');
  await skill(path.join(sourceDirectory, '.agents'), 'agents-project', 'Must not discover');
  await skill(path.join(root, '.agents'), 'agents-ancestor', 'Must not discover');
  await skill(path.join(miraHome, '.pi'), 'pi-home', 'Must not discover');
  const load = createSkillLoader({ sourceDirectory, miraHome, onDiagnostics: value => diagnostics.push(value) });
  assert.deepEqual((await load(signal())).map(item => item.name), ['builtin']);
  assert.deepEqual((await load(signal())).map(item => item.name), ['builtin']);
  assert.deepEqual(diagnostics, [], 'never-created optional user root is not a warning');
  await skill(miraHome, 'personal', 'Appeared before next request');
  assert.deepEqual((await load(signal())).map(item => item.name), ['builtin', 'personal']);
  await rm(path.join(miraHome, 'skills'), { recursive: true });
  assert.deepEqual((await load(signal())).map(item => item.name), ['builtin']);
  assert.deepEqual(diagnostics, []);
});

test('MIRA_HOME and ~/.mira default roots are resolved explicitly', async t => {
  const { sourceDirectory, miraHome } = await fixture(t);
  await skill(miraHome, 'home-env', 'Configured home');
  const oldHome = process.env['HOME']; const oldMiraHome = process.env['MIRA_HOME'];
  try {
    process.env['MIRA_HOME'] = miraHome;
    assert.deepEqual((await createSkillLoader({ sourceDirectory })(signal())).map(item => item.name), ['home-env']);
    delete process.env['MIRA_HOME']; process.env['HOME'] = miraHome;
    await skill(path.join(miraHome, '.mira'), 'home-default', 'Default home');
    assert.deepEqual((await createSkillLoader({ sourceDirectory })(signal())).map(item => item.name), ['home-default']);
  } finally {
    if (oldHome === undefined) delete process.env['HOME']; else process.env['HOME'] = oldHome;
    if (oldMiraHome === undefined) delete process.env['MIRA_HOME']; else process.env['MIRA_HOME'] = oldMiraHome;
  }
});

test('Pi parsing, first-name-wins collision diagnostics, hidden skills and canonical path deduplication are retained', async t => {
  const { sourceDirectory, miraHome } = await fixture(t);
  const winner = await skill(sourceDirectory, 'shared', 'Current repository SDK');
  const loser = await skill(miraHome, 'shared', 'Stale user copy');
  await skill(miraHome, 'hidden', 'Hidden metadata', 'HIDDEN_BODY', 'disable-model-invocation: true\n');
  await mkdir(path.join(sourceDirectory, 'skills', 'bad-yaml'));
  await writeFile(path.join(sourceDirectory, 'skills', 'bad-yaml', 'SKILL.md'), '---\ndescription: [broken\n---\nbody');
  await mkdir(path.join(sourceDirectory, 'skills', 'missing-description'));
  await writeFile(path.join(sourceDirectory, 'skills', 'missing-description', 'SKILL.md'), '---\nname: missing-description\n---\nbody');
  await writeFile(path.join(sourceDirectory, 'skills', 'ordinary.md'), 'An ordinary document without frontmatter');
  await writeFile(path.join(sourceDirectory, 'skills', 'direct.md'), '---\nname: direct\ndescription: Direct markdown skill\n---\nDIRECT_BODY');
  await symlink(path.dirname(winner), path.join(miraHome, 'skills', 'alias'));
  const diagnostics: LoadSkillsResult['diagnostics'][] = [];
  const load = createSkillLoader({ sourceDirectory, miraHome, onDiagnostics: value => diagnostics.push(structuredClone(value)) });
  const skills = await load(signal());
  assert.deepEqual(skills.map(item => item.name).sort(), ['direct', 'hidden', 'shared']);
  assert.equal(skills.find(item => item.name === 'shared')?.filePath, winner);
  assert.equal(skills.find(item => item.name === 'shared')?.description, 'Current repository SDK');
  assert.ok(skills.every(item => !Object.hasOwn(item, 'body') && !Object.hasOwn(item, 'content')));
  const collisions = diagnostics[0]!.filter(item => item.type === 'collision');
  assert.equal(collisions.length, 1, 'same real file is deduplicated before name collision detection');
  assert.equal(collisions[0]!.collision?.winnerPath, winner); assert.equal(collisions[0]!.collision?.loserPath, loser);
  assert.ok(diagnostics[0]!.some(item => item.path?.includes('bad-yaml')));
  assert.ok(diagnostics[0]!.some(item => item.path?.includes('missing-description')));
  assert.doesNotMatch(formatSkillsForPrompt(skills), /Hidden metadata|HIDDEN_BODY|BODY_ONLY_SENTINEL|DIRECT_BODY|Stale user copy/);
  await load(signal()); assert.equal(diagnostics.length, 1, 'unchanged warnings do not flood each request');
  await rm(path.join(sourceDirectory, 'skills', 'bad-yaml'), { recursive: true });
  await rm(path.join(sourceDirectory, 'skills', 'missing-description'), { recursive: true });
  await rm(path.dirname(loser), { recursive: true });
  await load(signal()); assert.deepEqual(diagnostics[1], [], 'resolved diagnostics clear the caller snapshot');
});

test('skill add/change/remove refresh at each natural tool continuation with one request snapshot and no extra calls', async t => {
  const { sourceDirectory, miraHome } = await fixture(t);
  await skill(sourceDirectory, 'initial', 'METADATA_FIRST');
  const loader = createSkillLoader({ sourceDirectory, miraHome });
  const writer = new MemoryWriter(); let calls = 0; let loads = 0; let memoryLoads = 0; let generation = 0;
  const tool = effectTool(async () => {
    if (generation++ === 0) {
      await skill(sourceDirectory, 'initial', 'METADATA_CHANGED');
      await skill(miraHome, 'added', 'METADATA_ADDED');
    } else {
      await rm(path.join(sourceDirectory, 'skills'), { recursive: true });
      await rm(path.join(miraHome, 'skills'), { recursive: true });
    }
    return result;
  });
  const runtime = new PiDurableRuntime({ writer, model, tools: [tool], miraPrompt: { ...prompt, loadMemory: async () => { memoryLoads++; return 'FROZEN_MEMORY'; } },
    loadSkills: async abort => { loads++; return loader(abort); }, streamFn: (_model, context) => {
      calls++; const text = getCurrentSystemPrompt(context.messages);
      assert.equal((JSON.stringify(context).match(/# Mira System Prompt v0.2/g) ?? []).length, 1);
      assert.equal(getCurrentTools(context.messages).length, 1); assert.match(text, /FROZEN_MEMORY/);
      assert.doesNotMatch(text, /BODY_ONLY_SENTINEL/);
      if (calls === 1) { assert.match(text, /METADATA_FIRST/); assert.doesNotMatch(text, /METADATA_CHANGED|METADATA_ADDED/); return streamOf(toolCalls('add-change')); }
      if (calls === 2) { assert.match(text, /METADATA_CHANGED/); assert.match(text, /METADATA_ADDED/); assert.doesNotMatch(text, /METADATA_FIRST/); return streamOf(toolCalls('remove')); }
      assert.doesNotMatch(text, /available_skills|METADATA_FIRST|METADATA_CHANGED|METADATA_ADDED/);
      return streamOf(assistant());
    } });
  await runtime.run(input()); assert.equal(calls, 3); assert.equal(loads, 3); assert.equal(memoryLoads, 1);
  const before = structuredClone(writer.state);
  await skill(miraHome, 'later', 'Created while idle');
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(calls, 3); assert.equal(loads, 3); assert.deepEqual(writer.state, before, 'file changes create no runtime work');
});

test('terminal diagnostics report paths and collisions without copying malformed file excerpts', async t => {
  const { sourceDirectory, miraHome } = await fixture(t);
  await skill(sourceDirectory, 'shared', 'Built-in'); await skill(miraHome, 'shared', 'User copy');
  await mkdir(path.join(sourceDirectory, 'skills', 'broken'));
  await writeFile(path.join(sourceDirectory, 'skills', 'broken', 'SKILL.md'), '---\ndescription: [SYNTHETIC_PRIVATE_VALUE\n---\n');
  const warn = console.warn; const warnings: unknown[][] = [];
  try {
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    await createSkillLoader({ sourceDirectory, miraHome })(signal());
  } finally { console.warn = warn; }
  assert.match(JSON.stringify(warnings), /broken|collision|winnerPath|loserPath/);
  assert.doesNotMatch(JSON.stringify(warnings), /SYNTHETIC_PRIVATE_VALUE/);
});

test('skill metadata is pinned before prompt append and body-only edits do not create system revisions', async t => {
  const { sourceDirectory, miraHome } = await fixture(t); await skill(miraHome, 'pinned', 'REQUEST_SNAPSHOT');
  const writer = new MemoryWriter(); let calls = 0;
  writer.beforeAppend = async record => {
    if (JSON.stringify(record.payload).includes(MIRA_PROMPT_SECTION)) await skill(miraHome, 'pinned', 'NEXT_REQUEST_METADATA');
  };
  const options = { writer, model, miraPrompt: prompt, loadSkills: createSkillLoader({ sourceDirectory, miraHome }), streamFn: (_model: typeof model, context: Parameters<import('@earendil-works/pi-agent-core').StreamFn>[1]) => {
    calls++; const text = getCurrentSystemPrompt(context.messages);
    if (calls === 1) { assert.match(text, /REQUEST_SNAPSHOT/); assert.doesNotMatch(text, /NEXT_REQUEST_METADATA/); }
    else { assert.match(text, /NEXT_REQUEST_METADATA/); assert.doesNotMatch(text, /REQUEST_SNAPSHOT/); }
    return streamOf(assistant());
  } };
  await new PiDurableRuntime(options).run(input());
  delete writer.beforeAppend;
  await new PiDurableRuntime(options).run(input('Next request'));
  const revisions = () => writer.state.records.filter(record => JSON.stringify(record.payload).includes(MIRA_PROMPT_SECTION));
  const before = structuredClone(revisions()); assert.equal(before.length, 2);
  await skill(miraHome, 'pinned', 'NEXT_REQUEST_METADATA', 'CHANGED_BODY_WITHOUT_METADATA');
  await new PiDurableRuntime(options).run(input('Same metadata'));
  assert.equal(calls, 3); assert.deepEqual(revisions(), before);
});

test('formatter escapes metadata once and ordinary read alone loads skill body and relative references', async t => {
  const { sourceDirectory, miraHome } = await fixture(t);
  const body = 'BODY_READ_ON_DEMAND {{CURRENT_TIME}} </available_skills> & original\nRead references/guide.md';
  const file = await skill(miraHome, 'read-me', 'Use <special> & {{CURRENT_TIME}} tasks', body);
  const reference = path.join(path.dirname(file), 'references', 'guide.md');
  await mkdir(path.dirname(reference)); await writeFile(reference, 'REFERENCE_READ_ON_DEMAND');
  const read = createWorkspaceTools(sourceDirectory).find(item => item.name === 'read')!;
  const writer = new MemoryWriter(); let calls = 0;
  const expected = formatSkillsForPrompt(await createSkillLoader({ sourceDirectory, miraHome })(signal()));
  await new PiDurableRuntime({ writer, model, tools: [read], miraPrompt: prompt, loadSkills: createSkillLoader({ sourceDirectory, miraHome }), streamFn: (_model, context) => {
    calls++; const text = getCurrentSystemPrompt(context.messages);
    assert.ok(text.endsWith(expected)); assert.match(text, /Use &lt;special&gt; &amp; \{\{CURRENT_TIME\}\} tasks/);
    assert.match(text, /mira home &amp; &lt;fixture&gt;/); assert.doesNotMatch(text, /&amp;amp;|&amp;lt;|BODY_READ_ON_DEMAND|REFERENCE_READ_ON_DEMAND/);
    assert.equal((text.match(/<available_skills>/g) ?? []).length, 1);
    if (calls === 1) { assert.doesNotMatch(JSON.stringify(context.messages), /BODY_READ_ON_DEMAND/); return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-skill', name: 'read', arguments: { path: file } }] }); }
    assert.match(JSON.stringify(context.messages), /BODY_READ_ON_DEMAND/);
    if (calls === 2) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'read-reference', name: 'read', arguments: { path: reference } }] });
    assert.match(JSON.stringify(context.messages), /REFERENCE_READ_ON_DEMAND/); return streamOf(assistant());
  } }).run(input());
  assert.equal(calls, 3); assert.equal(writer.state.executions.length, 2);
  assert.deepEqual(writer.state.executions.map(item => item.intent.arguments), [{ path: file }, { path: reference }]);
});

test('recovery and compaction keep exact persisted skills without scanning; next natural request refreshes', async t => {
  const { sourceDirectory, miraHome } = await fixture(t); await skill(miraHome, 'continuity', 'SAVED_SKILLS');
  const writer = new MemoryWriter(); const loader = createSkillLoader({ sourceDirectory, miraHome }); let loads = 0; let memoryLoads = 0;
  // Leave room for the full frozen persona/skills references and Mira summary instructions.
  const options = { writer, model: { ...model, contextWindow: 32_768 }, autoCompaction: { enabled: false }, loadSkills: async (abort: AbortSignal) => { loads++; return loader(abort); }, miraPrompt: { ...prompt, loadMemory: async () => { memoryLoads++; return 'FROZEN_MEMORY'; } }, streamFn: () => streamOf(assistant('Synthetic long response '.repeat(100))) };
  await new PiDurableRuntime(options).run(input('Earlier discussion '.repeat(300)));
  await new PiDurableRuntime(options).run(input('Latest question'));
  const rawPrefix = structuredClone(writer.state.records); const before = await new PiDurableRuntime(options).recover();
  const system = getCurrentSystemMessage(before.messages);
  await skill(miraHome, 'continuity', 'DISK_CHANGED');
  const compacted = await new PiDurableRuntime(options).compact({ keepRecentTokens: 1 });
  assert.equal(loads, 2); assert.equal(memoryLoads, 2);
  const checkpoint = compacted.entries.findLast(item => item.type === 'compaction');
  assert.ok(checkpoint?.type === 'compaction');
  assert.deepEqual(checkpoint.systemMessage, { ...system, timestamp: Date.parse(checkpoint.timestamp) });
  assert.match(getCurrentSystemPrompt(compacted.messages), /SAVED_SKILLS/); assert.doesNotMatch(getCurrentSystemPrompt(compacted.messages), /DISK_CHANGED/);
  await new PiDurableRuntime({ ...options, streamFn: (_model, context) => {
    const text = getCurrentSystemPrompt(context.messages); assert.match(text, /DISK_CHANGED/); assert.doesNotMatch(text, /SAVED_SKILLS/);
    assert.equal((text.match(/<available_skills>/g) ?? []).length, 1); assert.match(text, /FROZEN_MEMORY/); return streamOf(assistant());
  } }).run(input('Continue after restart and compaction'));
  assert.equal(loads, 3); assert.equal(memoryLoads, 2); assert.deepEqual(writer.state.records.slice(0, rawPrefix.length), rawPrefix);
});

test('committed skill prompt survives an uncertain append response without duplicate revision or Memory reload', async t => {
  const { sourceDirectory, miraHome } = await fixture(t); await skill(miraHome, 'crash', 'SAVED_SKILL_AFTER_CRASH');
  const writer = new MemoryWriter(); let calls = 0; let memoryLoads = 0;
  const crashed = overrideWriter(writer, { append: async (...args) => {
    const version = await writer.append(...args);
    if (JSON.stringify(args[1].payload).includes(MIRA_PROMPT_SECTION)) throw Error('Lost skill prompt commit response');
    return version;
  } });
  const options = { model, loadSkills: createSkillLoader({ sourceDirectory, miraHome }), miraPrompt: { ...prompt, loadMemory: async () => { memoryLoads++; return 'ONCE'; } }, streamFn: () => { calls++; return streamOf(assistant()); } };
  await assert.rejects(new PiDurableRuntime({ ...options, writer: crashed }).run(input()), /Lost skill prompt commit response/);
  assert.equal(calls, 0);
  const revisions = () => writer.state.records.filter(item => JSON.stringify(item.payload).includes(MIRA_PROMPT_SECTION));
  const committed = structuredClone(revisions()); assert.equal(committed.length, 1);
  await new PiDurableRuntime({ ...options, writer }).run();
  assert.equal(calls, 1); assert.equal(memoryLoads, 1); assert.deepEqual(revisions(), committed);
});

for (const fault of ['cas', 'owner-loss', 'loader'] as const) test(`skill preparation ${fault} failure fences model requests`, async t => {
  const { sourceDirectory, miraHome } = await fixture(t); await skill(miraHome, 'fenced', 'FENCED_METADATA');
  const writer = new MemoryWriter(); const loader = createSkillLoader({ sourceDirectory, miraHome }); let calls = 0;
  if (fault === 'cas') writer.beforeAppend = async record => { if (JSON.stringify(record.payload).includes(MIRA_PROMPT_SECTION)) writer.state.version++; };
  await assert.rejects(new PiDurableRuntime({ writer, model, miraPrompt: prompt, loadSkills: async abort => {
    const skills = await loader(abort);
    if (fault === 'owner-loss') writer.controller.abort(Error('Skill refresh ownership loss'));
    if (fault === 'loader') throw Error('Skill loader failed');
    return skills;
  }, streamFn: () => { calls++; return streamOf(assistant()); } }).run(input()), fault === 'cas' ? /version conflict/ : fault === 'owner-loss' ? /ownership loss/ : /Skill loader failed/);
  assert.equal(calls, 0);
});

test('skill loader cancellation is explicit', async t => {
  const { sourceDirectory, miraHome } = await fixture(t);
  const loader = createSkillLoader({ sourceDirectory, miraHome }); const abort = new AbortController(); abort.abort(Error('Cancelled skill refresh'));
  await assert.rejects(loader(abort.signal), /Cancelled skill refresh/);
});


test('standalone worker skills refresh at natural requests without loading Mira persona or Memory', async t => {
  const { sourceDirectory, miraHome } = await fixture(t);
  await skill(sourceDirectory, 'worker-skill', 'WORKER_METADATA_FIRST');
  const writer = new MemoryWriter(); let calls = 0; let loads = 0;
  const loader = createSkillLoader({ sourceDirectory, miraHome });
  const runtime = new PiDurableRuntime({ writer, model, autoCompaction: { enabled: false },
    loadSkills: async signal => { loads++; return loader(signal); }, tools: [effectTool(async () => {
      await skill(sourceDirectory, 'worker-skill', 'WORKER_METADATA_CHANGED'); return result;
    })], streamFn: (_model, context) => {
      calls++; const system = getCurrentSystemPrompt(context.messages);
      assert.match(system, /TASK_SCOPED_CONTRACT/);
      assert.doesNotMatch(system, /# Mira System Prompt|miraMemory|BODY_ONLY_SENTINEL/);
      if (calls === 1) { assert.match(system, /WORKER_METADATA_FIRST/); return streamOf(toolCalls('worker-change')); }
      assert.match(system, /WORKER_METADATA_CHANGED/); assert.doesNotMatch(system, /WORKER_METADATA_FIRST/);
      return streamOf(assistant('worker done'));
    } });
  await runtime.appendMessage({ role: 'system', content: 'TASK_SCOPED_CONTRACT', timestamp: Date.now() });
  await runtime.run(input('Only inspect assigned files'));
  assert.equal(calls, 2); assert.equal(loads, 2);
  assert.ok(!JSON.stringify(writer.state.records).includes('miraMemory'));
  const restored = new PiDurableRuntime({ writer, model, loadSkills: async () => { throw Error('must not load during recovery'); }, streamFn: () => { throw Error('must not call during recovery'); } });
  assert.match(getCurrentSystemPrompt((await restored.recover()).messages), /TASK_SCOPED_CONTRACT/);
});
