import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLocalHttp, PersonaError, PersonaStore, avatarMime, parsePersona, personaLimits, personaPresets, personaPromptValue, renderPersona, type Persona, type PersonaBackend, type WebBackend } from '@mira/server';

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic-png-body')]);
const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic-jpeg')]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const persona = (overrides: Partial<Persona> = {}): Persona => ({ name: '小满', ring: 'sky', avatar: null, userCallName: '', language: 'zh',
  identity: '一个住在电脑里的软件生命。', personality: '好奇、直接。', speakingStyle: '句子短。', boundaries: '', examples: [{ user: '在吗', reply: '在，说。' }], extra: '', ...overrides });
async function home(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-persona-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('parsing normalizes text, applies defaults and rejects unknown fields, bad enums and over-limit values', () => {
  const parsed = parsePersona({ name: '  小满\t', identity: 'a\r\n\n\n\nb\u0007', examples: [{ user: '', reply: '' }] })!;
  assert.deepEqual(parsed, { name: '小满', ring: 'lavender', avatar: null, userCallName: '', language: 'auto', identity: 'a\n\nb', personality: '', speakingStyle: '', boundaries: '', examples: [], extra: '' });
  assert.equal(parsePersona(null), null);
  for (const value of [{}, { name: '' }, { name: 'x', secret: 1 }, { name: 'x', ring: 'red' }, { name: 'x', language: 'fr' }, { name: 'x', avatar: '../etc' },
    { name: 'x'.repeat(personaLimits.name + 1) }, { name: 'x', identity: 'y'.repeat(personaLimits.identity + 1) },
    { name: 'x', examples: [{ user: 'only user', reply: '' }] }, { name: 'x', examples: Array(4).fill({ user: 'a', reply: 'b' }) },
    { name: 'x', presetId: 'Bad Id' }, { name: '\ud800' }, [], 'x']) assert.throws(() => parsePersona(value), PersonaError, JSON.stringify(value));
  // Every field near its own limit still fails as a whole above the 4000-character prompt budget.
  const big = { name: 'n', identity: 'i'.repeat(600), personality: 'p'.repeat(600), speakingStyle: 's'.repeat(600), boundaries: 'b'.repeat(400), extra: 'e'.repeat(1000),
    examples: Array(3).fill({ user: 'u'.repeat(200), reply: 'r'.repeat(200) }) };
  assert.throws(() => parsePersona(big), /Invalid persona/);
  assert.ok(parsePersona({ ...big, extra: '' }));
});

test('rendering uses fixed English labels, omits empty fields and keeps user words verbatim', () => {
  const text = renderPersona(persona({ userCallName: '队长', boundaries: '不扮演恋人', extra: '第一行\n第二行' }));
  assert.equal(text, ['Name: 小满', 'How to address the user: 队长', 'Primary language: Chinese', 'Identity and background: 一个住在电脑里的软件生命。',
    'Personality and attitude: 好奇、直接。', 'Speaking style: 句子短。', 'Boundaries (things you do not do or play): 不扮演恋人',
    'Example exchanges (voice only, not facts):', 'User: 在吗', '小满: 在，说。', 'Additional notes:\n第一行\n第二行'].join('\n'));
  assert.equal(personaPromptValue(null), undefined);
  assert.ok(!renderPersona(persona()).includes('How to address the user'));
});

test('presets are valid complete profiles with invented names and never address the user by name', () => {
  const ids = personaPresets.map(preset => preset.id);
  assert.deepEqual(ids, ['default', 'partner', 'companion', 'concise', 'snarky', 'tsundere', 'blank']);
  assert.equal(personaPresets.find(preset => preset.id === 'tsundere')!.label, '傲娇');
  for (const preset of personaPresets) {
    if (preset.persona === null) { assert.equal(preset.id, 'default'); continue; }
    assert.deepEqual(parsePersona(preset.persona), preset.persona, preset.id);
    assert.equal(preset.persona.userCallName, '', `${preset.id} must not prefill how to address the user`);
    assert.ok(!JSON.stringify(preset.persona).includes('祖禾'));
  }
});

test('store saves with compare-and-set, keeps 20 history versions and restores as a new version', async t => {
  const root = await home(t); const store = new PersonaStore(root);
  const empty = await store.get();
  assert.deepEqual({ ...empty, revision: undefined }, { revision: undefined, version: 0, updatedAt: null, persona: null });
  const first = await store.save(empty.revision, persona());
  assert.equal(first.changed, true); assert.equal(first.version, 1);
  assert.equal((await stat(path.join(root, 'persona.json'))).mode & 0o777, 0o600);
  await assert.rejects(store.save(empty.revision, persona({ name: '阿暖' })), (error: unknown) => error instanceof PersonaError && error.code === 'conflict');
  const same = await store.save(first.revision, persona());
  assert.equal(same.changed, false); assert.equal(same.revision, first.revision);
  let revision = first.revision;
  for (let index = 2; index <= 25; index++) revision = (await store.save(revision, persona({ name: `版本${index}` }))).revision;
  const history = await store.history();
  assert.equal(history.length, 20); assert.equal(history[0]!.version, 25); assert.equal(history.at(-1)!.version, 6);
  const restored = await store.restore(history[5]!.revision, revision);
  assert.equal(restored.version, 26); assert.equal(restored.persona!.name, '版本20'); assert.equal(restored.changed, true);
  assert.equal((await store.history())[0]!.persona!.name, '版本20');
  await assert.rejects(store.restore('0'.repeat(64), restored.revision), (error: unknown) => error instanceof PersonaError && error.code === 'not_found');
  const reset = await store.save(restored.revision, null);
  assert.equal(reset.persona, null); assert.equal((await store.get()).persona, null);
  // Concurrent saves from one revision: exactly one wins.
  const results = await Promise.allSettled([store.save(reset.revision, persona({ name: 'A' })), store.save(reset.revision, persona({ name: 'B' }))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
});

test('a shared-readable MIRA_HOME is accepted while the avatar directory stays private', async t => {
  const root = await home(t); await chmod(root, 0o755);
  const store = new PersonaStore(root);
  const saved = await store.save((await store.get()).revision, persona());
  assert.equal(saved.version, 1);
  await store.putAvatar(png);
  await chmod(path.join(root, 'persona-avatars'), 0o755);
  await assert.rejects(store.putAvatar(jpeg), /unavailable/);
});

test('store fails closed on corrupt, oversized, symlinked or group-readable files', async t => {
  const root = await home(t); const store = new PersonaStore(root); const file = path.join(root, 'persona.json');
  await writeFile(file, '{bad', { mode: 0o600 });
  await assert.rejects(store.get(), (error: unknown) => error instanceof PersonaError && error.code === 'unavailable');
  await writeFile(file, JSON.stringify({ formatVersion: 1, version: 1, updatedAt: null, current: { name: 'x', secret: true }, history: [] }), { mode: 0o600 });
  await assert.rejects(store.get(), /unavailable/);
  await writeFile(file, JSON.stringify({ formatVersion: 1, version: 0, updatedAt: null, current: null, history: [] }));
  await chmod(file, 0o644);
  await assert.rejects(store.get(), /unavailable/);
  await rm(file); await writeFile(path.join(root, 'elsewhere.json'), '{}', { mode: 0o600 }); await symlink(path.join(root, 'elsewhere.json'), file);
  await assert.rejects(store.get(), /unavailable/);
  await rm(file); await writeFile(file, 'x'.repeat(1_048_577), { mode: 0o600 });
  await assert.rejects(store.get(), /unavailable/);
});

test('avatars are validated by signature and size, content-addressed, required to exist and pruned when unreferenced', async t => {
  const root = await home(t); const store = new PersonaStore(root);
  assert.equal(avatarMime(png), 'image/png'); assert.equal(avatarMime(jpeg), 'image/jpeg'); assert.equal(avatarMime(webp), 'image/webp');
  for (const bytes of [Buffer.from('<svg/>'), Buffer.from('GIF89a'), Buffer.alloc(0), Buffer.concat([png, Buffer.alloc(personaLimits.avatarBytes)])])
    await assert.rejects(store.putAvatar(bytes), /Invalid persona/);
  const uploaded = await store.putAvatar(png);
  assert.deepEqual({ ...uploaded, id: undefined }, { id: undefined, mimeType: 'image/png', bytes: png.length });
  assert.deepEqual(await store.putAvatar(png), uploaded, 'same bytes produce the same id');
  assert.equal((await stat(path.join(root, 'persona-avatars'))).mode & 0o777, 0o700);
  const read = await store.readAvatar(uploaded.id);
  assert.equal(read.mimeType, 'image/png'); assert.deepEqual(read.bytes, png);
  await assert.rejects(store.readAvatar('f'.repeat(64)), /not found/);
  await assert.rejects(store.save((await store.get()).revision, persona({ avatar: 'e'.repeat(64) })), /Invalid persona/);
  const saved = await store.save((await store.get()).revision, persona({ avatar: uploaded.id }));
  assert.equal(saved.persona!.avatar, uploaded.id);
  // Tampered bytes on disk are not served.
  const avatarFile = path.join(root, 'persona-avatars', `${uploaded.id}.png`);
  await writeFile(avatarFile, Buffer.concat([png, Buffer.from('x')]));
  await assert.rejects(store.readAvatar(uploaded.id), /not found/);
  await writeFile(avatarFile, png);
  const stale = await store.putAvatar(jpeg);
  const old = new Date(Date.now() - 2 * 60 * 60_000);
  await utimes(path.join(root, 'persona-avatars', `${stale.id}.jpg`), old, old);
  const fresh = await store.putAvatar(webp);
  await store.save(saved.revision, persona({ avatar: uploaded.id, name: '改名' }));
  const names = await readdir(path.join(root, 'persona-avatars'));
  assert.ok(names.includes(`${uploaded.id}.png`), 'referenced avatar kept');
  assert.ok(names.includes(`${fresh.id}.webp`), 'recent unsaved upload kept');
  assert.ok(!names.includes(`${stale.id}.jpg`), 'old unreferenced upload pruned');
});

const port = 4319;
const origin = `http://127.0.0.1:${port}`;
const readHeaders = { host: `127.0.0.1:${port}`, 'x-mira-client': 'web' };
const writeHeaders = { ...readHeaders, origin, 'content-type': 'application/json' };
function backend(store: PersonaStore): WebBackend & PersonaBackend {
  let applied: { revision: string; at: string } | null = null;
  return {
    status: async () => ({ state: 'idle', mode: 'synthetic', model: null, error: null, identity: { name: '小满', ring: 'sky', avatar: null } }),
    timeline: async () => ({ items: [], nextCursor: null }), submit: async input => ({ id: input.id, receipt: 'inserted' }),
    settings: async () => ({ revision: 'a'.repeat(64), configuration: { builtinCredentials: {}, customConnections: [] }, selection: null }), saveSettings: async value => value as never,
    discover: async () => ({ endpoint: 'x', models: [] }),
    persona: async () => ({ ...await store.get(), applied }),
    savePersona: async (revision, value) => { const saved = await store.save(revision, value); applied = { revision: saved.revision, at: '2026-10-30T00:00:00.000Z' }; return { ...saved, applied }; },
    personaHistory: () => store.history(),
    restorePersona: async (revision, expected) => ({ ...await store.restore(revision, expected), applied }),
    uploadPersonaAvatar: bytes => store.putAvatar(bytes), readPersonaAvatar: id => store.readAvatar(id),
  };
}

test('persona HTTP routes enforce the local security model, schemas and error codes', async t => {
  const root = await home(t); const store = new PersonaStore(root);
  const app = createLocalHttp({ backend: backend(store), port }); t.after(() => app.close());
  const status = await app.inject({ url: '/api/status', headers: readHeaders });
  assert.deepEqual(status.json().identity, { name: '小满', ring: 'sky', avatar: null });
  const initial = await app.inject({ url: '/api/persona', headers: readHeaders });
  assert.equal(initial.statusCode, 200); assert.equal(initial.json().persona, null); assert.equal(initial.json().limits.total, 4000);
  assert.equal((await app.inject({ url: '/api/persona', headers: { host: readHeaders.host } })).statusCode, 403, 'custom header required');
  assert.equal((await app.inject({ method: 'PUT', url: '/api/persona', headers: { ...readHeaders, 'content-type': 'application/json' }, payload: {} })).statusCode, 403, 'same-origin writes only');
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/persona', headers: writeHeaders })).statusCode, 405);
  const presets = await app.inject({ url: '/api/persona/presets', headers: readHeaders });
  assert.equal(presets.json().presets.length, 7);
  const preview = await app.inject({ method: 'POST', url: '/api/persona/preview', headers: writeHeaders, payload: { persona: persona() } });
  assert.match(preview.json().text, /^Name: 小满\n/); assert.equal(preview.json().limit, 4000);
  assert.ok(!preview.body.includes('<persona>'), 'preview never exposes the system prompt');
  const bad = await app.inject({ method: 'PUT', url: '/api/persona', headers: writeHeaders, payload: { revision: initial.json().revision, persona: { name: 'x', ring: 'red' } } });
  assert.equal(bad.statusCode, 400);
  const tooLong = await app.inject({ method: 'PUT', url: '/api/persona', headers: writeHeaders, payload: { revision: initial.json().revision, persona: { name: 'x', identity: 'y'.repeat(601) } } });
  assert.equal(tooLong.statusCode, 400); assert.deepEqual(tooLong.json(), { error: 'Invalid persona' });
  const saved = await app.inject({ method: 'PUT', url: '/api/persona', headers: writeHeaders, payload: { revision: initial.json().revision, persona: persona() } });
  assert.equal(saved.statusCode, 200); assert.equal(saved.json().changed, true); assert.equal(saved.json().version, 1);
  assert.equal(saved.json().applied.revision, saved.json().revision);
  const conflict = await app.inject({ method: 'PUT', url: '/api/persona', headers: writeHeaders, payload: { revision: initial.json().revision, persona: persona({ name: 'B' }) } });
  assert.equal(conflict.statusCode, 409);
  const history = await app.inject({ url: '/api/persona/history', headers: readHeaders });
  assert.equal(history.json().items[0].name, '小满');
  const missing = await app.inject({ method: 'POST', url: '/api/persona/restore', headers: writeHeaders, payload: { revision: '0'.repeat(64), expectedRevision: saved.json().revision } });
  assert.equal(missing.statusCode, 404);
  // Avatar upload is binary-only, signature checked and size limited.
  const binaryHeaders = { ...writeHeaders, 'content-type': 'application/octet-stream' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/persona/avatar', headers: writeHeaders, payload: '{}' })).statusCode, 415);
  assert.equal((await app.inject({ method: 'POST', url: '/api/persona/avatar', headers: binaryHeaders, payload: Buffer.from('<svg onload=alert(1)>') })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/persona/avatar', headers: binaryHeaders, payload: Buffer.alloc(personaLimits.avatarBytes + 1, 1) })).statusCode, 413);
  const avatar = await app.inject({ method: 'POST', url: '/api/persona/avatar', headers: binaryHeaders, payload: png });
  assert.equal(avatar.statusCode, 201); assert.equal(avatar.json().mimeType, 'image/png');
  const served = await app.inject({ url: `/api/persona/avatar/${avatar.json().id}`, headers: readHeaders });
  assert.equal(served.statusCode, 200); assert.equal(served.headers['content-type'], 'image/png'); assert.deepEqual(served.rawPayload, png);
  assert.equal(served.headers['x-content-type-options'], 'nosniff'); assert.equal(served.headers['cache-control'], 'private, no-store');
  assert.equal((await app.inject({ url: `/api/persona/avatar/${avatar.json().id}`, headers: { host: readHeaders.host } })).statusCode, 403, 'avatar reads need the client header');
  assert.equal((await app.inject({ url: '/api/persona/avatar/..%2Fpersona.json', headers: readHeaders })).statusCode, 400);
  assert.equal((await app.inject({ url: `/api/persona/avatar/${'f'.repeat(64)}`, headers: readHeaders })).statusCode, 404);
  // Corrupt local file: 503 rather than silently resetting.
  await writeFile(path.join(root, 'persona.json'), '{bad', { mode: 0o600 });
  assert.equal((await app.inject({ url: '/api/persona', headers: readHeaders })).statusCode, 503);
  assert.match(await readFile(path.join(root, 'persona.json'), 'utf8'), /\{bad/);
});

test('backends without persona support answer 503 for persona routes', async t => {
  const plain: WebBackend = { status: async () => ({ state: 'idle', mode: 'synthetic', model: null, error: null }), timeline: async () => ({ items: [], nextCursor: null }),
    submit: async input => ({ id: input.id, receipt: 'inserted' }), settings: async () => ({ revision: 'a'.repeat(64), configuration: { builtinCredentials: {}, customConnections: [] }, selection: null }),
    saveSettings: async value => value as never, discover: async () => ({ endpoint: 'x', models: [] }) };
  const app = createLocalHttp({ backend: plain, port }); t.after(() => app.close());
  assert.equal((await app.inject({ url: '/api/persona', headers: readHeaders })).statusCode, 503);
  assert.equal((await app.inject({ url: '/api/persona/presets', headers: readHeaders })).statusCode, 200);
});
