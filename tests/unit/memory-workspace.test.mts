import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadMemoryBootstrap, setupMemoryWorkspace, snapshotMemory } from '@mira/workspace';

const execute = promisify(execFile);
async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-C', root, ...args], { env: { PATH: process.env['PATH'], HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' } })).stdout.trim();
}
interface Fixture { base: string; memoryRoot: string; stateRoot: string; sourceDirectory: string }
async function withWorkspace(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp('/tmp/mira-memory-workspace-');
  const fixture = { base, memoryRoot: path.join(base, 'Memory'), stateRoot: path.join(base, 'State'), sourceDirectory: path.join(base, 'source') };
  try { await mkdir(fixture.sourceDirectory); await run(fixture); }
  finally { await rm(base, { recursive: true, force: true }); }
}
const snapshot = (memoryRoot: string, runId: string, miraId = 'mira-test') => snapshotMemory({ memoryRoot, miraId, runId });
const refFor = (runId: string, miraId = 'mira-test') => `refs/mira/wake-snapshots/${createHash('sha256').update(JSON.stringify([miraId, runId])).digest('hex')}`;

test('setup requires only MEMORY.md, creates no State files or taxonomy, and preserves existing text', async () => {
  await withWorkspace(async (options) => {
    await mkdir(options.memoryRoot); await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'A remembered fact.\n');
    await mkdir(options.stateRoot); await writeFile(path.join(options.stateRoot, 'anything.txt'), 'Unstructured current state.');
    const workspace = await setupMemoryWorkspace(options);
    assert.deepEqual(workspace, { memoryRoot: options.memoryRoot, stateRoot: options.stateRoot, repositoryId: workspace.repositoryId });
    assert.match(workspace.repositoryId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await setupMemoryWorkspace(options), workspace);
    assert.deepEqual((await readdir(options.memoryRoot)).sort(), ['.git', 'MEMORY.md']);
    assert.deepEqual(await readdir(options.stateRoot), ['anything.txt']);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'A remembered fact.\n');
    assert.equal(await git(options.memoryRoot, 'rev-parse', '--show-toplevel'), options.memoryRoot);
    await assert.rejects(git(options.stateRoot, 'rev-parse', '--show-toplevel'), /not a git repository/);
  });
});

test('bootstrap reads MEMORY.md and only explicit State files, with no reinjection or write', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Memory contents');
    await writeFile(path.join(options.memoryRoot, 'not-bootstrap.md'), 'Never loaded');
    await writeFile(path.join(options.stateRoot, 'unlisted.md'), 'Never loaded');
    await mkdir(path.join(options.stateRoot, 'free-form'));
    await writeFile(path.join(options.stateRoot, 'free-form', 'current.md'), 'Current state');
    const loaded = await loadMemoryBootstrap({ ...options, stateFiles: ['free-form/current.md'] });
    assert.deepEqual(loaded, { memory: { path: path.join(options.memoryRoot, 'MEMORY.md'), content: 'Memory contents' },
      state: [{ path: path.join(options.stateRoot, 'free-form/current.md'), content: 'Current state' }] });
    assert.deepEqual((await loadMemoryBootstrap(options)).state, []);
    await assert.rejects(loadMemoryBootstrap({ ...options, stateFiles: ['missing.md'] }), /ENOENT/);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Memory contents');
  });
});

test('bootstrap rejects escaping State paths and symlinks while supporting explicit nested text', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.base, 'outside.txt'), 'Outside');
    await symlink(path.join(options.base, 'outside.txt'), path.join(options.stateRoot, 'linked.txt'));
    for (const stateFiles of [['../outside.txt'], ['linked.txt'], [path.join(options.base, 'outside.txt')]]) {
      await assert.rejects(loadMemoryBootstrap({ ...options, stateFiles }), /within stateRoot/);
    }
    await unlink(path.join(options.memoryRoot, 'MEMORY.md'));
    await symlink(path.join(options.base, 'outside.txt'), path.join(options.memoryRoot, 'MEMORY.md'));
    await assert.rejects(loadMemoryBootstrap(options), /ELOOP/);
  });
});

test('data roots cannot overlap each other/source, including canonical symlink aliases', async () => {
  await withWorkspace(async (options) => {
    for (const override of [
      { memoryRoot: options.sourceDirectory }, { memoryRoot: path.join(options.sourceDirectory, 'data') },
      { memoryRoot: options.base }, { stateRoot: options.memoryRoot }, { stateRoot: path.join(options.memoryRoot, 'state') },
      { memoryRoot: path.join(options.stateRoot, 'memory') },
    ]) await assert.rejects(setupMemoryWorkspace({ ...options, ...override }), /separate and non-overlapping/);
    const alias = path.join(options.base, 'source-alias'); await symlink(options.sourceDirectory, alias);
    await assert.rejects(setupMemoryWorkspace({ ...options, memoryRoot: path.join(alias, 'memory') }), /separate and non-overlapping/);
    assert.deepEqual(await readdir(options.sourceDirectory), []);
  });
});

