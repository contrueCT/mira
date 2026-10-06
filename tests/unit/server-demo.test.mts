import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createWorkspaceTools } from '@mira/server';
import { MemoryWriter, runtime, scripted, assistant, input } from '../recovery/fixtures.mts';

test('ordinary read accepts absolute paths and symlinks outside its default cwd', async () => {
  const root = await mkdtemp('/tmp/mira-demo-file-');
  const outside = await mkdtemp('/tmp/mira-demo-outside-');
  try {
    const file = path.join(root, 'ordinary.txt'); await writeFile(file, 'ordinary UTF-8 text 😀\nsecond line');
    const tool = createWorkspaceTools(root).find(tool => tool.name === 'read')!;
    const value = await tool.execute('read-1', { path: file });
    assert.deepEqual(value.content, [{ type: 'text', text: await readFile(file, 'utf8') }]);
    const secret = path.join(outside, 'outside.txt'); await writeFile(secret, 'synthetic outside cwd');
    assert.match(JSON.stringify(await tool.execute('read-2', { path: secret })), /synthetic outside cwd/);
    await symlink(secret, path.join(root, 'escape'));
    assert.match(JSON.stringify(await tool.execute('read-3', { path: 'escape' })), /synthetic outside cwd/);
    const abort = new AbortController(); abort.abort(Error('cancelled'));
    await assert.rejects(tool.execute('read-4', { path: file }, abort.signal), /aborted|cancelled/i);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('CLI help works without database/model credentials', () => {
  const result = spawnSync(process.execPath, ['apps/server/src/cli.mts', '--help'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic PostgreSQL demo/);
  assert.match(result.stdout, /No real model or credentials/);
  assert.match(result.stdout, /MIRA_DEMO_MEMORY \(optional Memory root\)/);
});


test('native Pi tools write, edit, search and run harmless shell outside cwd without app isolation', async () => {
  const root = await mkdtemp('/tmp/mira-tools-');
  const outside = await mkdtemp('/tmp/mira-tools-outside-');
  try {
    const tools = new Map(createWorkspaceTools(root).map(tool => [tool.name, tool]));
    assert.deepEqual([...tools.keys()], ['read', 'write', 'edit', 'grep', 'find', 'ls', 'bash']);
    const target = path.join(outside, 'synthetic.txt');
    await tools.get('write')!.execute('write', { path: target, content: 'synthetic before' });
    await tools.get('edit')!.execute('edit', { path: target, edits: [{ oldText: 'before', newText: 'after' }] });
    assert.equal(await readFile(target, 'utf8'), 'synthetic after');
    const shell = await tools.get('bash')!.execute('shell', { command: `cd '${outside}' && printf 'harmless shell\\n' && cat synthetic.txt` });
    assert.match(JSON.stringify(shell.content), /harmless shell/);
    assert.match(JSON.stringify(shell.content), /synthetic after/);
    const listing = await tools.get('ls')!.execute('ls', { path: outside });
    assert.match(JSON.stringify(listing.content), /synthetic.txt/);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});


test('the durable runtime accepts native registry and records canonical edit before executing it', async () => {
  const root = await mkdtemp('/tmp/mira-native-registry-');
  try {
    const target = path.join(root, 'synthetic.txt'); await writeFile(target, 'before');
    const writer = new MemoryWriter(); const tools = createWorkspaceTools(root);
    assert.ok(tools.every(tool => !tool.prepareArguments));
    const args = { path: target, edits: [{ oldText: 'before', newText: 'after' }] };
    let intents = 0;
    writer.beforeIntent = async intent => {
      intents++; assert.deepEqual(intent.arguments, args); assert.equal(await readFile(target, 'utf8'), 'before');
    };
    const instance = runtime(writer, scripted([
      { ...assistant(), stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'native-edit', name: 'edit', arguments: args }] }, assistant(),
    ]), { tools });
    await instance.run(input());
    assert.equal(intents, 1); assert.equal(await readFile(target, 'utf8'), 'after');
    assert.deepEqual(writer.state.executions[0]?.intent.arguments, args);
  } finally { await rm(root, { recursive: true, force: true }); }
});
