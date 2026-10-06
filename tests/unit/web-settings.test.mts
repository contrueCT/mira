import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile, link } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeContext } from '@earendil-works/pi-ai';
import { WebSettingsStore, WebSettingsError, parseWebSettings, parseWebSettingsWrite, hasSelectedWebApiKey, webSettingsMaxBytes, listBuiltinCatalog, type WebCustomConnectionWrite } from '@mira/server';

const key = 'synthetic-private-key-sentinel';
const nextKey = 'synthetic-replacement-key-sentinel';
function connection(): WebCustomConnectionWrite {
  return { id: 'local', baseUrl: 'http://127.0.0.1:9080/v1', api: 'openai-completions', apiKey: key,
    models: [{ id: 'test-model', contextWindow: 4096, maxTokens: 512, reasoning: false, input: ['text'] }] };
}
const configuration = () => ({ builtinCredentials: {}, customConnections: [connection()] });
const selection = { kind: 'custom', connection: 'local', model: 'test-model' } as const;
async function fixture(run: (store: WebSettingsStore, directory: string, source: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-web-settings-'));
  const source = path.join(directory, 'source'); await mkdir(source);
  try { await run(new WebSettingsStore(path.join(directory, 'data', 'settings.json'), source), directory, source); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
const code = (expected: WebSettingsError['code']) => (error: unknown): boolean => error instanceof WebSettingsError && error.code === expected;
const transcript = normalizeContext({ messages: [{ role: 'user', content: 'Synthetic transport fixture', timestamp: 1 }] });
function completion(text = 'Safe synthetic response'): Response {
  return new Response([
    { id: 'synthetic-response', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'synthetic-response', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }, '[DONE]',
  ].map(item => `data: ${typeof item === 'string' ? item : JSON.stringify(item)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

// All credential strings below are synthetic; no real auth files or provider network.
test('settings persist literal keys only in one protected file, return metadata and survive restart', async () => fixture(async (store, directory, source) => {
  const initial = await store.get();
  assert.match(initial.revision, /^[a-f0-9]{64}$/u); assert.equal(initial.selection, null);
  assert.deepEqual(initial.configuration, { builtinCredentials: {}, customConnections: [] });
  assert.deepEqual(await readdir(directory), ['source']);
  const saved = await store.save({ ...initial, configuration: configuration(), selection });
  assert.notEqual(saved.revision, initial.revision); assert.equal(hasSelectedWebApiKey(saved), true);
  assert.equal(saved.configuration.customConnections[0]!.hasApiKey, true);
  assert.doesNotMatch(JSON.stringify(saved), /apiKeyEnv|"apiKey"|synthetic-private-key/);
  assert.deepEqual(await new WebSettingsStore(store.file, source).get(), saved);
  const raw = await readFile(store.file, 'utf8'); assert.ok(raw.includes(key)); assert.equal(JSON.parse(raw).version, 1);
  assert.equal((await stat(store.file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(store.file))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(path.dirname(store.file)), ['settings.json']);
}));

test('omitted keys retain, strings replace, null removes, and hasApiKey hints never grant or delete a key', async () => fixture(async store => {
  let saved = await store.save({ ...await store.get(), configuration: configuration(), selection });
  saved = await store.save({ ...saved, configuration: { ...saved.configuration, customConnections: [{ ...saved.configuration.customConnections[0]!, name: 'Renamed', hasApiKey: false }] } });
  assert.equal(saved.configuration.customConnections[0]!.hasApiKey, true); assert.ok((await readFile(store.file, 'utf8')).includes(key));
  saved = await store.save({ ...saved, configuration: { ...saved.configuration, customConnections: [{ ...saved.configuration.customConnections[0]!, apiKey: nextKey }] } });
  let raw = await readFile(store.file, 'utf8'); assert.ok(raw.includes(nextKey)); assert.ok(!raw.includes(key));
  saved = await store.save({ ...saved, configuration: { ...saved.configuration, customConnections: [{ ...saved.configuration.customConnections[0]!, apiKey: null }] } });
  assert.equal(hasSelectedWebApiKey(saved), false); assert.equal(saved.configuration.customConnections[0]!.hasApiKey, false);
  raw = await readFile(store.file, 'utf8'); assert.ok(!raw.includes(nextKey)); assert.ok(!raw.includes(key));
  saved = await store.save({ ...saved, configuration: { ...saved.configuration, customConnections: [{ ...saved.configuration.customConnections[0]!, hasApiKey: true }] } });
  assert.equal(saved.configuration.customConnections[0]!.hasApiKey, false);
}));

test('deleting connections deletes their keys and built-in/custom providers never share credentials', async () => fixture(async store => {
  let saved = await store.save({ ...await store.get(), configuration: { builtinCredentials: { openai: { apiKey: nextKey } }, customConnections: [connection()] }, selection });
  assert.equal(saved.configuration.builtinCredentials['openai']?.hasApiKey, true);
  saved = await store.save({ ...saved, configuration: { builtinCredentials: { anthropic: {} }, customConnections: [] }, selection: null });
  assert.equal(saved.configuration.builtinCredentials['anthropic']?.hasApiKey, false);
  const raw = await readFile(store.file, 'utf8'); assert.ok(!raw.includes(key)); assert.ok(!raw.includes(nextKey));
}));

for (const patch of [
  { baseUrl: 'https://other.example/v1' }, { baseUrl: 'http://127.0.0.1:9080/different' },
  { api: 'openai-responses' as const }, { modelsUrl: 'http://127.0.0.1:9080/alternate-models' }, { id: 'changed-id' },
]) test(`changed credential binding clears retained key: ${JSON.stringify(patch)}`, async () => fixture(async store => {
  const saved = await store.save({ ...await store.get(), configuration: configuration(), selection });
  const changed = { ...saved.configuration.customConnections[0]!, ...patch };
  let result = await store.save({ ...saved, configuration: { builtinCredentials: {}, customConnections: [changed] }, selection: null });
  assert.equal(result.configuration.customConnections[0]!.hasApiKey, false); assert.ok(!(await readFile(store.file, 'utf8')).includes(key));
  result = await store.save({ ...result, configuration: { builtinCredentials: {}, customConnections: [{ ...changed, apiKey: nextKey }] } });
  assert.equal(result.configuration.customConnections[0]!.hasApiKey, true);
}));

test('catalog binding changes make stored built-in key unavailable rather than retargeting it', async () => fixture(async store => {
  const model = listBuiltinCatalog('openai').providers[0]!.models[0]!.id;
  const saved = await store.save({ ...await store.get(), configuration: { builtinCredentials: { openai: { apiKey: 'sk-synthetic-builtin-key' } }, customConnections: [] }, selection: { kind: 'builtin', provider: 'openai', model } });
  const raw = JSON.parse(await readFile(store.file, 'utf8')); raw.configuration.builtinCredentials.openai.binding = 'f'.repeat(64);
  await writeFile(store.file, JSON.stringify(raw));
  const changed = await store.get(); assert.notEqual(changed.revision, saved.revision); assert.equal(changed.configuration.builtinCredentials['openai']?.hasApiKey, false);
  await store.save(changed); assert.ok(!(await readFile(store.file, 'utf8')).includes('sk-synthetic-builtin-key'));
}));

test('settings reject stale revisions, preserve external edits and serialize competing rotations', async () => fixture(async (store, _directory, source) => {
  const initial = await store.get(); const saved = await store.save({ ...initial, configuration: configuration(), selection });
  await assert.rejects(store.save(initial), code('settings_conflict'));
  const external = `${await readFile(store.file, 'utf8')} \n`; await writeFile(store.file, external);
  await assert.rejects(store.save(saved), code('settings_conflict')); assert.equal(await readFile(store.file, 'utf8'), external);
  const refreshed = await store.get(); const other = new WebSettingsStore(store.file, source);
  const first = { ...refreshed, configuration: { builtinCredentials: {}, customConnections: [{ ...connection(), apiKey: nextKey }] } };
  const second = { ...refreshed, configuration: { builtinCredentials: {}, customConnections: [{ ...connection(), apiKey: null }] } };
  const result = await Promise.allSettled([store.save(first), other.save(second)]);
  assert.equal(result.filter(item => item.status === 'fulfilled').length, 1);
  const rejected = result.find(item => item.status === 'rejected'); assert.ok(rejected?.status === 'rejected' && code('settings_conflict')(rejected.reason));
  assert.equal((await readdir(path.dirname(store.file))).filter(name => name.endsWith('.tmp')).length, 0);
  const winner = result.find(item => item.status === 'fulfilled'); assert.ok(winner?.status === 'fulfilled'); assert.deepEqual(await store.get(), winner.value);
}));

test('invalid nested fields, env references, malformed keys and unsupported selections never replace settings', async () => fixture(async store => {
  const initial = await store.get();
  for (const candidate of [
    { ...initial, apiKey: key }, { ...initial, revision: 'wrong' }, { ...initial, configuration: { ...configuration(), token: key } },
    ...['', 'has whitespace', 'newline\nkey', 'sk-ant-oat-synthetic', 'x'.repeat(16385), 42, {}, undefined].map(apiKey => ({ ...initial, configuration: { customConnections: [{ ...connection(), apiKey }] } })),
    { ...initial, configuration: { customConnections: [{ ...connection(), apiKeyEnv: 'LEGACY_ENV' }] } },
    { ...initial, configuration: { customConnections: [{ ...connection(), hasApiKey: 'yes' }] } },
    { ...initial, configuration: { customConnections: [{ ...connection(), baseUrl: 'https://user:secret@example.test' }] } },
    { ...initial, configuration: { builtinCredentials: { missing: { apiKey: key } } } },
    { ...initial, configuration: { builtinCredentials: { openai: { apiKeyEnv: 'LEGACY_ENV' } } } },
    { ...initial, configuration: configuration(), selection: { ...selection, apiKey: key } },
    { ...initial, configuration: configuration(), selection: { ...selection, model: 'missing' } },
    { ...initial, selection: { kind: 'builtin', provider: 'openai', model: 'gpt-4.1' } },
    { ...initial, configuration: { builtinCredentials: { 'openai-codex': { apiKey: key } } } },
  ]) {
    await assert.rejects(store.save(candidate), error => { assert.ok(code('invalid_settings')(error)); assert.ok(!(error as Error).message.includes(key)); return true; });
  }
  assert.deepEqual(await store.get(), initial);
}));

test('public metadata cannot echo an old, current or new key, including URL-encoded paths', async () => fixture(async store => {
  const saved = await store.save({ ...await store.get(), configuration: configuration(), selection });
  for (const patch of [
    { name: key, apiKey: nextKey }, { name: nextKey, apiKey: nextKey }, { baseUrl: `http://127.0.0.1:9080/${key}` },
    { modelsUrl: `http://127.0.0.1:9080/${[...key].map(char => `%${char.charCodeAt(0).toString(16)}`).join('')}` },
    { models: [{ ...connection().models[0]!, id: key }] },
  ]) await assert.rejects(store.save({ ...saved, configuration: { builtinCredentials: {}, customConnections: [{ ...saved.configuration.customConnections[0]!, ...patch }] }, selection: null }), code('invalid_settings'));
  assert.deepEqual(await store.get(), saved);
}));

test('response parser rejects every write-only field, while input parser accepts only the credential update location', async () => fixture(async store => {
  const saved = await store.save({ ...await store.get(), configuration: configuration(), selection });
  assert.deepEqual(parseWebSettings(saved), saved);
  for (const configuration of [
    { ...saved.configuration, builtinCredentials: { openai: { hasApiKey: true, apiKey: key } } },
    { ...saved.configuration, customConnections: [{ ...saved.configuration.customConnections[0]!, apiKey: key }] },
  ]) assert.throws(() => parseWebSettings({ ...saved, configuration }), code('invalid_settings'));
  assert.equal(parseWebSettingsWrite({ ...saved, configuration: configuration() }).configuration.customConnections[0]?.apiKey, key);
  saved.configuration.customConnections[0]!.models[0]!.id = 'mutated'; assert.equal((await store.get()).configuration.customConnections[0]!.models[0]!.id, 'test-model');
}));

test('settings reject symlinks, hard links, directories and unsafe permissions without clobbering data', async () => fixture(async (store, directory, source) => {
  const initial = await store.get(); await mkdir(path.dirname(store.file), { mode: 0o700 });
  const target = path.join(directory, 'valuable.json'); const bytes = 'synthetic original data'; await writeFile(target, bytes, { mode: 0o600 });
  await symlink(target, store.file);
  await assert.rejects(store.get(), code('settings_unavailable')); await assert.rejects(store.save(initial), code('settings_unavailable'));
  assert.equal(await readFile(target, 'utf8'), bytes);
  await rm(store.file); await link(target, store.file); await assert.rejects(store.save(initial), code('settings_unavailable')); assert.equal(await readFile(target, 'utf8'), bytes);
  await rm(store.file); await mkdir(store.file); await assert.rejects(store.get(), code('settings_unavailable'));
  await symlink(path.dirname(store.file), path.join(directory, 'alias'));
  const aliased = new WebSettingsStore(path.join(directory, 'alias', 'other.json'), source);
  await assert.rejects(aliased.get(), code('settings_unavailable')); await assert.rejects(aliased.save(initial), code('settings_unavailable'));
  await rm(store.file, { recursive: true }); const saved = await store.save({ ...initial, configuration: configuration(), selection });
  await chmod(store.file, 0o644); await assert.rejects(store.get(), code('settings_unavailable')); await assert.rejects(store.save(saved), code('settings_unavailable'));
  await chmod(store.file, 0o600); await chmod(path.dirname(store.file), 0o755); await assert.rejects(store.get(), code('settings_unavailable')); await assert.rejects(store.save(saved), code('settings_unavailable'));
  assert.ok((await readFile(store.file, 'utf8')).includes(key));
}));

test('source checkout paths, aliases and automatic snapshot roots are forbidden', async () => fixture(async (_store, directory, source) => {
  assert.throws(() => new WebSettingsStore(path.join(source, 'settings.json'), source), code('settings_unavailable'));
  assert.throws(() => new WebSettingsStore('relative.json', source), code('settings_unavailable'));
  await symlink(source, path.join(directory, 'linked-source'));
  await assert.rejects(new WebSettingsStore(path.join(directory, 'linked-source', 'settings.json'), source).get(), code('settings_unavailable'));
  const memory = path.join(directory, 'memory'); await mkdir(memory); await symlink(memory, path.join(directory, 'memory-alias'));
  assert.throws(() => new WebSettingsStore(path.join(memory, 'settings.json'), source, [memory]), code('settings_unavailable'));
  await assert.rejects(new WebSettingsStore(path.join(memory, 'settings.json'), source, [path.join(directory, 'memory-alias')]).get(), code('settings_unavailable'));
  assert.deepEqual(await readdir(source), []);
}));

test('malformed, legacy, insecure and oversized saved files fail closed without overwriting or echo', async () => fixture(async store => {
  const saved = await store.save({ ...await store.get(), configuration: configuration(), selection });
  const valid = JSON.parse(await readFile(store.file, 'utf8'));
  for (const bytes of [
    `{"apiKey":"${key}"`, JSON.stringify({ configuration: { builtinCredentials: {}, customConnections: [] }, selection: null }),
    JSON.stringify({ ...valid, version: 0 }), JSON.stringify({ ...valid, unexpected: key }),
    JSON.stringify({ ...valid, configuration: { ...valid.configuration, customConnections: [{ ...valid.configuration.customConnections[0], apiKey: { key } }] } }),
    JSON.stringify({ ...valid, configuration: { ...valid.configuration, customConnections: [{ ...valid.configuration.customConnections[0], hasApiKey: true }] } }),
    JSON.stringify({ ...valid, configuration: { ...valid.configuration, customConnections: [{ ...valid.configuration.customConnections[0], name: key }] } }),
    'x'.repeat(webSettingsMaxBytes + 1), Buffer.from([0xff, 0xfe]),
  ]) {
    await writeFile(store.file, bytes);
    await assert.rejects(store.get(), error => { assert.ok(code('settings_unavailable')(error)); assert.ok(!(error as Error).message.includes(key)); return true; });
    await assert.rejects(store.save(saved), code('settings_unavailable')); assert.deepEqual(await readFile(store.file), Buffer.from(bytes));
  }
}));

test('discovery uses matching saved or transient draft key, rejects retargeting, and never persists a draft', async () => fixture(async store => {
  const saved = await store.save({ ...await store.get(), configuration: configuration(), selection });
  const raw = await readFile(store.file, 'utf8'); let expected = key; let calls = 0;
  const fetch: typeof globalThis.fetch = async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${expected}`); return Response.json({ data: [{ id: 'discovered-model' }] }); };
  const current = saved.configuration.customConnections[0]!;
  assert.equal((await store.discover(current, { fetch })).models[0]?.id, 'discovered-model');
  expected = nextKey; await store.discover({ ...current, apiKey: nextKey, baseUrl: 'https://another.example/v1' }, { fetch });
  for (const patch of [{ apiKey: null }, { baseUrl: 'https://another.example/v1' }, { api: 'openai-responses' }, { modelsUrl: `${current.baseUrl}/other-models` }, { id: 'other' }]) await assert.rejects(store.discover({ ...current, ...patch }, { fetch }));
  assert.equal(calls, 2); assert.equal(await readFile(store.file, 'utf8'), raw);
  await assert.rejects(store.discover({ ...current, apiKey: nextKey }, { fetch: async () => { throw Error(nextKey); } }), error => error instanceof Error && !error.message.includes(nextKey));
  assert.equal(await readFile(store.file, 'utf8'), raw);
}));

test('saved keys reach only authenticated transport headers, literal env/command-like values are never interpreted', async () => fixture(async (store, _directory, source) => {
  for (const literal of [key, 'MIRA_SYNTHETIC_ENV_LOOKUP', '!synthetic-do-not-execute']) {
    const saved = await store.save({ ...await store.get(), configuration: { builtinCredentials: {}, customConnections: [{ ...connection(), apiKey: literal }] }, selection });
    const restarted = new WebSettingsStore(store.file, source); let calls = 0;
    const transport = restarted.transport(saved, { fetch: async (_url, init) => {
      calls++; assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${literal}`);
      assert.ok(!String(init?.body).includes(literal)); return completion();
    } });
    assert.ok(!JSON.stringify({ model: transport.model, description: transport.description }).includes(literal));
    const result = await (await transport.streamFn(transport.model, transcript)).result(); assert.equal(result.stopReason, 'stop'); assert.equal(calls, 1);
    assert.ok(!JSON.stringify(result).includes(literal));
  }
}));