test('State stays outside Git and Memory cannot silently inherit an ancestor repository', async () => {
  await withWorkspace(async (options) => {
    await mkdir(options.stateRoot); await git(options.stateRoot, 'init', '--quiet');
    await assert.rejects(setupMemoryWorkspace(options), /State must stay outside/);
    await rm(path.join(options.stateRoot, '.git'), { recursive: true });
    const enclosing = path.join(options.base, 'data-repo'); await mkdir(enclosing); await git(enclosing, 'init', '--quiet');
    await assert.rejects(setupMemoryWorkspace({ ...options, memoryRoot: path.join(enclosing, 'memory') }), /independent Git/);
    await assert.rejects(setupMemoryWorkspace({ ...options, stateRoot: path.join(enclosing, 'state') }), /State must stay outside/);
  });
});

test('snapshot commits only changed Memory and leaves State, source and prose metadata untouched', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'User prefers tea.\n');
    await writeFile(path.join(options.stateRoot, 'CURRENT.md'), 'Ordinary current state.');
    await writeFile(path.join(options.sourceDirectory, 'source.ts'), 'Source is not data');
    const first = await snapshot(options.memoryRoot, 'wake-1');
    assert.equal(first.changed, true); assert.equal(first.recovered, false);
    assert.match(first.commitId!, /^[a-f0-9]{40,64}$/); assert.deepEqual(first.changedPaths, ['MEMORY.md']);
    assert.equal(await git(options.memoryRoot, 'ls-tree', '-r', '--name-only', first.commitId!), 'MEMORY.md');
    assert.equal(await git(options.memoryRoot, 'status', '--porcelain'), '');
    assert.match(await git(options.memoryRoot, 'log', '-1', '--format=%B'), /Mira-Run-Key:/);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'User prefers tea.\n');
    await writeFile(path.join(options.stateRoot, 'CURRENT.md'), 'Changed State alone');
    const unchanged = await snapshot(options.memoryRoot, 'wake-2');
    assert.equal(unchanged.changed, false); assert.equal(unchanged.commitId, null); assert.deepEqual(unchanged.changedPaths, []);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'cat-file', '-t', refFor('wake-2')), 'tree');
  });
});

test('snapshot includes pre-existing edits, additions, deletions and unusual path names without claiming authorship', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, 'remove.md'), 'Old file');
    await snapshot(options.memoryRoot, 'baseline');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Manual edit before wake');
    await unlink(path.join(options.memoryRoot, 'remove.md'));
    await writeFile(path.join(options.memoryRoot, '-option\nwith\ttabs.md'), 'New file');
    const result = await snapshot(options.memoryRoot, 'wake');
    assert.deepEqual(result.changedPaths.sort(), ['-option\nwith\ttabs.md', 'MEMORY.md', 'remove.md'].sort());
    assert.equal(await git(options.memoryRoot, 'show', `${result.commitId}:MEMORY.md`), 'Manual edit before wake');
    assert.equal(await git(options.memoryRoot, 'status', '--porcelain'), '');
  });
});

test('retry after Git commit but before DB association recovers the exact run without capturing later changes', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const first = await snapshot(options.memoryRoot, 'stable-run');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'A later wake edit');
    const retry = await snapshot(options.memoryRoot, 'stable-run');
    assert.deepEqual(retry, { ...first, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'show', `${first.commitId}:MEMORY.md`), '');
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'A later wake edit');
    const next = await snapshot(options.memoryRoot, 'next-run');
    assert.notEqual(next.commitId, first.commitId);
  });
});

test('no-change receipt survives later changes and restart without generating an empty commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); await snapshot(options.memoryRoot, 'baseline');
    const noChange = await snapshot(options.memoryRoot, 'unchanged');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'New change');
    const modulePath = new URL('../../packages/workspace/src/index.ts', import.meta.url).href;
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `import { snapshotMemory } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await snapshotMemory(${JSON.stringify({ memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: 'unchanged' })})));`],
      { env: { PATH: process.env['PATH'], HOME: options.base } });
    assert.deepEqual(JSON.parse(stdout), { ...noChange, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
  });
});

test('Mira/run keys are scoped and arbitrary run identifiers never become shell or ref syntax', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const runId = 'run\n../../evil;$(touch sentinel)\0';
    const one = await snapshot(options.memoryRoot, runId, 'one');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Another Mira');
    const two = await snapshot(options.memoryRoot, runId, 'two');
    assert.notEqual(one.commitId, two.commitId);
    assert.equal((await snapshot(options.memoryRoot, runId, 'one')).commitId, one.commitId);
    assert.deepEqual((await readdir(options.memoryRoot)).sort(), ['.git', 'MEMORY.md']);
  });
});

