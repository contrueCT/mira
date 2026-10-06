import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { loadMemoryBootstrap, setupMemoryWorkspace, snapshotMemory } from '@mira/workspace';

const execute = promisify(execFile);
const RUN = {
  first: '11111111-1111-4111-8111-111111111111',
  second: '22222222-2222-4222-8222-222222222222',
  third: '33333333-3333-4333-8333-333333333333',
} as const;
async function git(root: string, ...args: string[]): Promise<string> {
  return (await execute('git', ['-C', root, ...args], { env: { PATH: process.env['PATH'], HOME: root,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@localhost',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@localhost' } })).stdout.trim();
}
interface Fixture { base: string; memoryRoot: string; sourceDirectory: string }
async function withWorkspace(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const base = await mkdtemp('/tmp/mira-memory-workspace-');
  const fixture = { base, memoryRoot: path.join(base, 'Memory'), sourceDirectory: path.join(base, 'source') };
  try { await mkdir(fixture.sourceDirectory); await run(fixture); }
  finally { await rm(base, { recursive: true, force: true }); }
}
const snapshot = (memoryRoot: string, runId: string, miraId = 'mira-test') => snapshotMemory({ memoryRoot, miraId, runId });
const refFor = (runId: string, miraId = 'mira-test') => `refs/mira/wake-snapshots/${createHash('sha256').update(JSON.stringify([miraId, runId])).digest('hex')}`;

test('setup preserves existing Memory and retains repository identity', async () => {
  await withWorkspace(async (options) => {
    await mkdir(options.memoryRoot); await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'A remembered fact.\n');
    const workspace = await setupMemoryWorkspace(options);
    assert.deepEqual(workspace, { memoryRoot: options.memoryRoot, repositoryId: workspace.repositoryId });
    assert.match(workspace.repositoryId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(await setupMemoryWorkspace(options), workspace);
    assert.deepEqual((await readdir(options.memoryRoot)).sort(), ['.git', 'MEMORY.md']);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'A remembered fact.\n');
    assert.equal(await git(options.memoryRoot, 'rev-parse', '--show-toplevel'), options.memoryRoot);
  });
});

test('Memory-only setup and bootstrap create only the expected workspace', async () => {
  await withWorkspace(async (options) => {
    const workspace = await setupMemoryWorkspace({ memoryRoot: options.memoryRoot, sourceDirectory: options.sourceDirectory });
    assert.equal(workspace.memoryRoot, options.memoryRoot);
    assert.deepEqual((await readdir(options.base)).sort(), ['Memory', 'source']);
    assert.deepEqual(await loadMemoryBootstrap({ memoryRoot: options.memoryRoot }), {
      memory: { path: path.join(options.memoryRoot, 'MEMORY.md'), content: '' },
    });
    assert.deepEqual((await readdir(options.base)).sort(), ['Memory', 'source']);
  });
});

test('bootstrap reads only MEMORY.md', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Memory contents');
    await writeFile(path.join(options.memoryRoot, 'not-bootstrap.md'), 'Never loaded');
    assert.deepEqual(await loadMemoryBootstrap(options), {
      memory: { path: path.join(options.memoryRoot, 'MEMORY.md'), content: 'Memory contents' },
    });
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Memory contents');
    assert.deepEqual((await readdir(options.memoryRoot)).sort(), ['.git', 'MEMORY.md', 'not-bootstrap.md']);
  });
});

test('bootstrap rejects a symlink or directory in place of MEMORY.md', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.base, 'outside.txt'), 'Outside');
    await unlink(path.join(options.memoryRoot, 'MEMORY.md'));
    await symlink(path.join(options.base, 'outside.txt'), path.join(options.memoryRoot, 'MEMORY.md'));
    await assert.rejects(loadMemoryBootstrap(options), /ELOOP/);
    await unlink(path.join(options.memoryRoot, 'MEMORY.md'));
    await mkdir(path.join(options.memoryRoot, 'MEMORY.md'));
    await assert.rejects(loadMemoryBootstrap(options), /ordinary files/);
  });
});

