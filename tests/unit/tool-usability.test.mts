import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { HistoryError, type HistoryReadRequest } from '@mira/life';
import { FixtureHistoryReader, fixtureHistoryIds, fixtureMiraId, historyFixtures } from '../../scripts/tool-usability-fixtures.mts';
const execute = promisify(execFile);
const script = path.resolve('scripts/tool-usability.mts');
async function cli(...args: string[]) {
  const { stdout } = await execute(process.execPath, [script, ...args], { maxBuffer: 3_000_000 });
  return JSON.parse(stdout.trim());
}
function value(response: Awaited<ReturnType<typeof cli>>) { return JSON.parse(response.results[0].result.content[0].text); }

// These assertions are evaluator evidence, not part of the black-box task brief.
test('tool CLI begins with a blank home and uses the web default loader on first open and reopen', async () => {
  const { session, paths } = await cli('init');
  try {
    assert.deepEqual(await readdir(paths.home), []);
    await assert.rejects(access(paths.configuration));
    const list = await cli(session, 'list');
    assert.ok(list.tools.some((tool: { name: string }) => tool.name === 'extension_manage'));
    assert.equal(paths.configuration, path.join(paths.home, 'extensions.json'));
    assert.equal(paths.artifacts, path.join(paths.home, 'extension-artifacts'));
    const bytes = await readFile(paths.configuration, 'utf8');
    assert.deepEqual(JSON.parse(bytes), { entries: [], artifactsDirectory: paths.artifacts });
    const prompt = await cli(session, 'prompt');
    assert.ok(prompt.prompt.includes(paths.artifacts));
    assert.deepEqual(value(await cli(session, 'call', 'extension_inspect', '{}')).extensions, []);
    assert.equal(await readFile(paths.configuration, 'utf8'), bytes);
  } finally { await rm(session, { recursive: true, force: true }); }
});

