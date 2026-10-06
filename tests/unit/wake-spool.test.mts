import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { writeWakeInput } from '@mira/workspace';
import { prepareWakeTurn, renderWakeBatch, type WakeRun } from '@mira/life';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
async function withRoot(run: (root: string, base: string) => Promise<void>): Promise<void> {
  // The suite runner sets TMPDIR inside its synthetic HOME; this adapter
  // deliberately rejects any user-home path, including that synthetic one.
  const base = await mkdtemp('/tmp/mira-wake-input-test-');
  try { await run(path.join(base, 'spool'), base); }
  finally { await rm(base, { recursive: true, force: true }); }
}
const materialize = (rootDirectory: string, runId: string, content: string) => writeWakeInput({ rootDirectory, sourceDirectory, runId, content });
const runDirectory = (root: string, runId: string) => path.join(root, createHash('sha256').update(runId).digest('hex'));

test('full overflow batch is an exact ordinary UTF-8 file without filtering or truncation', async () => {
  await withRoot(async (root) => {
    const batch = Array.from({ length: 4000 }, (_, index) => ({
      wake: { id: `wake-${index}`, reason: `Complete reason ${index}` },
      event: { id: `event-${index}`, source: ['user', 'external', 'system'][index % 3], payload: `完整内容 ${index} 🧠\n\"quoted\"` },
    }));
    const content = JSON.stringify(batch);
    const artifact = await materialize(root, 'run-1', content);
    assert.equal(artifact.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal(await readFile(artifact.path, 'utf8'), content);
    assert.deepEqual(JSON.parse(await readFile(artifact.path, 'utf8')), batch);
    assert.equal((await lstat(artifact.path)).mode & 0o777, 0o400);
    assert.equal((await lstat(root)).mode & 0o777, 0o700);
    assert.equal((await lstat(path.dirname(artifact.path))).mode & 0o777, 0o700);
    assert.deepEqual(await readdir(root), [path.basename(path.dirname(artifact.path))]);
  });
});

test('repeated canonical input reuses the immutable file and survives a fresh call', async () => {
  await withRoot(async (root) => {
    const first = await materialize(root, 'stable-run', '{"all":"wakes"}');
    const before = await lstat(first.path, { bigint: true });
    const second = await writeWakeInput({ rootDirectory: root, sourceDirectory, runId: 'stable-run', content: '{"all":"wakes"}' });
    const after = await lstat(second.path, { bigint: true });
    assert.deepEqual(second, first);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.equal(after.ctimeNs, before.ctimeNs);
  });
});

test('deleted disposable input and a lost root reconstruct from canonical content at the same path', async () => {
  await withRoot(async (root) => {
    const content = '{"canonical":[1,2,3]}';
    const original = await materialize(root, 'recover-run', content);
    await unlink(original.path);
    assert.deepEqual(await materialize(root, 'recover-run', content), original);
    assert.equal(await readFile(original.path, 'utf8'), content);
    await rm(root, { recursive: true });
    assert.deepEqual(await materialize(root, 'recover-run', content), original);
    assert.equal(await readFile(original.path, 'utf8'), content);
  });
});

test('a fresh process reconstructs the same ordinary file from canonical run state', async () => {
  await withRoot(async (root) => {
    const options = { rootDirectory: root, sourceDirectory, runId: 'restart-run', content: '{"full":"恢复 🧠"}' };
    const artifact = await writeWakeInput(options);
    await rm(root, { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { writeWakeInput } from '@mira/workspace'; process.stdout.write(JSON.stringify(await writeWakeInput(${JSON.stringify(options)})));`,
    ], { cwd: sourceDirectory });
    assert.deepEqual(JSON.parse(stdout), artifact);
    assert.equal(await readFile(artifact.path, 'utf8'), options.content);
  });
});

test('current concise overflow recreates byte-identical input and notice after process restart', async () => {
  await withRoot(async root => {
    const batch: WakeRun = { id: 'concise-restart', claimedAt: '2026-10-06T08:01:00.000Z', status: 'running', inputRecordId: 'persisted-input', finalRecordId: null, requests: [
      { event: { id: 'user-event', source: 'user', type: 'web.message', occurredAt: '2026-10-06T08:00:00.000Z', payload: { text: '  完整原文 🧠\nDo not trim  ' } }, wake: { id: 'user-wake', reason: 'User message from the local web interface' } },
      { event: { id: 'external-event', source: 'external', type: 'custom.event', occurredAt: '2026-10-06T08:00:01.000Z', payload: { text: 'Third-party source material', attachments: [{ path: 'reported.txt' }], details: [null, false, 0] } }, wake: { id: 'external-wake', reason: 'External update' } },
    ] };
    const content = renderWakeBatch(batch);
    const artifact = await materialize(root, batch.id, content);
    const first = await prepareWakeTurn(batch, (id, text) => materialize(root, id, text), 1);
    assert.equal(await readFile(artifact.path, 'utf8'), content);
    assert.ok(content.includes('  完整原文 🧠\nDo not trim  ')); assert.ok(content.includes('"attachments"'));
    assert.doesNotMatch(content, /"requests"|"wake"|"payload"|"claimedAt"/);
    await rm(root, { recursive: true });
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e',
      `import { prepareWakeTurn } from '@mira/life'; import { writeWakeInput } from '@mira/workspace';
       const turn = await prepareWakeTurn(${JSON.stringify(batch)}, (runId, content) => writeWakeInput({rootDirectory:${JSON.stringify(root)},sourceDirectory:${JSON.stringify(sourceDirectory)},runId,content}), 1);
       process.stdout.write(JSON.stringify(turn));`,
    ], { cwd: sourceDirectory });
    assert.deepEqual(JSON.parse(stdout), first);
    assert.equal(await readFile(artifact.path, 'utf8'), content);
  });
});

test('different canonical content for an existing run fails without modifying unread data', async () => {
  await withRoot(async (root) => {
    const first = await materialize(root, 'immutable-run', 'original');
    const before = await lstat(first.path, { bigint: true });
    for (const content of ['changed!', 'different length']) {
      await assert.rejects(materialize(root, 'immutable-run', content), /content conflict.*preserved/);
    }
    assert.equal(await readFile(first.path, 'utf8'), 'original');
    const after = await lstat(first.path, { bigint: true });
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeNs, before.mtimeNs);
  });
});

test('concurrent identical writers publish one stable complete file', async () => {
  await withRoot(async (root) => {
    const content = JSON.stringify({ all: '🙂汉字'.repeat(50_000) });
    const artifacts = await Promise.all(Array.from({ length: 8 }, () => materialize(root, 'shared-run', content)));
    assert.equal(new Set(artifacts.map((artifact) => artifact.path)).size, 1);
    assert.equal(await readFile(artifacts[0]!.path, 'utf8'), content);
  });
});

test('concurrent conflicting writers never overwrite the winning complete artifact', async () => {
  await withRoot(async (root) => {
    const contents = ['a'.repeat(80_000), 'b'.repeat(80_000)];
    const results = await Promise.allSettled(contents.map((content) => materialize(root, 'conflicted-run', content)));
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    assert.equal(await readFile(path.join(runDirectory(root, 'conflicted-run'), 'batch.txt'), 'utf8'), contents[winner]);
    const loser = results.find((result) => result.status === 'rejected');
    assert.ok(loser && loser.status === 'rejected');
    assert.match(String(loser.reason), /content conflict.*preserved/);
  });
});

test('run identifiers cannot escape the explicitly configured root', async () => {
  await withRoot(async (root) => {
    for (const runId of ['../../outside', '/absolute/path', 'run\\..\\outside', 'run\0input']) {
      const artifact = await materialize(root, runId, 'full input');
      assert.equal(path.dirname(path.dirname(artifact.path)), root);
      assert.match(path.basename(path.dirname(artifact.path)), /^[a-f0-9]{64}$/);
      assert.equal(await readFile(artifact.path, 'utf8'), 'full input');
    }
  });
});

test('unsafe source, user-home, relative, traversal and shared roots are rejected', async () => {
  await withRoot(async (root) => {
    for (const rootDirectory of [sourceDirectory, path.join(sourceDirectory, 'data'), homedir(), path.join(homedir(), 'wake-inputs'), '/', 'relative', `${root}/../escaped`]) {
      await assert.rejects(materialize(rootDirectory, 'run', 'content'), /outside|absolute paths/);
    }
    await mkdir(root, { mode: 0o755 });
    await assert.rejects(materialize(root, 'run', 'content'), /inaccessible to other users/);
  });
});

test('root and ancestor symlinks fail without writing into their targets', async () => {
  await withRoot(async (root, base) => {
    const target = path.join(base, 'target');
    await mkdir(target, { mode: 0o700 });
    await symlink(target, root);
    await assert.rejects(materialize(root, 'run', 'content'), /symlinks/);
    await assert.rejects(materialize(path.join(root, 'child'), 'run', 'content'), /symlinks/);
    assert.deepEqual(await readdir(target), []);
  });
});

test('a writable non-sticky ancestor is rejected before creating an artifact', async () => {
  await withRoot(async (root, base) => {
    await chmod(base, 0o777);
    await assert.rejects(materialize(root, 'unsafe-ancestor', 'content'), /ancestor is writable/);
    assert.deepEqual(await readdir(base), []);
  });
});

test('artifact directory and file symlinks are rejected without reading or changing targets', async () => {
  await withRoot(async (root, base) => {
    const outsideDirectory = path.join(base, 'outside');
    await mkdir(outsideDirectory, { mode: 0o700 });
    const outside = path.join(outsideDirectory, 'batch.txt');
    await writeFile(outside, 'private original', { mode: 0o600 });
    await mkdir(root, { mode: 0o700 });
    await symlink(outsideDirectory, runDirectory(root, 'directory-link'));
    await assert.rejects(materialize(root, 'directory-link', 'private original'), /symlinks/);
    const directory = runDirectory(root, 'file-link');
    await mkdir(directory, { mode: 0o700 });
    await symlink(outside, path.join(directory, 'batch.txt'));
    await assert.rejects(materialize(root, 'file-link', 'private original'), /symlinks/);
    assert.equal(await readFile(outside, 'utf8'), 'private original');
  });
});

test('hard links and unexpected existing directory contents fail closed', async () => {
  await withRoot(async (root, base) => {
    await mkdir(root, { mode: 0o700 });
    const directory = runDirectory(root, 'hard-link');
    await mkdir(directory, { mode: 0o700 });
    const outside = path.join(base, 'outside');
    await writeFile(outside, 'same', { mode: 0o600 });
    await link(outside, path.join(directory, 'batch.txt'));
    await assert.rejects(materialize(root, 'hard-link', 'same'), /hard links/);
    const unexpected = runDirectory(root, 'unexpected');
    await mkdir(unexpected, { mode: 0o700 });
    await writeFile(path.join(unexpected, 'unread.txt'), 'retain');
    await assert.rejects(materialize(root, 'unexpected', 'content'), /unexpected files/);
    assert.equal(await readFile(outside, 'utf8'), 'same');
    assert.equal(await readFile(path.join(unexpected, 'unread.txt'), 'utf8'), 'retain');
  });
});

test('old unread files and interrupted temporary files are never automatically cleaned up', async () => {
  await withRoot(async (root) => {
    const first = await materialize(root, 'unread-run', 'older complete input');
    const pending = path.join(root, '.pending-interrupted');
    await mkdir(pending, { mode: 0o700 });
    await writeFile(path.join(pending, 'batch.tmp'), 'incomplete input', { mode: 0o600 });
    const second = await materialize(root, 'new-run', 'new complete input');
    assert.equal(await readFile(first.path, 'utf8'), 'older complete input');
    assert.equal(await readFile(path.join(pending, 'batch.tmp'), 'utf8'), 'incomplete input');
    assert.equal(await readFile(second.path, 'utf8'), 'new complete input');
    assert.ok((await readdir(root)).includes('.pending-interrupted'));
  });
});

test('empty and BOM text are exact; invalid Unicode is rejected before file creation', async () => {
  await withRoot(async (root) => {
    for (const content of ['', '\ufefftext\n']) {
      const artifact = await materialize(root, `run-${content.length}`, content);
      assert.equal(await readFile(artifact.path, 'utf8'), content);
      assert.equal(artifact.bytes, Buffer.byteLength(content));
    }
    await assert.rejects(materialize(root, 'bad-unicode', '\ud800'), /well-formed Unicode/);
    await assert.rejects(materialize(root, '', 'content'), /stable run ID/);
    await assert.rejects(materialize(root, 'x'.repeat(4097), 'content'), /stable run ID/);
  });
});

test('a tampered readonly artifact is preserved as a conflict instead of silently repaired', async () => {
  await withRoot(async (root) => {
    const artifact = await materialize(root, 'tampered-run', 'canonical content');
    await chmod(artifact.path, 0o600);
    await writeFile(artifact.path, 'different content');
    await chmod(artifact.path, 0o400);
    await assert.rejects(materialize(root, 'tampered-run', 'canonical content'), /content conflict/);
    assert.equal(await readFile(artifact.path, 'utf8'), 'different content');
  });
});
