import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSettingsStore, WebSettingsError, parseWebSettings, webSettingsMaxBytes } from '@mira/server';

const configuration = () => ({ builtinCredentials: {}, customConnections: [{ id: 'local', baseUrl: 'http://127.0.0.1:9080/v1', api: 'openai-completions', apiKeyEnv: 'SYNTHETIC_KEY_REFERENCE', models: [{ id: 'test-model', contextWindow: 4096, maxTokens: 512, reasoning: false, input: ['text'] }] }] });
const selection = { kind: 'custom', connection: 'local', model: 'test-model' } as const;
async function fixture(run: (store: WebSettingsStore, directory: string, source: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-web-settings-'));
  const source = path.join(directory, 'source'); await mkdir(source);
  try { await run(new WebSettingsStore(path.join(directory, 'data', 'settings.json'), source), directory, source); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const code = (expected: WebSettingsError['code']) => (error: unknown): boolean => error instanceof WebSettingsError && error.code === expected;

test('settings start empty without creating files, persist references and selection, and restart with the same revision', async () => fixture(async (store, directory, source) => {
  const initial = await store.get();
  assert.match(initial.revision, /^[a-f0-9]{64}$/u); assert.equal(initial.selection, null);
  assert.deepEqual(initial.configuration, { builtinCredentials: {}, customConnections: [] });
  assert.deepEqual(await readdir(directory), ['source']);
  const saved = await store.save({ ...initial, configuration: configuration(), selection });
  assert.notEqual(saved.revision, initial.revision);
  const restarted = await new WebSettingsStore(store.file, source).get();
  assert.deepEqual(restarted, saved);
  const raw = await readFile(store.file, 'utf8');
  assert.ok(raw.includes('SYNTHETIC_KEY_REFERENCE')); assert.ok(!raw.includes('"apiKey"')); assert.ok(!raw.includes('revision'));
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(store.file))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(path.dirname(store.file)), ['settings.json']);
}));

test('settings reject stale revisions and preserve externally edited bytes', async () => fixture(async store => {
  const initial = await store.get(); const saved = await store.save({ ...initial, configuration: configuration(), selection });
  await assert.rejects(store.save(initial), code('settings_conflict'));
  const external = `${await readFile(store.file, 'utf8')} \n`;
  await writeFile(store.file, external);
  await assert.rejects(store.save(saved), code('settings_conflict'));
  assert.equal(await readFile(store.file, 'utf8'), external);
  const refreshed = await store.get(); assert.notEqual(refreshed.revision, saved.revision);
  const updated = await store.save({ ...refreshed, selection: null }); assert.equal(updated.selection, null);
}));

test('same-path concurrent stores serialize CAS so exactly one changed write wins', async () => fixture(async (store, _directory, source) => {
  const initial = await store.get();
  const other = new WebSettingsStore(store.file, source);
  const result = await Promise.allSettled([store.save({ ...initial, configuration: configuration(), selection }), other.save({ ...initial, configuration: configuration(), selection: null })]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = result.find(item => item.status === 'rejected');
  assert.ok(rejected?.status === 'rejected' && code('settings_conflict')(rejected.reason));
  assert.equal((await readdir(path.dirname(store.file))).filter(name => name.endsWith('.tmp')).length, 0);
}));

test('invalid fields, raw API keys, invalid references, unsupported selections and unknown providers never replace settings', async () => fixture(async store => {
  const initial = await store.get();
  const connection = configuration().customConnections[0]!;
  for (const candidate of [
    { ...initial, apiKey: 'synthetic-secret-should-not-be-saved' },
    { ...initial, revision: 'wrong' },
    { ...initial, configuration: { ...configuration(), token: 'synthetic-secret-should-not-be-saved' } },
    { ...initial, configuration: { customConnections: [{ ...connection, apiKey: 'synthetic-secret-should-not-be-saved' }] } },
    { ...initial, configuration: { customConnections: [{ ...connection, apiKeyEnv: 'not a variable' }] } },
    { ...initial, configuration: { customConnections: [{ ...connection, baseUrl: 'https://user:synthetic-secret-should-not-be-saved@example.test' }] } },
    { ...initial, configuration: { builtinCredentials: { missing: { apiKeyEnv: 'KEY_REFERENCE' } } } },
    { ...initial, configuration: { builtinCredentials: { openai: { apiKey: 'synthetic-secret-should-not-be-saved' } } } },
    { ...initial, configuration: configuration(), selection: { ...selection, apiKey: 'synthetic-secret-should-not-be-saved' } },
    { ...initial, configuration: configuration(), selection: { ...selection, model: 'missing' } },
    { ...initial, configuration: configuration(), selection: { ...selection, kind: 'unknown' } },
    { ...initial, selection: { kind: 'builtin', provider: 'openai', model: 'gpt-4.1' } },
    { ...initial, configuration: { builtinCredentials: { 'openai-codex': { apiKeyEnv: 'KEY_REFERENCE' } } }, selection: { kind: 'builtin', provider: 'openai-codex', model: 'gpt-5.3-codex' } },
  ]) {
    await assert.rejects(store.save(candidate), error => {
      assert.ok(error instanceof WebSettingsError); assert.equal(error.code, 'invalid_settings');
      assert.ok(!error.message.includes('synthetic-secret')); return true;
    });
  }
  assert.deepEqual(await store.get(), initial);
}));

test('settings reject symlink targets, hard links, directory targets and symlink ancestors without clobbering data', async () => fixture(async (store, directory, source) => {
  const initial = await store.get(); await mkdir(path.dirname(store.file));
  const target = path.join(directory, 'valuable.json'); const bytes = 'synthetic original data'; await writeFile(target, bytes);
  await symlink(target, store.file);
  await assert.rejects(store.get(), code('settings_unavailable')); await assert.rejects(store.save(initial), code('settings_unavailable'));
  assert.equal(await readFile(target, 'utf8'), bytes);
  await rm(store.file); await link(target, store.file);
  await assert.rejects(store.save(initial), code('settings_unavailable'));
  assert.equal(await readFile(target, 'utf8'), bytes);
  await rm(store.file); await mkdir(store.file); await assert.rejects(store.get(), code('settings_unavailable'));
  await symlink(path.dirname(store.file), path.join(directory, 'alias'));
  const aliased = new WebSettingsStore(path.join(directory, 'alias', 'other.json'), source);
  await assert.rejects(aliased.get(), code('settings_unavailable')); await assert.rejects(aliased.save(initial), code('settings_unavailable'));
}));

test('source checkout paths and aliases are forbidden', async () => fixture(async (_store, directory, source) => {
  assert.throws(() => new WebSettingsStore(path.join(source, 'settings.json'), source), code('settings_unavailable'));
  assert.throws(() => new WebSettingsStore('relative.json', source), code('settings_unavailable'));
  await symlink(source, path.join(directory, 'linked-source'));
  const linked = new WebSettingsStore(path.join(directory, 'linked-source', 'settings.json'), source);
  await assert.rejects(linked.get(), code('settings_unavailable'));
  assert.deepEqual(await readdir(source), []);
}));

test('malformed and oversized saved files fail closed with sanitized errors', async () => fixture(async store => {
  await mkdir(path.dirname(store.file));
  for (const bytes of ['{"apiKey":"synthetic-secret-do-not-echo"', JSON.stringify({ configuration: { apiKey: 'synthetic-secret-do-not-echo' }, selection: null }), 'x'.repeat(webSettingsMaxBytes + 1), Buffer.from([0xff, 0xfe])]) {
    await writeFile(store.file, bytes);
    await assert.rejects(store.get(), error => { assert.ok(code('settings_unavailable')(error)); assert.ok(!(error as Error).message.includes('synthetic-secret')); return true; });
    assert.deepEqual(await readFile(store.file), Buffer.from(bytes));
  }
}));

test('returned settings are detached and all allowlisted fields remain round-trippable', async () => fixture(async store => {
  const initial = await store.get(); const saved = await store.save({ ...initial, configuration: configuration(), selection });
  saved.configuration.customConnections[0]!.models[0]!.id = 'mutated';
  const actual = await store.get(); assert.equal(actual.configuration.customConnections[0]!.models[0]!.id, 'test-model');
  assert.deepEqual(parseWebSettings(actual), actual);
  assert.throws(() => parseWebSettings({ ...actual, secret: 'not returned' }), code('invalid_settings'));
}));