test('tool CLI exposes live declarations, bounded history results and production prompt/skill catalog', async () => {
  const { session } = await cli('init');
  try {
    const list = await cli(session, 'list');
    assert.deepEqual(list.tools.map((tool: { name: string }) => tool.name), ['history_search', 'history_read', 'extension_inspect', 'extension_stage', 'extension_manage']);
    assert.match(list.historyBackend, /not PostgreSQL/);
    const readSchema = list.tools.find((tool: { name: string }) => tool.name === 'history_read').parameters;
    assert.deepEqual(Object.keys(readSchema.properties).sort(), ['id', 'maxBytes', 'offset', 'revision']);
    assert.deepEqual(readSchema.required, ['id']);
    assert.equal(readSchema.additionalProperties, false);
    assert.match(fixtureHistoryIds.requirement, new RegExp(readSchema.properties.id.pattern));
    assert.ok(list.tools.every((tool: { description: string; parameters: unknown }) => tool.description.length > 40 && tool.parameters));
    const prompt = await cli(session, 'prompt');
    assert.match(prompt.prompt, /You are Mira/);
    assert.match(prompt.prompt, /mira-extension-authoring/);
    const search = value(await cli(session, 'call', 'history_search', '{"query":"中文提醒","mode":"substring","kinds":["event"]}'));
    assert.equal(search.hits.length, 1);
    const original = value(await cli(session, 'call', 'history_read', JSON.stringify({ id: search.hits[0].id })));
    assert.match(original.event.payload.text, /状态发生变化/);
    assert.equal(original.kind, 'event');
    assert.equal(original.id, fixtureHistoryIds.requirement);
    assert.equal(original.event.id, 'evt-104');
    assert.notEqual(original.id, original.event.id);
    const prefixMiss = value(await cli(session, 'call', 'history_search', '{"query":"灯塔尾注","mode":"full_text"}'));
    assert.deepEqual(prefixMiss.hits, []);
    assert.equal(prefixMiss.fullTextPrefixChars, 65_536);
    const appendix = value(await cli(session, 'call', 'history_search', '{"query":"灯塔尾注","mode":"substring"}'));
    const reference = { id: appendix.hits[0].id };
    const bounded = value(await cli(session, 'call', 'history_read', JSON.stringify(reference)));
    assert.equal(bounded.error, 'too_large');
    const full = value(await cli(session, 'call', 'history_read', JSON.stringify({ ...reference, maxBytes: bounded.requiredBytes })));
    assert.match(full.event.payload.text, /45 days/);
    assert.equal(value(await cli(session, 'call', 'history_read', '{"id":"ffffffff-ffff-4fff-8fff-ffffffffffff"}')), null);
    assert.equal(value(await cli(session, 'call', 'history_read', JSON.stringify({ id: fixtureHistoryIds.otherMira }))), null);
    assert.deepEqual(value(await cli(session, 'call', 'history_search', '{"query":"belonging only to another Mira","mode":"substring"}')).hits, []);
    const wrongShape = await cli(session, 'call', 'history_read', JSON.stringify({ id: original.id, kind: 'event' }));
    assert.ok(wrongShape.results[0].error?.includes('Validation failed') || value(wrongShape).error === 'invalid');
    const invalidId = await cli(session, 'call', 'history_read', '{"id":"evt-104"}');
    assert.match(invalidId.results[0].error, /Validation failed/);
    const invalid = await cli(session, 'call', 'history_search', '{"query":"x","limit":101}');
    assert.match(invalid.results[0].error, /Validation failed/);
    const records = (await readFile(path.join(session, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(record => record.type === 'declarations'));
    assert.ok(records.some(record => record.type === 'call_finished' && record.name === 'history_read'));
  } finally { await rm(session, { recursive: true, force: true }); }
});

test('fixture identities keep original source keys and resolve every provenance link', async () => {
  const entries = historyFixtures();
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  assert.equal(byId.size, entries.length);
  const reader = new FixtureHistoryReader(entries);
  for (const entry of entries) {
    assert.match(entry.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    if (entry.miraId !== fixtureMiraId) continue;
    assert.deepEqual(await reader.read({ id: entry.id, maxBytes: 1_048_576 }), entry);
    if (entry.kind === 'context') {
      assert.equal(entry.record.id, entry.id);
      if (entry.record.parentId) assert.equal(byId.get(entry.record.parentId)?.kind, 'context');
    } else if (entry.kind === 'tool') {
      const assistant = byId.get(entry.intent.assistantRecordId);
      assert.equal(assistant?.kind, 'context');
      assert.ok(assistant?.kind === 'context');
      assert.equal(assistant.version, entry.contextVersion);
      assert.match(JSON.stringify(assistant.record.payload), new RegExp(entry.intent.callId));
      assert.notEqual(entry.id, entry.intent.callId);
      if (entry.outcome) assert.equal(entry.outcome.callId, entry.intent.callId);
    } else if (entry.kind === 'wake') {
      assert.equal(byId.get(entry.inputRecordId!)?.kind, 'context');
      if (entry.finalRecordId) assert.equal(byId.get(entry.finalRecordId)?.kind, 'context');
      for (const request of entry.requests) {
        const event = byId.get(request.eventId);
        assert.ok(event?.kind === 'event');
        assert.equal(event.event.id, request.externalEventId);
        assert.equal(event.requestedWake?.id, request.wakeReceiptId);
        assert.notEqual(request.eventId, request.externalEventId);
      }
    }
  }
  for (const request of [
    { id: 'evt-104' }, { id: 'FFFFFFFF-FFFF-4FFF-8FFF-FFFFFFFFFFFF' }, { id: `${fixtureHistoryIds.requirement}\n` },
    { id: fixtureHistoryIds.requirement, kind: 'event' }, { id: fixtureHistoryIds.requirement, miraId: 'another-synthetic-mira' },
  ]) await assert.rejects(reader.read(request as HistoryReadRequest), (error: unknown) => error instanceof HistoryError && error.code === 'invalid');
  assert.equal(await reader.read({ id: fixtureHistoryIds.otherMira }), null);
  assert.deepEqual((await reader.search({ query: 'belonging only to another Mira', mode: 'substring' })).hits, []);
  assert.throws(() => new FixtureHistoryReader([...entries, { ...entries[0]!, miraId: 'duplicate-in-other-mira' }]), /globally unique/);
});

test('tool CLI traces a real production Memory Git commit through direct History IDs', async () => {
  const { session, paths, exercises } = await cli('init');
  try {
    assert.equal(paths.memory, path.join(session, 'Memory'));
    assert.ok(exercises.some((goal: string) => goal.includes('commit’s provenance')));
    assert.ok(!exercises.join(' ').includes(fixtureHistoryIds.wake));
    const git = async (...args: string[]) => (await execute('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', paths.memory, ...args], {
      env: { PATH: process.env['PATH'], HOME: session, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
    })).stdout.trim();
    assert.equal(await git('rev-parse', '--show-toplevel'), paths.memory);
    const commit = await git('rev-parse', 'HEAD');
    assert.match(commit, /^[0-9a-f]{40,64}$/);
    assert.equal(await git('cat-file', '-t', commit), 'commit');
    const message = await git('show', '-s', '--format=%B', commit);
    const historyId = /^History-Id: (.+)$/m.exec(message)?.[1];
    assert.equal(historyId, fixtureHistoryIds.wake);
    assert.match(message, /^Mira-Run-Key: [0-9a-f]{64}$/m);
    assert.match(await git('show', `${commit}:harbor-export.md`), /Harbor export/);
    assert.equal(await git('status', '--porcelain'), '');
    assert.equal(await git('remote'), '');
    const wake = value(await cli(session, 'call', 'history_read', JSON.stringify({ id: historyId })));
    assert.equal(wake.kind, 'wake');
    assert.equal(wake.status, 'completed');
    const input = value(await cli(session, 'call', 'history_read', JSON.stringify({ id: wake.inputRecordId })));
    const final = value(await cli(session, 'call', 'history_read', JSON.stringify({ id: wake.finalRecordId })));
    assert.equal(input.kind, 'context');
    assert.equal(final.kind, 'context');
    assert.match(JSON.stringify(final.record.payload), new RegExp(commit));
    for (const request of wake.requests) {
      const event = value(await cli(session, 'call', 'history_read', JSON.stringify({ id: request.eventId })));
      assert.equal(event.kind, 'event');
      assert.equal(event.event.id, request.externalEventId);
      assert.equal(event.requestedWake.id, request.wakeReceiptId);
    }
    const search = value(await cli(session, 'call', 'history_search', '{"query":"verify-harbor-export","mode":"substring","kinds":["tool"]}'));
    assert.equal(search.hits.length, 1);
    const tool = value(await cli(session, 'call', 'history_read', JSON.stringify({ id: search.hits[0].id })));
    assert.equal(tool.outcome, null);
    assert.equal(tool.intent.callId, 'call-312');
    const assistant = value(await cli(session, 'call', 'history_read', JSON.stringify({ id: tool.intent.assistantRecordId })));
    assert.equal(assistant.kind, 'context');
    assert.equal(assistant.version, tool.contextVersion);
    assert.equal(assistant.record.payload.message.content[1].id, tool.intent.callId);
    const prompt = await cli(session, 'prompt');
    assert.ok(prompt.prompt.includes(paths.memory));
  } finally { await rm(session, { recursive: true, force: true }); }
});

test('tool CLI stages real files without importing them and reports genuine handler rejections', async () => {
  const { session, paths } = await cli('init');
  try {
    const release = value(await cli(session, 'call', 'extension_stage', JSON.stringify({ sourceRoot: paths.draft, entryRelative: 'index.mjs' })));
    assert.match(release.digest, /^[a-f0-9]{64}$/);
    await access(release.entry);
    await assert.rejects(access(path.join(session, 'draft-imported.txt')), { code: 'ENOENT' });
    const mismatch = value(await cli(session, 'call', 'extension_stage', JSON.stringify({ sourceRoot: paths.draft, entryRelative: 'index.mjs', expectedDigest: '0'.repeat(64) })));
    assert.equal(mismatch.status, 'rejected');
    const missingConfig = value(await cli(session, 'call', 'extension_manage', '{"id":"sample","action":"configure"}'));
    assert.equal(missingConfig.status, 'rejected');
    assert.match(missingConfig.error, /configure requires config/);
    assert.deepEqual(JSON.parse(await readFile(paths.configuration, 'utf8')).entries, []);
  } finally { await rm(session, { recursive: true, force: true }); }
});

test('tool CLI uses real scaffold, durable desired config, host activation and extension execution', async () => {
  const { session, paths } = await cli('init');
  try {
    await execute(process.execPath, [path.resolve('scripts/create-extension-workspace.mts'), paths.workspace]);
    const release = value(await cli(session, 'call', 'extension_stage', JSON.stringify({ sourceRoot: paths.workspace, entryRelative: 'src/index.ts' })));
    const install = await cli(session, 'call', 'extension_manage', JSON.stringify({ id: 'greeting', action: 'install', digest: release.digest }));
    assert.equal(value(install).status, 'applied');
    assert.equal(value(install).persistence, 'saved');
    assert.equal(value(install).runtime.status, 'disabled');
    assert.equal(install.settled.changes[0].status, 'applied');
    assert.equal(install.settled.extensions[0].status, 'disabled');
    const child = spawn(process.execPath, [script, session, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child.stdin.end([
      { command: 'batch', calls: [{ name: 'extension_manage', arguments: { id: 'greeting', action: 'activate' } }, { name: 'hello_world', arguments: { name: 'TooEarly' } }] },
      { command: 'call', name: 'hello_world', arguments: { name: 'Fixture' } },
      { command: 'call', name: 'extension_manage', arguments: { id: 'greeting', action: 'disable' } },
      { command: 'close' },
    ].map(command => JSON.stringify(command)).join('\n') + '\n');
    assert.equal(await exited, 0, stderr);
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
    const active = messages[1];
    assert.equal(active.results[0].result.content[0].type, 'text');
    assert.equal(value(active).status, 'applied');
    assert.equal(value(active).runtime.status, 'active');
    assert.match(active.results[1].error, /not found/, 'an undeclared same-batch tool remains unavailable until the next request');
    assert.equal(active.settled.extensions[0].status, 'active');
    assert.ok(active.settled.availableTools.includes('hello_world'));
    assert.equal(messages[2].results[0].result.content[0].text, 'Hello, Fixture!');
    const disabled = messages[3];
    assert.equal(value(disabled).status, 'applied');
    assert.equal(value(disabled).runtime.status, 'disabled');
    assert.equal(disabled.settled.extensions[0].status, 'disabled');
    assert.ok(!disabled.settled.availableTools.includes('hello_world'));
    assert.equal(JSON.parse(await readFile(paths.configuration, 'utf8')).entries[0].enabled, false);
  } finally { await rm(session, { recursive: true, force: true }); }
});

test('malformed later batch elements never dispatch earlier changes or defer them to a later serve request', async () => {
  const { session, paths } = await cli('init');
  try {
    const release = value(await cli(session, 'call', 'extension_stage', JSON.stringify({ sourceRoot: paths.draft, entryRelative: 'index.mjs' })));
    const calls = [{ name: 'extension_manage', arguments: { id: 'draft', action: 'install', digest: release.digest } }, null];
    await assert.rejects(cli(session, 'batch', JSON.stringify(calls)), /Each call must have/);
    assert.deepEqual(JSON.parse(await readFile(paths.configuration, 'utf8')).entries, []);
    const child = spawn(process.execPath, [script, session, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    child.stdin.end([
      { command: 'batch', calls },
      { command: 'call', name: 'extension_inspect', arguments: {} },
      { command: 'close' },
    ].map(command => JSON.stringify(command)).join('\n') + '\n');
    assert.equal(await exited, 0, stderr);
    const messages = stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.match(messages[1].error, /Each call must have/);
    assert.deepEqual(value(messages[2]).extensions, []);
    assert.deepEqual(messages[2].settled.changes, []);
    assert.deepEqual(JSON.parse(await readFile(paths.configuration, 'utf8')).entries, []);
    const records = (await readFile(paths.evidence, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(!records.some(record => record.type === 'call_started' && record.call?.name === 'extension_manage'));
  } finally { await rm(session, { recursive: true, force: true }); }
});


test('tool CLI rejects a temporary root inside the source before creating a fixture', async () => {
  await assert.rejects(execute(process.execPath, [script, 'init'], { env: { ...process.env, TMPDIR: process.cwd() } }),
    (error: unknown) => error instanceof Error && /outside the checkout/.test(String((error as Error & { stderr?: string }).stderr)));
});

test('serve closed acknowledgement follows actual asynchronous cleanup exactly once', async () => {
  const { session } = await cli('init');
  try {
    const marker = path.join(session, 'cleanup-finished');
    const entry = path.join(session, 'slow-cleanup.mjs');
    await writeFile(entry, `import { writeFile } from 'node:fs/promises';
export default { name: 'slow-cleanup', apply({ mira }) { mira.onCleanup(async () => { await new Promise(resolve => setTimeout(resolve, 50)); await writeFile(${JSON.stringify(marker)}, 'done'); }); } };`);
    await writeFile(path.join(session, 'home', 'extensions.json'), JSON.stringify({ entries: [{ id: 'slow-cleanup', path: entry }], artifactsDirectory: path.join(session, 'home', 'extension-artifacts') }));
    const child = spawn(process.execPath, [script, session, 'serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = ''; let closedSawMarker: Promise<void> | undefined; let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdout.on('data', chunk => {
      buffer += String(chunk);
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (line.ready) child.stdin.end(JSON.stringify({ command: 'close' }) + '\n');
        if (line.closed) closedSawMarker = access(marker);
      }
    });
    assert.equal(await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); }), 0, stderr);
    assert.ok(closedSawMarker); await closedSawMarker;
    const evidence = (await readFile(path.join(session, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(evidence.filter(row => row.type === 'host_closed').length, 1);
  } finally { await rm(session, { recursive: true, force: true }); }
});


test('startup evidence failure closes live plugin resources before reporting an error', async () => {
  const { session } = await cli('init');
  try {
    const marker = path.join(session, 'startup-failure-cleanup');
    const entry = path.join(session, 'cleanup-on-failure.mjs');
    await writeFile(entry, `import { writeFileSync } from 'node:fs';
export default { name: 'cleanup-on-failure', apply({ mira }) { mira.interval(() => {}, 1000); mira.onCleanup(() => writeFileSync(${JSON.stringify(marker)}, 'done')); } };`);
    await writeFile(path.join(session, 'home', 'extensions.json'), JSON.stringify({ entries: [{ id: 'cleanup-on-failure', path: entry }], artifactsDirectory: path.join(session, 'home', 'extension-artifacts') }));
    const evidence = path.join(session, 'evidence.jsonl'); await rm(evidence); await mkdir(evidence);
    await assert.rejects(execute(process.execPath, [script, session, 'list'], { timeout: 5000 }), (error: unknown) => {
      const failure = error as Error & { code?: number; signal?: string; stderr?: string };
      return failure.code === 1 && !failure.signal && /EISDIR/.test(String(failure.stderr));
    });
    assert.equal(await readFile(marker, 'utf8'), 'done');
  } finally { await rm(session, { recursive: true, force: true }); }
});