test('Memory cannot overlap source, including canonical symlink aliases', async () => {
  await withWorkspace(async (options) => {
    for (const override of [
      { memoryRoot: options.sourceDirectory }, { memoryRoot: path.join(options.sourceDirectory, 'data') },
      { memoryRoot: options.base },
    ]) await assert.rejects(setupMemoryWorkspace({ ...options, ...override }), /separate and non-overlapping/);
    const alias = path.join(options.base, 'source-alias'); await symlink(options.sourceDirectory, alias);
    await assert.rejects(setupMemoryWorkspace({ ...options, memoryRoot: path.join(alias, 'memory') }), /separate and non-overlapping/);
    assert.deepEqual(await readdir(options.sourceDirectory), []);
  });
});

test('Memory cannot silently inherit an ancestor repository', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const enclosing = path.join(options.base, 'data-repo'); await mkdir(enclosing); await git(enclosing, 'init', '--quiet');
    await assert.rejects(setupMemoryWorkspace({ ...options, memoryRoot: path.join(enclosing, 'memory') }), /independent Git/);
  });
});

test('snapshot commits only changed Memory and leaves source and prose metadata untouched', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'User prefers tea.\n');
    await writeFile(path.join(options.sourceDirectory, 'source.ts'), 'Source is not data');
    const first = await snapshot(options.memoryRoot, RUN.first);
    assert.equal(first.changed, true); assert.equal(first.recovered, false);
    assert.match(first.commitId!, /^[a-f0-9]{40,64}$/); assert.deepEqual(first.changedPaths, ['MEMORY.md']);
    assert.equal(await git(options.memoryRoot, 'ls-tree', '-r', '--name-only', first.commitId!), 'MEMORY.md');
    assert.equal(await git(options.memoryRoot, 'status', '--porcelain'), '');
    const message = await git(options.memoryRoot, 'log', '-1', '--format=%B');
    assert.equal(message, `Memory snapshot\n\nHistory-Id: ${RUN.first}\nMira-Run-Key: ${refFor(RUN.first).split('/').at(-1)}`);
    assert.doesNotMatch(message, /Base64|mira-test/);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'User prefers tea.\n');
    await writeFile(path.join(options.sourceDirectory, 'source.ts'), 'Changed source alone');
    const unchanged = await snapshot(options.memoryRoot, RUN.second);
    assert.equal(unchanged.changed, false); assert.equal(unchanged.commitId, null); assert.deepEqual(unchanged.changedPaths, []);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'cat-file', '-t', refFor(RUN.second)), 'tree');
  });
});

test('snapshot includes pre-existing edits, additions, deletions and unusual path names without claiming authorship', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, 'remove.md'), 'Old file');
    await snapshot(options.memoryRoot, RUN.first);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Manual edit before wake');
    await unlink(path.join(options.memoryRoot, 'remove.md'));
    await writeFile(path.join(options.memoryRoot, '-option\nwith\ttabs.md'), 'New file');
    const result = await snapshot(options.memoryRoot, RUN.second);
    assert.deepEqual(result.changedPaths.sort(), ['-option\nwith\ttabs.md', 'MEMORY.md', 'remove.md'].sort());
    assert.equal(await git(options.memoryRoot, 'show', `${result.commitId}:MEMORY.md`), 'Manual edit before wake');
    assert.equal(await git(options.memoryRoot, 'status', '--porcelain'), '');
  });
});

test('retry after Git commit but before DB association recovers the exact run without capturing later changes', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const first = await snapshot(options.memoryRoot, RUN.first);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'A later wake edit');
    const retry = await snapshot(options.memoryRoot, RUN.first);
    assert.deepEqual(retry, { ...first, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'show', `${first.commitId}:MEMORY.md`), '');
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'A later wake edit');
    const next = await snapshot(options.memoryRoot, RUN.second);
    assert.notEqual(next.commitId, first.commitId);
  });
});

