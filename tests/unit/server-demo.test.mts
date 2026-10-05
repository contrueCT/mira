import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { createReadFileTool } from '@mira/server';

test('ordinary read_file reads normal text and refuses paths outside its workspace', async () => {
  const root = await mkdtemp('/tmp/mira-demo-file-');
  const outside = await mkdtemp('/tmp/mira-demo-outside-');
  try {
    const file = path.join(root, 'ordinary.txt'); await writeFile(file, 'ordinary UTF-8 text 😀\nsecond line');
    const tool = createReadFileTool(root);
    const value = await tool.execute('read-1', { path: file });
    assert.deepEqual(value.content, [{ type: 'text', text: await readFile(file, 'utf8') }]);
    const secret = path.join(outside, 'outside.txt'); await writeFile(secret, 'synthetic not authorized');
    await assert.rejects(tool.execute('read-2', { path: secret }), /outside/);
    await symlink(secret, path.join(root, 'escape'));
    await assert.rejects(tool.execute('read-3', { path: 'escape' }), /outside/);
    const abort = new AbortController(); abort.abort(Error('cancelled'));
    await assert.rejects(tool.execute('read-4', { path: file }, abort.signal), /aborted|cancelled/i);
  } finally { await rm(root, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('CLI help works without database/model credentials', () => {
  const result = spawnSync(process.execPath, ['apps/server/src/cli.mts', '--help'], { encoding: 'utf8', timeout: 15_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /synthetic PostgreSQL demo/);
  assert.match(result.stdout, /No real model or credentials/);
});