test('Git ignores remain ordinary and an empty unborn tree creates no commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, '.git', 'info', 'exclude'), '*\n');
    const empty = await snapshot(options.memoryRoot, 'ignored');
    assert.equal(empty.changed, false); assert.equal(empty.commitId, null);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
    assert.equal(await git(options.memoryRoot, 'cat-file', '-t', refFor('ignored')), 'tree');
  });
});

test('real Git index-lock errors are surfaced and a later same-run retry succeeds', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const lock = path.join(options.memoryRoot, '.git', 'index.lock'); await writeFile(lock, 'Existing lock');
    await assert.rejects(snapshot(options.memoryRoot, 'retry-error'), /index\.lock/);
    assert.equal(await readFile(lock, 'utf8'), 'Existing lock');
    await unlink(lock);
    assert.equal((await snapshot(options.memoryRoot, 'retry-error')).changed, true);
  });
});

test('cancellation is reported before setup/snapshot, without pretending success or replaying', async () => {
  await withWorkspace(async (options) => {
    const controller = new AbortController(); controller.abort(new Error('cancelled by test'));
    await assert.rejects(setupMemoryWorkspace({ ...options, signal: controller.signal }), /cancelled by test/);
    assert.deepEqual(await readdir(options.base), ['source']);
    await setupMemoryWorkspace(options);
    await assert.rejects(snapshotMemory({ memoryRoot: options.memoryRoot, miraId: 'mira', runId: 'cancelled', signal: controller.signal }), /cancelled by test/);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
  });
});

test('unregistered source repositories and linked Git directories cannot be snapshotted', async () => {
  await withWorkspace(async (options) => {
    await git(options.sourceDirectory, 'init', '--quiet');
    await assert.rejects(snapshot(options.sourceDirectory, 'bad-root'), /ENOENT/);
    await mkdir(options.memoryRoot); await symlink(path.join(options.sourceDirectory, '.git'), path.join(options.memoryRoot, '.git'));
    await assert.rejects(setupMemoryWorkspace(options), /own .git directory/);
    assert.deepEqual(await readdir(options.sourceDirectory), ['.git']);
  });
});

test('a failed run ref transaction creates neither a published snapshot nor an unassociated HEAD commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const baseline = await snapshot(options.memoryRoot, 'baseline');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'New value');
    const lock = path.join(options.memoryRoot, '.git', `${refFor('blocked')}.lock`);
    await mkdir(path.dirname(lock), { recursive: true }); await writeFile(lock, 'existing');
    await assert.rejects(snapshot(options.memoryRoot, 'blocked'), /cannot lock ref/);
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), baseline.commitId);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', refFor('blocked')));
    await unlink(lock);
    assert.equal((await snapshot(options.memoryRoot, 'blocked')).changed, true);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '2');
  });
});


test('a HEAD commit whose run ref was lost is recovered by its exact trailers before later edits', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const first = await snapshot(options.memoryRoot, 'partial-publication');
    await git(options.memoryRoot, 'update-ref', '-d', refFor('partial-publication'));
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later edit must not be captured');
    const result = await snapshot(options.memoryRoot, 'partial-publication');
    assert.deepEqual(result, { ...first, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor('partial-publication')), first.commitId);
  });
});

test('a mismatched commit behind a run receipt is rejected instead of inventing lineage', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const original = await snapshot(options.memoryRoot, 'original');
    await git(options.memoryRoot, 'update-ref', refFor('unrelated'), original.commitId!);
    await assert.rejects(snapshot(options.memoryRoot, 'unrelated'), /does not match this Mira\/run key/);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
  });
});

test('concurrent same-run attempts converge after honest Git-lock/conflict errors without duplicate commits', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => snapshot(options.memoryRoot, 'same-run')));
    const result = await snapshot(options.memoryRoot, 'same-run');
    assert.equal(result.changed, true);
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') assert.equal(attempt.value.commitId, result.commitId);
      else assert.match(String(attempt.reason), /lock|already exists|is at .* but expected/);
    }
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor('same-run')), result.commitId);
  });
});

test('a receipt published before HEAD repairs only its exact parent and prevents duplicate next-run commits', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const baseline = await snapshot(options.memoryRoot, 'baseline');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Changed once');
    const changed = await snapshot(options.memoryRoot, 'receipt-first');
    // Simulate the opposite partial publication: receipt durable, HEAD old.
    await git(options.memoryRoot, 'update-ref', 'HEAD', baseline.commitId!, changed.commitId!);
    assert.deepEqual(await snapshot(options.memoryRoot, 'receipt-first'), { ...changed, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), changed.commitId);
    const next = await snapshot(options.memoryRoot, 'next-unchanged');
    assert.equal(next.changed, false); assert.equal(next.commitId, null);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '2');
  });
});

