import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
const execute = promisify(execFile);
const script = path.resolve('scripts/tool-usability.mts');
async function cli(...args: string[]) {
  const { stdout } = await execute(process.execPath, [script, ...args], { maxBuffer: 3_000_000 });
  return JSON.parse(stdout.trim());
}
function value(response: Awaited<ReturnType<typeof cli>>) { return JSON.parse(response.results[0].result.content[0].text); }

// These assertions are evaluator evidence, not part of the black-box task brief.
test('tool CLI exposes live declarations, bounded history results and production prompt/skill catalog', async () => {
  const { session } = await cli('init');
  try {
    const list = await cli(session, 'list');
    assert.deepEqual(list.tools.map((tool: { name: string }) => tool.name), ['history_search', 'history_read', 'extension_inspect', 'extension_stage', 'extension_manage']);
    assert.match(list.historyBackend, /not PostgreSQL/);
    assert.ok(list.tools.every((tool: { description: string; parameters: unknown }) => tool.description.length > 40 && tool.parameters));
    const prompt = await cli(session, 'prompt');
    assert.match(prompt.prompt, /You are Mira/);
    assert.match(prompt.prompt, /mira-extension-authoring/);
    const search = value(await cli(session, 'call', 'history_search', '{"query":"中文提醒","mode":"substring"}'));
    assert.equal(search.hits.length, 1);
    const original = value(await cli(session, 'call', 'history_read', JSON.stringify({ kind: search.hits[0].kind, id: search.hits[0].id })));
    assert.match(original.event.payload.text, /状态发生变化/);
    const appendix = value(await cli(session, 'call', 'history_search', '{"query":"灯塔尾注","mode":"substring"}'));
    const reference = { kind: appendix.hits[0].kind, id: appendix.hits[0].id };
    const bounded = value(await cli(session, 'call', 'history_read', JSON.stringify(reference)));
    assert.equal(bounded.error, 'too_large');
    const full = value(await cli(session, 'call', 'history_read', JSON.stringify({ ...reference, maxBytes: bounded.requiredBytes })));
    assert.match(full.event.payload.text, /45 days/);
    assert.equal(value(await cli(session, 'call', 'history_read', '{"kind":"event","id":"missing"}')), null);
    const invalid = await cli(session, 'call', 'history_search', '{"query":"x","limit":101}');
    assert.match(invalid.results[0].error, /Validation failed/);
    const records = (await readFile(path.join(session, 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.ok(records.some(record => record.type === 'declarations'));
    assert.ok(records.some(record => record.type === 'call_finished' && record.name === 'history_read'));
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
    assert.equal(value(install).status, 'accepted');
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
    assert.match(active.results[1].error, /not found/, 'same-batch activation cannot publish a new registry early');
    assert.equal(active.settled.extensions[0].status, 'active');
    assert.ok(active.settled.availableTools.includes('hello_world'));
    assert.equal(messages[2].results[0].result.content[0].text, 'Hello, Fixture!');
    const disabled = messages[3];
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
    await writeFile(path.join(session, 'extensions.json'), JSON.stringify({ entries: [{ id: 'slow-cleanup', path: entry }], artifactsDirectory: path.join(session, 'artifacts') }));
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
    await writeFile(path.join(session, 'extensions.json'), JSON.stringify({ entries: [{ id: 'cleanup-on-failure', path: entry }], artifactsDirectory: path.join(session, 'artifacts') }));
    const evidence = path.join(session, 'evidence.jsonl'); await rm(evidence); await mkdir(evidence);
    await assert.rejects(execute(process.execPath, [script, session, 'list'], { timeout: 5000 }), (error: unknown) => {
      const failure = error as Error & { code?: number; signal?: string; stderr?: string };
      return failure.code === 1 && !failure.signal && /EISDIR/.test(String(failure.stderr));
    });
    assert.equal(await readFile(marker, 'utf8'), 'done');
  } finally { await rm(session, { recursive: true, force: true }); }
});
