import assert from 'node:assert/strict';
import test from 'node:test';
import { avatarFileProblem, avatarMark, blankPersona, conflictMemoryRequest, draftFrom, draftProblem, isDefaultDraft, normalizedDraft, personaPayload, renderedLength, samePersona, statusIdentity, type Persona } from '../src/persona.ts';
import { createMemoryRequest, MEMORY_REQUEST_PREFIX } from '../src/management.ts';

const partner = (): Persona => ({ ...blankPersona(), name: '小满', ring: 'sky', identity: '软件生命', examples: [{ user: '在吗', reply: '在。' }], presetId: 'partner' });

test('a blank or default draft saves as no persona; anything else is trimmed and complete', () => {
  assert.equal(personaPayload(blankPersona()), null);
  assert.equal(personaPayload({ ...blankPersona(), identity: '   ' }), null);
  assert.equal(isDefaultDraft({ ...blankPersona(), ring: 'sky' }), false);
  const payload = personaPayload({ ...partner(), identity: '  软件生命 \r\n', examples: [{ user: ' a ', reply: ' b ' }, { user: '', reply: '' }] })!;
  assert.equal(payload.identity, '软件生命'); assert.deepEqual(payload.examples, [{ user: 'a', reply: 'b' }]); assert.equal(payload.presetId, 'partner');
  assert.deepEqual(draftFrom(null), blankPersona());
});

test('dirty comparison ignores the preset marker and whitespace but not content', () => {
  const { presetId: _preset, ...plain } = partner();
  assert.equal(samePersona(partner(), plain), true);
  assert.equal(samePersona({ ...partner(), identity: ' 软件生命 ' }, partner()), true);
  assert.equal(samePersona({ ...partner(), name: '阿暖' }, partner()), false);
  assert.equal(samePersona(null, null), true); assert.equal(samePersona(partner(), null), false);
});

test('client checks mirror server limits and the rendered 4,000-character budget', () => {
  assert.equal(draftProblem({ ...partner(), name: '  ' }), '请填写名字');
  assert.match(draftProblem({ ...partner(), identity: 'x'.repeat(601) })!, /身份与背景超过 600/);
  assert.match(draftProblem({ ...partner(), examples: [{ user: 'a', reply: '' }] })!, /两句/);
  const full: Persona = { ...partner(), identity: 'i'.repeat(600), personality: 'p'.repeat(600), speakingStyle: 's'.repeat(600), boundaries: 'b'.repeat(400), extra: 'e'.repeat(1000),
    examples: Array.from({ length: 3 }, () => ({ user: 'u'.repeat(200), reply: 'r'.repeat(200) })) };
  assert.ok(renderedLength(full) > 4000); assert.match(draftProblem(full)!, /总长度/);
  assert.equal(draftProblem(partner()), null);
  assert.equal(renderedLength({ ...blankPersona(), name: '小满' }), 'Name: 小满\nPrimary language: follow the conversation'.length);
});

test('the conflict-tidying request is an ordinary Memory request about Mira only', () => {
  const text = conflictMemoryRequest('小凛');
  assert.match(text, /「小凛」/); assert.match(text, /关于我的事实不要动/);
  const envelope = createMemoryRequest(text);
  assert.ok(envelope.text.startsWith(MEMORY_REQUEST_PREFIX));
});

test('avatar files must be small raster images', () => {
  assert.equal(avatarFileProblem({ type: 'image/png', size: 10 }), null);
  assert.equal(avatarFileProblem({ type: 'image/webp', size: 2 * 1_048_576 }), null);
  assert.match(avatarFileProblem({ type: 'image/svg+xml', size: 10 })!, /PNG/);
  assert.match(avatarFileProblem({ type: 'image/gif', size: 10 })!, /PNG/);
  assert.match(avatarFileProblem({ type: 'image/jpeg', size: 0 })!, /空文件/);
  assert.match(avatarFileProblem({ type: 'image/jpeg', size: 2 * 1_048_576 + 1 })!, /2 MB/);
});

test('status identity falls back to Mira and drops malformed fields', () => {
  assert.deepEqual(statusIdentity(null), { name: 'Mira', ring: 'lavender', avatar: null });
  assert.deepEqual(statusIdentity({ identity: { name: '小满', ring: 'sky', avatar: 'a'.repeat(64) } }), { name: '小满', ring: 'sky', avatar: 'a'.repeat(64) });
  assert.deepEqual(statusIdentity({ identity: { name: '小满', ring: 'red', avatar: '../x' } }), { name: '小满', ring: 'lavender', avatar: null });
  assert.deepEqual(statusIdentity({ identity: { name: ' ', ring: 'sky', avatar: null } }), { name: 'Mira', ring: 'lavender', avatar: null });
  assert.deepEqual(normalizedDraft(partner()).name, '小满');
});

test('avatar image and ring colour are mutually exclusive, and the ring returns after removal', () => {
  assert.deepEqual(avatarMark('rose', 'a'.repeat(64), 'blob:x', false), { mode: 'image', url: 'blob:x' });
  assert.deepEqual(avatarMark('rose', 'a'.repeat(64), null, false), { mode: 'pending' }, 'no ring flash while the image loads');
  assert.deepEqual(avatarMark('rose', 'a'.repeat(64), null, true), { mode: 'ring', color: '#e9cfd8' }, 'a failed image falls back to the ring');
  assert.deepEqual(avatarMark('rose', null, null, false), { mode: 'ring', color: '#e9cfd8' });
  assert.deepEqual(avatarMark('bogus', null, null, false), { mode: 'ring', color: '#bfc2d3' });
  // Removing the image keeps the stored ring choice.
  const withImage = { ...partner(), ring: 'rose' as const, avatar: 'a'.repeat(64) };
  const removed = personaPayload({ ...withImage, avatar: null })!;
  assert.equal(removed.ring, 'rose'); assert.equal(removed.avatar, null);
});