test('an initial snapshot receipt repairs an unborn HEAD without making another commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const first = await snapshot(options.memoryRoot, 'first');
    await git(options.memoryRoot, 'update-ref', '-d', 'HEAD', first.commitId!);
    assert.deepEqual(await snapshot(options.memoryRoot, 'first'), { ...first, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), first.commitId);
    assert.equal((await snapshot(options.memoryRoot, 'next-unchanged')).changed, false);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
  });
});

test('receipt recovery keeps legitimate descendants without rewinding HEAD', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const original = await snapshot(options.memoryRoot, 'original');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later change');
    const later = await snapshot(options.memoryRoot, 'later');
    assert.deepEqual(await snapshot(options.memoryRoot, 'original'), { ...original, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), later.commitId);
  });
});

test('receipt recovery rejects divergent HEAD evidence and preserves that branch unchanged', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const baseline = await snapshot(options.memoryRoot, 'baseline');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Snapshot content');
    const captured = await snapshot(options.memoryRoot, 'captured');
    await git(options.memoryRoot, 'update-ref', 'HEAD', baseline.commitId!, captured.commitId!);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Independent divergent edit');
    await git(options.memoryRoot, 'add', '-A'); await git(options.memoryRoot, 'commit', '-qm', 'Independent branch');
    const divergent = await git(options.memoryRoot, 'rev-parse', 'HEAD');
    await assert.rejects(snapshot(options.memoryRoot, 'captured'), /divergent history.*refusing to replace HEAD/);
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), divergent);
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor('captured')), captured.commitId);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Independent divergent edit');
  });
});

test('a non-root receipt cannot repair a missing parent chain by replacing an unborn HEAD', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); await snapshot(options.memoryRoot, 'baseline');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Another commit');
    const captured = await snapshot(options.memoryRoot, 'captured');
    await git(options.memoryRoot, 'update-ref', '-d', 'HEAD', captured.commitId!);
    await assert.rejects(snapshot(options.memoryRoot, 'captured'), /divergent history/);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor('captured')), captured.commitId);
  });
});

test('a recreated .git gets a new repository identity and pending-run retries reject it before capturing later edits', async () => {
  await withWorkspace(async (options) => {
    const original = await setupMemoryWorkspace(options);
    await snapshotMemory({ memoryRoot: original.memoryRoot, miraId: 'mira-test', runId: 'pending', expectedRepositoryId: original.repositoryId });
    await rm(path.join(options.memoryRoot, '.git'), { recursive: true });
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later unassociated edits');
    const replacement = await setupMemoryWorkspace(options);
    assert.notEqual(replacement.repositoryId, original.repositoryId);
    await assert.rejects(snapshotMemory({ memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: 'pending', expectedRepositoryId: original.repositoryId }), /repository identity changed/);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', refFor('pending')));
    assert.equal(await git(options.memoryRoot, 'diff', '--cached', '--name-only'), '');
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Later unassociated edits');
  });
});

test('a substituted .git repository cannot reuse a pending run bound to the previous repository identity', async () => {
  await withWorkspace(async (options) => {
    const original = await setupMemoryWorkspace(options);
    await rename(path.join(options.memoryRoot, '.git'), path.join(options.base, 'original-git-backup'));
    await git(options.memoryRoot, 'init', '--quiet', '--initial-branch=main');
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Replacement repository contents');
    await git(options.memoryRoot, 'add', '-A'); await git(options.memoryRoot, 'commit', '-qm', 'Replacement baseline');
    const replacementHead = await git(options.memoryRoot, 'rev-parse', 'HEAD');
    const replacement = await setupMemoryWorkspace(options);
    assert.notEqual(replacement.repositoryId, original.repositoryId);
    await assert.rejects(snapshotMemory({ memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: 'pending', expectedRepositoryId: original.repositoryId }), /repository identity changed/);
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), replacementHead);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', refFor('pending')));
  });
});

test('repository identity is stable and expected identity accepts a normal same-repository retry', async () => {
  await withWorkspace(async (options) => {
    const original = await setupMemoryWorkspace(options);
    const request = { memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: 'stable', expectedRepositoryId: original.repositoryId };
    const first = await snapshotMemory(request);
    assert.equal((await setupMemoryWorkspace(options)).repositoryId, original.repositoryId);
    assert.deepEqual(await snapshotMemory(request), { ...first, recovered: true });
    assert.equal((await loadMemoryBootstrap({ memoryRoot: options.memoryRoot, stateRoot: options.stateRoot })).memory.content, '');
  });
});
