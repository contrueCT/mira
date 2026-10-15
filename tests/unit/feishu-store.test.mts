import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FeishuPrivateStore, FeishuStoreError } from '../../packages/feishu-channel/src/store.ts';

async function fixture(t: test.TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-store-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); await mkdir(source);
  const file = path.join(root, 'private', 'state.json');
  return { root, source, file, store: new FeishuPrivateStore<{ value: string }>(file, source) };
}
test('Feishu private store creates private files, persists and fences stale writers', async t => {
  const { store, file, source } = await fixture(t);
  await assert.rejects(store.save({ value: 'before load' }), FeishuStoreError);
  assert.equal(await store.load(), null);
  const stale = new FeishuPrivateStore(file, source); assert.equal(await stale.load(), null);
  await store.save({ value: 'first' });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  await assert.rejects(stale.save({ value: 'overwrite' }), FeishuStoreError);
  assert.deepEqual(await stale.load(), { value: 'first' });
  await stale.save({ value: 'second' });
  await assert.rejects(store.save({ value: 'stale' }), FeishuStoreError);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { value: 'second' });
});
test('Feishu private store rejects source, excluded and relative paths', async t => {
  const { root, source } = await fixture(t);
  assert.throws(() => new FeishuPrivateStore(path.join(source, 'state'), source), FeishuStoreError);
  assert.throws(() => new FeishuPrivateStore(path.join(root, 'memory', 'state'), source, [path.join(root, 'memory')]), FeishuStoreError);
  assert.throws(() => new FeishuPrivateStore('relative', source), FeishuStoreError);
});
test('Feishu private store rejects symlink ancestors and symlink files', async t => {
  const { root, file, source, store } = await fixture(t);
  await mkdir(path.dirname(file), { mode: 0o700 });
  const target = path.join(root, 'target'); await writeFile(target, '{}', { mode: 0o600 });
  await symlink(target, file); await assert.rejects(store.load(), FeishuStoreError);
  const alias = path.join(root, 'alias'); await symlink(path.dirname(file), alias);
  await assert.rejects(new FeishuPrivateStore(path.join(alias, 'other'), source).load(), FeishuStoreError);
  const sourceAlias = path.join(root, 'source-alias'); await symlink(source, sourceAlias);
  await assert.rejects(new FeishuPrivateStore(path.join(sourceAlias, 'state'), source).load(), FeishuStoreError);
});
test('Feishu private store rejects hard links, public modes, malformed and oversized bytes without replacement', async t => {
  const { file, root, store } = await fixture(t);
  await mkdir(path.dirname(file), { mode: 0o700 });
  await writeFile(file, '{}', { mode: 0o600 }); await link(file, path.join(root, 'hardlink'));
  await assert.rejects(store.load(), FeishuStoreError); await rm(path.join(root, 'hardlink'));
  await chmod(file, 0o644); await assert.rejects(store.load(), FeishuStoreError);
  await chmod(file, 0o600); await chmod(path.dirname(file), 0o755); await assert.rejects(store.load(), FeishuStoreError);
  await chmod(path.dirname(file), 0o700);
  for (const content of ['not json', Buffer.from([0xff]), 'x'.repeat(2_000_001)]) {
    await writeFile(file, content); await assert.rejects(store.load(), FeishuStoreError);
    assert.deepEqual(await readFile(file), Buffer.from(content));
  }
});
test('Feishu private store detects external edits and oversized saves', async t => {
  const { store, file } = await fixture(t); await store.load(); await store.save({ value: 'kept' });
  await assert.rejects(store.save({ value: 'x'.repeat(2_000_001) }), FeishuStoreError);
  await writeFile(file, '{"value":"external"}');
  await assert.rejects(store.save({ value: 'lost' }), FeishuStoreError);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { value: 'external' });
});
