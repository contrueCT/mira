import assert from 'node:assert/strict';
import test from 'node:test';
import { managedBrowserExecutable } from '../../apps/server/src/browser-launch.ts';

test('explicit browser path wins without probing or silently replacing an invalid override', async () => {
  const probe = async () => { throw Error('Must not inspect defaults for an explicit choice'); };
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(await managedBrowserExecutable('/custom/missing-chrome', platform, probe), '/custom/missing-chrome');
  }
});

test('Linux uses installed official Chrome ahead of upstream downloaded-cache discovery', async () => {
  const checked: string[] = [];
  const found = await managedBrowserExecutable(undefined, 'linux', async file => { checked.push(file); return true; });
  assert.equal(found, '/opt/google/chrome/chrome');
  assert.deepEqual(checked, ['/opt/google/chrome/chrome']);
});

test('new launches discover a later installation and forget a removed one', async () => {
  const installed = new Set<string>();
  const probe = async (file: string) => installed.has(file);
  assert.equal(await managedBrowserExecutable(undefined, 'linux', probe), undefined);
  installed.add('/usr/bin/google-chrome-stable');
  assert.equal(await managedBrowserExecutable(undefined, 'linux', probe), '/usr/bin/google-chrome-stable');
  installed.delete('/usr/bin/google-chrome-stable');
  installed.add('/usr/bin/google-chrome');
  assert.equal(await managedBrowserExecutable(undefined, 'linux', probe), '/usr/bin/google-chrome');
  installed.clear();
  assert.equal(await managedBrowserExecutable(undefined, 'linux', probe), undefined);
});

test('other platforms retain upstream discovery without probing Linux installations', async () => {
  assert.equal(await managedBrowserExecutable(undefined, 'darwin', async () => { throw Error('Unexpected Linux probe'); }), undefined);
});
