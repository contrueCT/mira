import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { FeishuPrivateStore, FeishuStoreError } from '../../packages/feishu-channel/src/store.ts';

async function fixture(t: test.TestContext) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-feishu-store-')));
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
  assert.equal((await stat(`${file}.sqlite`)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  await assert.rejects(stale.save({ value: 'overwrite' }), FeishuStoreError);
  assert.deepEqual(await stale.load(), { value: 'first' });
  await stale.save({ value: 'second' });
  await assert.rejects(store.save({ value: 'stale' }), FeishuStoreError);
  assert.deepEqual(await new FeishuPrivateStore(file, source).load(), { value: 'second' });
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

const waitFile = async (file: string) => {
  for (let i = 0; i < 1000; i++) { try { return await readFile(file, 'utf8'); } catch { await new Promise(resolve => setTimeout(resolve, 5)); } }
  assert.fail(`missing synthetic writer marker ${path.basename(file)}`);
};
async function writer(t: test.TestContext, root: string, source: string, file: string, name: string, mode = 'write') {
  const script = path.join(root, `${name}.mjs`);
  await writeFile(script, `
    import fs from 'node:fs'; import { DatabaseSync } from 'node:sqlite';
    import { FeishuPrivateStore } from ${JSON.stringify(pathToFileURL(path.resolve('packages/feishu-channel/src/store.ts')).href)};
    const [file,source,root,name,mode] = process.argv.slice(2);
    const wait = marker => { while(!fs.existsSync(root+'/'+marker)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5); };
    const original = DatabaseSync.prototype.exec; let saving = false;
    DatabaseSync.prototype.exec = function(sql) {
      if(saving && sql==='COMMIT' && mode==='crash-before') process.kill(process.pid,'SIGKILL');
      const result = original.call(this,sql);
      if(saving && sql==='COMMIT' && mode==='crash-after') process.kill(process.pid,'SIGKILL');
      if(saving && sql.includes('BEGIN IMMEDIATE') && mode==='hold') { fs.writeFileSync(root+'/'+name+'-held',''); wait('release'); }
      return result;
    };
    const store = new FeishuPrivateStore(file,source); await store.load();
    fs.writeFileSync(root+'/'+name+'-ready',''); wait(name+'-go'); saving=true;
    let result='saved'; try { await store.save({value:name}); } catch(error) { result=error.code ?? 'error'; }
    fs.writeFileSync(root+'/'+name+'-result',result);
  `);
  const child = spawn(process.execPath, [script, file, source, root, name, mode], { stdio: 'pipe', env: { PATH: process.env.PATH } });
  t.after(() => child.kill());
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
  await waitFile(path.join(root, `${name}-ready`));
  return { exit, go: () => writeFile(path.join(root, `${name}-go`), '') };
}
for (const migrated of [false, true]) test(`two processes CAS the same ${migrated ? 'SQLite' : 'legacy migration'} revision without loss`, { timeout: 15_000 }, async t => {
  const { root, file, source, store } = await fixture(t);
  await mkdir(path.dirname(file), { mode: 0o700 }); const legacy = '{\n "value": "legacy"\n}'; await writeFile(file, legacy, { mode: 0o600 });
  if (migrated) { await store.load(); await store.save({ value: 'initial sqlite' }); }
  const a = await writer(t, root, source, file, 'a'); const b = await writer(t, root, source, file, 'b');
  await Promise.all([a.go(), b.go()]);
  const results = await Promise.all(['a', 'b'].map(name => waitFile(path.join(root, `${name}-result`))));
  assert.equal(results.filter(value => value === 'saved').length, 1);
  assert.ok(results.every(value => ['saved', 'conflict', 'busy'].includes(value)));
  assert.deepEqual(await Promise.all([a.exit, b.exit]), [{ code: 0, signal: null }, { code: 0, signal: null }]);
  assert.deepEqual(await new FeishuPrivateStore(file, source).load(), { value: results[0] === 'saved' ? 'a' : 'b' });
  assert.equal(await readFile(file, 'utf8'), legacy);
});
for (const phase of ['before', 'after']) test(`process death ${phase} SQLite COMMIT recovers without an orphan lock`, { timeout: 15_000 }, async t => {
  const { root, file, source } = await fixture(t); await mkdir(path.dirname(file), { mode: 0o700 });
  const legacy = '{"value":"legacy"}'; await writeFile(file, legacy, { mode: 0o600 });
  const child = await writer(t, root, source, file, 'crashed', `crash-${phase}`); await child.go();
  assert.deepEqual(await child.exit, { code: null, signal: 'SIGKILL' });
  const reopened = new FeishuPrivateStore(file, source);
  assert.deepEqual(await reopened.load(), { value: phase === 'before' ? 'legacy' : 'crashed' });
  await reopened.save({ value: 'recovered' }); assert.deepEqual(await reopened.load(), { value: 'recovered' });
  assert.equal(await readFile(file, 'utf8'), legacy);
});
test('SQLite busy timeout is bounded and diagnosed without overwriting or automatically retrying', { timeout: 15_000 }, async t => {
  const { root, file, source, store } = await fixture(t); await store.load(); await store.save({ value: 'initial' });
  const holding = await writer(t, root, source, file, 'holding', 'hold'); await holding.go(); await waitFile(path.join(root, 'holding-held'));
  try { await assert.rejects(store.save({ value: 'blocked' }), error => error instanceof FeishuStoreError && error.code === 'busy'); }
  finally { await writeFile(path.join(root, 'release'), ''); await holding.exit; }
  assert.deepEqual(await new FeishuPrivateStore(file, source).load(), { value: 'holding' });
});
test('migration preserves exact JSON and detects later old-version writes without pretending to isolate them', async t => {
  const { file, source, store } = await fixture(t); await mkdir(path.dirname(file), { mode: 0o700 });
  const original = '{\n "value": "legacy"\n}'; await writeFile(file, original, { mode: 0o600 });
  assert.deepEqual(await store.load(), { value: 'legacy' }); await store.save({ value: 'migrated' });
  assert.equal(await readFile(file, 'utf8'), original);
  const database = await readFile(`${file}.sqlite`); await writeFile(file, '{"value":"old writer update"}');
  await assert.rejects(store.save({ value: 'must not overwrite' }), error => error instanceof FeishuStoreError && error.code === 'conflict');
  await assert.rejects(new FeishuPrivateStore(file, source).load(), FeishuStoreError);
  assert.deepEqual(await readFile(`${file}.sqlite`), database);
});
test('unknown SQLite schema and unsafe database or journal paths fail without replacing evidence', async t => {
  const { root, file, source, store } = await fixture(t); await mkdir(path.dirname(file), { mode: 0o700 });
  const database = `${file}.sqlite`; const db = new DatabaseSync(database); db.exec('PRAGMA user_version=99; CREATE TABLE alien(value TEXT)'); db.close(); await chmod(database, 0o600);
  const bytes = await readFile(database); await assert.rejects(store.load(), FeishuStoreError); assert.deepEqual(await readFile(database), bytes);
  await rm(database); const target = path.join(root, 'target'); await writeFile(target, '', { mode: 0o600 }); await symlink(target, database);
  await assert.rejects(store.load(), FeishuStoreError); await rm(database);
  await store.load(); await store.save({ value: 'safe' });
  await symlink(target, `${database}-journal`); await assert.rejects(new FeishuPrivateStore(file, source).load(), FeishuStoreError);
  assert.equal(await readFile(target, 'utf8'), '');
});


test('bounded large SQLite JSON updates stay readable and private', async t => {
  const { file, source, store } = await fixture(t); await store.load();
  const value = 'x'.repeat(1_990_000); await store.save({ value });
  assert.deepEqual(await new FeishuPrivateStore(file, source).load(), { value });
  await store.save({ value: 'small again' });
  assert.deepEqual(await new FeishuPrivateStore(file, source).load(), { value: 'small again' });
  await link(`${file}.sqlite`, `${file}.linked`); await assert.rejects(store.load(), FeishuStoreError); await rm(`${file}.linked`);
  await chmod(`${file}.sqlite`, 0o644); await assert.rejects(store.load(), FeishuStoreError);
});

test('receipt updates share the global CAS, remain bounded per call and continue after the database exceeds the old file cap', async t => {
  const { file, source, store } = await fixture(t); await store.load(); await store.save({ value: 'owner and inbox' });
  const stale = new FeishuPrivateStore(file, source); await stale.load();
  await store.saveReceipt('call-000', { text: 'x'.repeat(90_000) }, true, 'binding-a');
  await assert.rejects(stale.save({ value: 'stale owner' }), error => error instanceof FeishuStoreError && error.code === 'conflict');
  await assert.rejects(stale.saveReceipt('stale-call', {}, false, 'binding-a'), FeishuStoreError);
  for (let index = 1; index < 100; index++) await store.saveReceipt(`call-${String(index).padStart(3, '0')}`, { text: 'x'.repeat(90_000) }, true, index === 1 ? 'binding-b' : 'binding-a');
  assert.ok((await stat(`${file}.sqlite`)).size > 8_000_000);
  assert.equal((await store.nextPendingReceipt<{ text: string }>('binding-b'))!.callId, 'call-001');
  assert.equal((await store.nextPendingReceipt('binding-a', 'call-000'))!.callId, 'call-002');
  await assert.rejects(store.saveReceipt('oversize', { text: 'x'.repeat(2_000_001) }, true, 'binding-a'), FeishuStoreError);
  assert.equal(await store.loadReceipt('oversize'), null);
  await store.save({ value: 'new inbox remains writable' });
  const reopened = new FeishuPrivateStore(file, source); assert.deepEqual(await reopened.load(), { value: 'new inbox remains writable' });
  assert.equal((await reopened.loadReceipt<{ text: string }>('call-099'))!.text.length, 90_000);
});

test('the current single-row schema upgrades atomically with archived receipts and rolls back failed migration', async t => {
  const { file, source, store } = await fixture(t); await mkdir(path.dirname(file), { mode: 0o700 });
  const legacy = '{"value":"current single row"}'; await writeFile(file, legacy, { mode: 0o600 });
  const revision = createHash('sha256').update(legacy).digest('hex');
  const schema = 'CREATE TABLE ledger (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT, revision TEXT NOT NULL, legacy_revision TEXT NOT NULL) STRICT';
  let db = new DatabaseSync(`${file}.sqlite`); db.exec(`${schema}; PRAGMA application_id=1296454472; PRAGMA user_version=1`);
  db.prepare('INSERT INTO ledger VALUES(1,?,?,?)').run(legacy, revision, revision); db.close(); await chmod(`${file}.sqlite`, 0o600);
  assert.deepEqual(await store.load(), { value: 'current single row' });
  await assert.rejects(store.save({ value: 'must roll back' }, { bad: { value: { text: 'x'.repeat(2_000_001) }, pending: true, bindingId: 'binding' } }), FeishuStoreError);
  db = new DatabaseSync(`${file}.sqlite`);
  try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 1); assert.equal(db.prepare('SELECT value FROM ledger').get()!.value, legacy); } finally { db.close(); }
  await store.save({ value: 'split current row' }, { saved: { value: { status: 'unknown', uuid: 'permanent-identity' }, pending: false, bindingId: 'binding' } });
  assert.deepEqual(await store.loadReceipt('saved'), { status: 'unknown', uuid: 'permanent-identity' }); assert.equal(await readFile(file, 'utf8'), legacy);
  const current = new FeishuPrivateStore(file, source); assert.deepEqual(await current.load(), { value: 'split current row' });
  db = new DatabaseSync(`${file}.sqlite`); try { assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 2); } finally { db.close(); }
});