test('stale or tampered transport descriptors and missing or malformed credentials never send a request', async () => fixture(async store => {
  const saved = await store.save({ ...await store.get(), configuration: configuration(), selection }); let calls = 0;
  const fetch: typeof globalThis.fetch = async () => { calls++; return completion(); };
  const tampered = structuredClone(saved); tampered.configuration.customConnections[0]!.baseUrl = 'https://unapproved.example/v1';
  const changed = store.transport(tampered, { fetch }); assert.equal((await (await changed.streamFn(changed.model, transcript)).result()).stopReason, 'error');
  const stale = store.transport(saved, { fetch });
  const removed = await store.save({ ...saved, configuration: { builtinCredentials: {}, customConnections: [{ ...connection(), apiKey: null }] } });
  assert.equal((await (await stale.streamFn(stale.model, transcript)).result()).stopReason, 'error');
  const missing = store.transport(removed, { fetch }); assert.equal((await (await missing.streamFn(missing.model, transcript)).result()).stopReason, 'error');
  await writeFile(store.file, `{"apiKey":"${key}"`);
  const failure = await (await missing.streamFn(missing.model, transcript)).result(); assert.equal(failure.stopReason, 'error'); assert.ok(!JSON.stringify(failure).includes(key)); assert.equal(calls, 0);
}));

test('provider credential echoes and error bodies are rejected before public messages or tool execution', async () => fixture(async store => {
  const saved = await store.save({ ...await store.get(), configuration: configuration(), selection });
  for (const response of [() => completion(key), () => new Response(key, { status: 401 }), () => { throw Error(key); }]) {
    const transport = store.transport(saved, { fetch: async () => response() });
    const events = []; const stream = await transport.streamFn(transport.model, transcript);
    for await (const event of stream) events.push(event);
    assert.ok(!JSON.stringify(events).includes(key)); assert.equal((await stream.result()).stopReason, 'error');
  }
}));