test('no-change receipt survives later changes and restart without generating an empty commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); await snapshot(options.memoryRoot, RUN.first);
    const noChange = await snapshot(options.memoryRoot, RUN.second);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'New change');
    const modulePath = new URL('../../packages/workspace/src/index.ts', import.meta.url).href;
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e', `import { snapshotMemory } from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(await snapshotMemory(${JSON.stringify({ memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: RUN.second })})));`],
      { env: { PATH: process.env['PATH'], HOME: options.base } });
    assert.deepEqual(JSON.parse(stdout), { ...noChange, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
  });
});

test('Mira/run receipts remain scoped without exposing arbitrary Mira IDs in commit trailers or ref syntax', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const runId = RUN.first;
    const miraId = `one\nHistory-Id: ${RUN.second}\n../../evil;$(touch sentinel)\0`;
    const one = await snapshot(options.memoryRoot, runId, miraId);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Another Mira');
    const two = await snapshot(options.memoryRoot, runId, 'two');
    assert.notEqual(one.commitId, two.commitId);
    assert.equal((await snapshot(options.memoryRoot, runId, miraId)).commitId, one.commitId);
    const message = await git(options.memoryRoot, 'show', '-s', '--format=%B', one.commitId!);
    assert.equal(message, `Memory snapshot\n\nHistory-Id: ${runId}\nMira-Run-Key: ${refFor(runId, miraId).split('/').at(-1)}`);
    assert.doesNotMatch(message, /Base64|sentinel/);
    assert.deepEqual((await readdir(options.memoryRoot)).sort(), ['.git', 'MEMORY.md']);
  });
});

test('snapshot requires a canonical History UUID before staging files or publishing receipts', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Unassociated edit');
    for (const runId of ['', 'wake-1', 'run\n../../evil;$(touch sentinel)\0',
      `wake:${RUN.first}`, `${RUN.first}\n`, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
      '11111111-1111-0111-8111-111111111111', '11111111-1111-9111-8111-111111111111',
      '11111111-1111-4111-7111-111111111111']) {
      await assert.rejects(snapshot(options.memoryRoot, runId), /canonical lowercase History UUID/);
    }
    assert.equal(await git(options.memoryRoot, 'diff', '--cached', '--name-only'), '');
    assert.equal(await git(options.memoryRoot, 'for-each-ref', '--format=%(refname)'), '');
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Unassociated edit');
    assert.deepEqual((await readdir(options.memoryRoot)).sort(), ['.git', 'MEMORY.md']);
  });
});

test('snapshot accepts canonical RFC UUID versions 1 through 8 without changing their identity', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    for (let version = 1; version <= 8; version++) {
      const runId = `12345678-abcd-${version}000-89ab-123456789abc`;
      const result = await snapshot(options.memoryRoot, runId);
      assert.equal(result.runId, runId);
      assert.deepEqual(await snapshot(options.memoryRoot, runId), { ...result, recovered: true });
    }
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
  });
});

test('Git ignores remain ordinary and an empty unborn tree creates no commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    await writeFile(path.join(options.memoryRoot, '.git', 'info', 'exclude'), '*\n');
    const empty = await snapshot(options.memoryRoot, RUN.first);
    assert.equal(empty.changed, false); assert.equal(empty.commitId, null);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
    assert.equal(await git(options.memoryRoot, 'cat-file', '-t', refFor(RUN.first)), 'tree');
  });
});

test('real Git index-lock errors are surfaced and a later same-run retry succeeds', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const lock = path.join(options.memoryRoot, '.git', 'index.lock'); await writeFile(lock, 'Existing lock');
    await assert.rejects(snapshot(options.memoryRoot, RUN.first), /index\.lock/);
    assert.equal(await readFile(lock, 'utf8'), 'Existing lock');
    await unlink(lock);
    assert.equal((await snapshot(options.memoryRoot, RUN.first)).changed, true);
  });
});

