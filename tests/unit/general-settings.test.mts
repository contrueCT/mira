import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { GeneralSettingsStore } from '../../apps/server/src/general-settings.ts';

test('general settings default off, survive reopening, reject stale or invalid writes and unsafe files', async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mira-general-')));
  try {
    const file = path.join(root, 'general.json'); const store = new GeneralSettingsStore(file);
    assert.deepEqual(await store.read(), { revision: 0, showExternalMessages: false });
    const saved = await store.save({ revision: 0, showExternalMessages: true });
    assert.deepEqual(await new GeneralSettingsStore(file).read(), saved);
    await assert.rejects(store.save({ revision: 0, showExternalMessages: false }), { code: 'conflict' });
    await assert.rejects(store.save({ ...saved, extra: true }), { code: 'invalid_input' });
    await writeFile(file, '{broken'); await assert.rejects(store.read(), { code: 'unavailable' });
    await rm(file); await symlink(path.join(root, 'absent'), file);
    await assert.rejects(store.read(), { code: 'unavailable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
