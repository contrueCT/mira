import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createSkillLoader, createWorkspaceTools } from '@mira/server';
import { getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { assistant, input, MemoryWriter, model, streamOf } from '../recovery/fixtures.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const run = promisify(execFile);
const names = ['pdf', 'doc', 'transcribe', 'agent-browser', 'mira-web-search'];
const bodyHeadings = ['# PDF Skill', '# DOCX Skill', '# Audio Transcribe', '## Mira runtime setup', '# Public web search and extraction'];

test('bundled public skills are discovered by the real loader and read only through ordinary runtime tools', async t => {
  const miraHome = await mkdtemp(path.join(os.tmpdir(), 'mira-bundled-skills-'));
  t.after(() => rm(miraHome, { recursive: true, force: true }));
  const diagnostics: unknown[] = [];
  const loader = createSkillLoader({ sourceDirectory, miraHome, onDiagnostics: value => diagnostics.push(...value) });
  const skills = await loader(new AbortController().signal);
  assert.deepEqual(diagnostics, []);
  const selected = names.map(name => {
    const found = skills.find(skill => skill.name === name);
    assert.ok(found, `real discovery must find ${name}`);
    assert.equal(found.filePath, path.join(sourceDirectory, 'skills', name, 'SKILL.md'));
    return found;
  });
  const writer = new MemoryWriter();
  const read = createWorkspaceTools(sourceDirectory).find(tool => tool.name === 'read')!;
  let requests = 0;
  await new PiDurableRuntime({ writer, model: { ...model, contextWindow: 131_072 }, tools: [read], loadSkills: loader,
    miraPrompt: { environmentContext: 'Offline bundled skill fixture', authorizationContext: 'Synthetic request to inspect skill instructions' },
    streamFn: (_model, context) => {
      const system = getCurrentSystemPrompt(context.messages);
      for (const skill of selected) assert.ok(system.includes(skill.name));
      assert.doesNotMatch(system, /Mira adaptation:|# PDF Skill|# Audio Transcribe/);
      const index = requests++;
      if (index > 0) assert.ok(JSON.stringify(context.messages).includes(bodyHeadings[index - 1]!), `ordinary read result for ${selected[index - 1]!.name} reaches continuation`);
      if (index === selected.length) return streamOf(assistant());
      return streamOf({ ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: `read-bundled-${index}`, name: 'read', arguments: { path: selected[index]!.filePath } }] });
    },
  }).run(input('Inspect the bundled public tools without installing or contacting a service.'));
  assert.equal(requests, selected.length + 1);
  assert.equal(writer.state.executions.length, selected.length);
});

test('public source manifest preserves unmodified script and license bytes', async () => {
  const manifest = JSON.parse(await readFile(path.join(sourceDirectory, 'skills/upstream-sources.json'), 'utf8')) as {
    files: { path: string; source: string; commit: string; upstreamSha256: string; modified: boolean }[];
  };
  assert.ok(manifest.files.length > 5);
  for (const item of manifest.files) {
    assert.match(item.commit, /^[a-f0-9]{40}$/);
    assert.ok(item.source.startsWith('https://github.com/'));
    const bytes = await readFile(path.join(sourceDirectory, item.path));
    if (!item.modified) assert.equal(createHash('sha256').update(bytes).digest('hex'), item.upstreamSha256, item.path);
  }
});

test('official transcription CLI validates synthetic audio in dry-run without SDK, keys or network', async t => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mira-transcribe-dry-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const audio = path.join(home, 'synthetic.wav');
  // Valid PCM WAV containing 1/10 second of silence, with no user data.
  const bytes = Buffer.alloc(44 + 3200); bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(3200, 40);
  await writeFile(audio, bytes);
  const script = path.join(sourceDirectory, 'skills/transcribe/scripts/transcribe_diarize.py');
  const env = { PATH: process.env['PATH'], HOME: home, PYTHONNOUSERSITE: '1' };
  const output = await run('python3', ['-S', script, audio, '--dry-run'], { env });
  assert.deepEqual(JSON.parse(output.stdout), { model: 'gpt-4o-mini-transcribe', response_format: 'text', chunking_strategy: 'auto' });
  assert.match(output.stderr, /dry-run only/);
  await assert.rejects(run('python3', ['-S', script, audio], { env }), /OPENAI_API_KEY is not set/);
  await assert.rejects(run('python3', ['-S', script, audio, '--dry-run', '--response-format', 'diarized_json'], { env }), /requires gpt-4o-transcribe-diarize/);
  await assert.rejects(run('python3', ['-S', script, path.join(home, 'absent.wav'), '--dry-run'], { env }), /not found|does not exist/i);
});