test('cancellation is reported before setup/snapshot, without pretending success or replaying', async () => {
  await withWorkspace(async (options) => {
    const controller = new AbortController(); controller.abort(new Error('cancelled by test'));
    await assert.rejects(setupMemoryWorkspace({ ...options, signal: controller.signal }), /cancelled by test/);
    assert.deepEqual(await readdir(options.base), ['source']);
    await setupMemoryWorkspace(options);
    await assert.rejects(snapshotMemory({ memoryRoot: options.memoryRoot, miraId: 'mira', runId: RUN.first, signal: controller.signal }), /cancelled by test/);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
  });
});

test('unregistered source repositories and linked Git directories cannot be snapshotted', async () => {
  await withWorkspace(async (options) => {
    await git(options.sourceDirectory, 'init', '--quiet');
    await assert.rejects(snapshot(options.sourceDirectory, RUN.first), /ENOENT/);
    await mkdir(options.memoryRoot); await symlink(path.join(options.sourceDirectory, '.git'), path.join(options.memoryRoot, '.git'));
    await assert.rejects(setupMemoryWorkspace(options), /own .git directory/);
    assert.deepEqual(await readdir(options.sourceDirectory), ['.git']);
  });
});

test('a failed run ref transaction creates neither a published snapshot nor an unassociated HEAD commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const baseline = await snapshot(options.memoryRoot, RUN.first);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'New value');
    const lock = path.join(options.memoryRoot, '.git', `${refFor(RUN.second)}.lock`);
    await mkdir(path.dirname(lock), { recursive: true }); await writeFile(lock, 'existing');
    await assert.rejects(snapshot(options.memoryRoot, RUN.second), /cannot lock ref/);
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), baseline.commitId);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', refFor(RUN.second)));
    await unlink(lock);
    assert.equal((await snapshot(options.memoryRoot, RUN.second)).changed, true);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '2');
  });
});


test('a HEAD commit whose run ref was lost is recovered by its exact trailers before later edits', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const first = await snapshot(options.memoryRoot, RUN.first);
    await git(options.memoryRoot, 'update-ref', '-d', refFor(RUN.first));
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later edit must not be captured');
    const result = await snapshot(options.memoryRoot, RUN.first);
    assert.deepEqual(result, { ...first, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor(RUN.first)), first.commitId);
  });
});

test('a mismatched commit behind a run receipt is rejected instead of inventing lineage', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const original = await snapshot(options.memoryRoot, RUN.first);
    await git(options.memoryRoot, 'update-ref', refFor(RUN.second), original.commitId!);
    await assert.rejects(snapshot(options.memoryRoot, RUN.second), /does not match this Mira\/run key/);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
  });
});

