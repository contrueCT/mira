import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { memoryUsage, resetMemoryWorkspace, setupMemoryWorkspace } from '@mira/workspace';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Test', '-c', 'user.email=test@localhost', '-C', root, ...args], { encoding: 'utf8', env: { PATH: process.env['PATH'], HOME: process.env['HOME'] } }).trim();
const resetId = '6f1c2f5e-2b8a-4c1d-9e3f-0a1b2c3d4e5f';

async function workspace() {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-memory-reset-')));
  const { memoryRoot } = await setupMemoryWorkspace({ memoryRoot: path.join(base, 'memory'), sourceDirectory: process.cwd() });
  await writeFile(path.join(memoryRoot, 'MEMORY.md'), '# About the user\n- likes oolong\n');
  await mkdir(path.join(memoryRoot, 'people'));
  await writeFile(path.join(memoryRoot, 'people', 'friend.md'), 'A friend from school\n');
  git(memoryRoot, 'add', '-A'); git(memoryRoot, 'commit', '-q', '-m', 'Memory snapshot');
  return { base, memoryRoot };
}

test('Memory reset preserves uncommitted work, clears every tracked file in one revertible commit, and is idempotent', async () => {
  const { base, memoryRoot } = await workspace();
  try {
    await writeFile(path.join(memoryRoot, 'draft.md'), 'not yet committed\n');
    assert.deepEqual(await memoryUsage({ memoryRoot }), { files: 3, bytes: 71 });
    const result = await resetMemoryWorkspace({ memoryRoot, resetId });
    assert.equal(result.recovered, false); assert.equal(result.removedFiles, 2); assert.ok(result.preservedCommitId);
    assert.equal(await readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf8'), '');
    assert.equal(git(memoryRoot, 'ls-files'), 'MEMORY.md');
    assert.equal(git(memoryRoot, 'status', '--porcelain'), '');
    assert.match(git(memoryRoot, 'show', '-s', '--format=%B', result.commitId), /Mira-Reset-Id: 6f1c2f5e-2b8a-4c1d-9e3f-0a1b2c3d4e5f\nMira-Reset-Phase: clear$/);
    assert.match(git(memoryRoot, 'show', '-s', '--format=%B', result.preservedCommitId!), /Mira-Reset-Phase: preserve$/);
    assert.deepEqual(await memoryUsage({ memoryRoot }), { files: 1, bytes: 0 });
    const again = await resetMemoryWorkspace({ memoryRoot, resetId });
    assert.deepEqual({ ...again, recovered: false }, result); assert.equal(again.recovered, true);
    git(memoryRoot, 'revert', '--no-edit', result.commitId);
    assert.equal(await readFile(path.join(memoryRoot, 'draft.md'), 'utf8'), 'not yet committed\n', 'revert restores even the preserved draft');
    assert.match(await readFile(path.join(memoryRoot, 'MEMORY.md'), 'utf8'), /likes oolong/);
  } finally { await rm(base, { recursive: true, force: true }); }
});

test('a reset interrupted after its preserve commit resumes without preserving the half-cleared tree', async () => {
  const { base, memoryRoot } = await workspace();
  try {
    await writeFile(path.join(memoryRoot, 'draft.md'), 'pending\n');
    git(memoryRoot, 'add', '-A');
    git(memoryRoot, 'commit', '-q', '-m', `Memory before reset\n\nMira-Reset-Id: ${resetId}\nMira-Reset-Phase: preserve`);
    const preserve = git(memoryRoot, 'rev-parse', 'HEAD');
    await rm(path.join(memoryRoot, 'draft.md')); // the crash happened mid-removal
    const result = await resetMemoryWorkspace({ memoryRoot, resetId });
    assert.equal(result.preservedCommitId, preserve);
    assert.equal(git(memoryRoot, 'rev-parse', `${result.commitId}^`), preserve);
    assert.equal(git(memoryRoot, 'ls-files'), 'MEMORY.md');
  } finally { await rm(base, { recursive: true, force: true }); }
});
