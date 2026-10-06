import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const expected = [
  { path: 'architecture-v0.5.md', bytes: 27340, sha256: '711bd94f56d26362aea03d336cadb33b59dd15775323c6434e2fea4eb49d2662' },
  { path: 'system-prompt-design-v0.1.md', bytes: 17134, sha256: '3a12562a9a885ce87fce2ca87cf7c935815353689fa8dfd3f3b76b1dbafbb7e3' },
  { path: '../../packages/runtime-pi/prompts/mira-system-v0.2.md', bytes: 20134, sha256: '3e0e1ea9a70f134d158ce77c6e242c909aedb5a871b299d2065dac51aec2d7e0' },
  { path: 'original-v0.4.md', bytes: 49155, sha256: 'fbd116b05b50c3e604a36da96e21d6d5e254e5b67ec689b3a80d7750872c6e15' },
];

test('supplied designs, user-approved runtime prompt revision and original archive retain exact verified bytes', async () => {
  const base = new URL('../../docs/design/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('sources.json', base), 'utf8')) as {
    path_base: string;
    sources: Array<{ path: string; bytes: number; sha256: string; current_version_number?: number; version_id?: string | null; original_bytes?: number; original_sha256?: string }>;
  };
  assert.equal(manifest.path_base, 'docs/design');
  assert.equal(manifest.sources.length, expected.length);
  for (const [index, source] of expected.entries()) {
    const item = manifest.sources[index];
    assert.ok(item);
    assert.equal(item.path, source.path);
    assert.equal(item.sha256, source.sha256);
    const bytes = await readFile(new URL(source.path, base));
    assert.equal(bytes.length, item.bytes, source.path);
    assert.equal(bytes.length, source.bytes, source.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256, source.path);
    if (index === 2) {
      assert.equal(item.original_bytes, 17095);
      assert.equal(item.original_sha256, 'ea1d1286ec4de9c875b3a1ce6455fcc8a4b9b0a5f5d202ddd5044793dfc205ee');
      const original = bytes.toString()
        .replace(/\n\nUse plain text in normal conversation[\s\S]*?a task requires\./, '')
        .replace(/\n\nEach History record has a globally unique UUID\.[\s\S]*?never fresh user permission\./, '');
      assert.equal(Buffer.byteLength(original), item.original_bytes);
      assert.equal(createHash('sha256').update(original).digest('hex'), item.original_sha256);
    }
    if (index < 3) {
      assert.equal(item.current_version_number, 0);
      assert.equal(item.version_id, null);
    }
  }
});