test('receipt and missing-ref recovery reject ambiguous, mismatched and encoded-only commit identities without changing data', async () => {
  const key = refFor(RUN.second).split('/').at(-1)!;
  const history = `History-Id: ${RUN.second}`;
  const trailer = `Mira-Run-Key: ${key}`;
  const messages = [
    `${history}\n${trailer}`,
    `Memory snapshot\n\n${trailer}`,
    `Memory snapshot\n\nHistory-Id: ${RUN.third}\n${trailer}`,
    `Memory snapshot\n\n${history}\nHistory-Id: ${RUN.third}\n${trailer}`,
    `Memory snapshot\n\n${history}\n${history}\n${trailer}`,
    `Memory snapshot\n\n${history}\nhistory-id: ${RUN.third}\n${trailer}`,
    `Memory snapshot\n\n${history}\n ${RUN.third}\n${trailer}`,
    `Memory snapshot\n\n${history}\n${trailer}\nMira-Run-Key: ${'f'.repeat(64)}`,
    `Memory snapshot\n\n${history}\n${trailer}\nmira-run-key: ${'f'.repeat(64)}`,
    `Memory snapshot\n\n${history}\n${trailer}\nUnrelated body text`,
    `Memory snapshot\n\n${history}\n${trailer}\n\nThese are body lines, not trailers`,
    `Memory snapshot\n\n${trailer}\nMira-Id-Base64: ${Buffer.from('mira-test').toString('base64')}\nMira-Run-Id-Base64: ${Buffer.from(RUN.second).toString('base64')}`,
  ];
  for (const message of messages) {
    for (const missingRef of [false, true]) {
      await withWorkspace(async (options) => {
        await setupMemoryWorkspace(options);
        const baseline = await snapshot(options.memoryRoot, RUN.first);
        const tree = await git(options.memoryRoot, 'rev-parse', `${baseline.commitId}^{tree}`);
        const forged = await git(options.memoryRoot, 'commit-tree', tree, '-p', baseline.commitId!, '-m', message);
        if (missingRef) await git(options.memoryRoot, 'update-ref', 'HEAD', forged, baseline.commitId!);
        else await git(options.memoryRoot, 'update-ref', refFor(RUN.second), forged);
        await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later edit must remain unassociated');
        await assert.rejects(snapshot(options.memoryRoot, RUN.second), /does not match this Mira\/run key and History ID/);
        assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), missingRef ? forged : baseline.commitId);
        if (missingRef) await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', refFor(RUN.second)));
        else assert.equal(await git(options.memoryRoot, 'rev-parse', refFor(RUN.second)), forged);
        assert.equal(await git(options.memoryRoot, 'diff', '--cached', '--name-only'), '');
        assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Later edit must remain unassociated');
      });
    }
  }
});

test('a direct History ID cannot substitute for the Mira identity bound into the receipt key', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const original = await snapshot(options.memoryRoot, RUN.first, 'one');
    await git(options.memoryRoot, 'update-ref', refFor(RUN.first, 'two'), original.commitId!);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later edit');
    await assert.rejects(snapshot(options.memoryRoot, RUN.first, 'two'), /does not match this Mira\/run key and History ID/);
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), original.commitId);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Later edit');
  });
});

test('concurrent same-run attempts converge after honest Git-lock/conflict errors without duplicate commits', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options);
    const attempts = await Promise.allSettled(Array.from({ length: 6 }, () => snapshot(options.memoryRoot, RUN.first)));
    const result = await snapshot(options.memoryRoot, RUN.first);
    assert.equal(result.changed, true);
    for (const attempt of attempts) {
      if (attempt.status === 'fulfilled') assert.equal(attempt.value.commitId, result.commitId);
      else assert.match(String(attempt.reason), /lock|already exists|is at .* but expected/);
    }
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor(RUN.first)), result.commitId);
  });
});

test('a receipt published before HEAD repairs only its exact parent and prevents duplicate next-run commits', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const baseline = await snapshot(options.memoryRoot, RUN.first);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Changed once');
    const changed = await snapshot(options.memoryRoot, RUN.second);
    // Simulate the opposite partial publication: receipt durable, HEAD old.
    await git(options.memoryRoot, 'update-ref', 'HEAD', baseline.commitId!, changed.commitId!);
    assert.deepEqual(await snapshot(options.memoryRoot, RUN.second), { ...changed, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), changed.commitId);
    const next = await snapshot(options.memoryRoot, RUN.third);
    assert.equal(next.changed, false); assert.equal(next.commitId, null);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '2');
  });
});

test('an initial snapshot receipt repairs an unborn HEAD without making another commit', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const first = await snapshot(options.memoryRoot, RUN.first);
    await git(options.memoryRoot, 'update-ref', '-d', 'HEAD', first.commitId!);
    assert.deepEqual(await snapshot(options.memoryRoot, RUN.first), { ...first, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), first.commitId);
    assert.equal((await snapshot(options.memoryRoot, RUN.third)).changed, false);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
  });
});

test('receipt recovery keeps legitimate descendants without rewinding HEAD', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const original = await snapshot(options.memoryRoot, RUN.first);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later change');
    const later = await snapshot(options.memoryRoot, RUN.second);
    assert.deepEqual(await snapshot(options.memoryRoot, RUN.first), { ...original, recovered: true });
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), later.commitId);
  });
});

test('receipt recovery rejects divergent HEAD evidence and preserves that branch unchanged', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); const baseline = await snapshot(options.memoryRoot, RUN.first);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Snapshot content');
    const captured = await snapshot(options.memoryRoot, RUN.second);
    await git(options.memoryRoot, 'update-ref', 'HEAD', baseline.commitId!, captured.commitId!);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Independent divergent edit');
    await git(options.memoryRoot, 'add', '-A'); await git(options.memoryRoot, 'commit', '-qm', 'Independent branch');
    const divergent = await git(options.memoryRoot, 'rev-parse', 'HEAD');
    await assert.rejects(snapshot(options.memoryRoot, RUN.second), /divergent history.*refusing to replace HEAD/);
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), divergent);
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor(RUN.second)), captured.commitId);
    assert.equal(await readFile(path.join(options.memoryRoot, 'MEMORY.md'), 'utf8'), 'Independent divergent edit');
  });
});

test('a non-root receipt cannot repair a missing parent chain by replacing an unborn HEAD', async () => {
  await withWorkspace(async (options) => {
    await setupMemoryWorkspace(options); await snapshot(options.memoryRoot, RUN.first);
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Another commit');
    const captured = await snapshot(options.memoryRoot, RUN.second);
    await git(options.memoryRoot, 'update-ref', '-d', 'HEAD', captured.commitId!);
    await assert.rejects(snapshot(options.memoryRoot, RUN.second), /divergent history/);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
    assert.equal(await git(options.memoryRoot, 'rev-parse', refFor(RUN.second)), captured.commitId);
  });
});

test('a recreated .git gets a new repository identity and pending-run retries reject it before capturing later edits', async () => {
  await withWorkspace(async (options) => {
    const original = await setupMemoryWorkspace(options);
    await snapshotMemory({ memoryRoot: original.memoryRoot, miraId: 'mira-test', runId: RUN.first, expectedRepositoryId: original.repositoryId });
    await rm(path.join(options.memoryRoot, '.git'), { recursive: true });
    await writeFile(path.join(options.memoryRoot, 'MEMORY.md'), 'Later unassociated edits');
    const replacement = await setupMemoryWorkspace(options);
    assert.notEqual(replacement.repositoryId, original.repositoryId);
    await assert.rejects(snapshotMemory({ memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: RUN.first, expectedRepositoryId: original.repositoryId }), /repository identity changed/);
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', 'HEAD'));
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', refFor(RUN.first)));
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
    await assert.rejects(snapshotMemory({ memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: RUN.first, expectedRepositoryId: original.repositoryId }), /repository identity changed/);
    assert.equal(await git(options.memoryRoot, 'rev-parse', 'HEAD'), replacementHead);
    assert.equal(await git(options.memoryRoot, 'rev-list', '--count', 'HEAD'), '1');
    await assert.rejects(git(options.memoryRoot, 'rev-parse', '--verify', refFor(RUN.first)));
  });
});

test('repository identity is stable and expected identity accepts a normal same-repository retry', async () => {
  await withWorkspace(async (options) => {
    const original = await setupMemoryWorkspace(options);
    const request = { memoryRoot: options.memoryRoot, miraId: 'mira-test', runId: RUN.first, expectedRepositoryId: original.repositoryId };
    const first = await snapshotMemory(request);
    assert.equal((await setupMemoryWorkspace(options)).repositoryId, original.repositoryId);
    assert.deepEqual(await snapshotMemory(request), { ...first, recovered: true });
    assert.equal((await loadMemoryBootstrap({ memoryRoot: options.memoryRoot })).memory.content, '');
  });
});
