/** Explicit native setup for the one pinned PTY dependency; never enables lifecycle scripts. */
import { createRequire } from 'node:module';
import { readFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const require = createRequire(new URL('../apps/server/package.json', import.meta.url));
const manifest = require.resolve('node-pty/package.json');
const info = JSON.parse(await readFile(manifest, 'utf8')) as { version: string };
if (info.version !== '1.1.0') throw Error('Expected pinned node-pty 1.1.0');
if (!['linux', 'darwin'].includes(process.platform)) throw Error('Terminals support Mac and Linux only');
const root = path.dirname(manifest);
if (process.platform === 'darwin') {
  // Upstream 1.1.0 packages its spawn-helper without the executable bit.
  await chmod(path.join(root, 'prebuilds', `darwin-${process.arch}`, 'spawn-helper'), 0o755);
} else {
  const gyp = createRequire(import.meta.url).resolve('node-gyp/bin/node-gyp.js');
  const args = [gyp, 'rebuild', '--directory', root, '--devdir', path.resolve('node_modules/.cache/node-gyp')];
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.status !== 0) throw Error('PTY build failed. Install Python 3, make and a C++ compiler, then rerun pnpm terminal:prepare.');
}
// Loading is a real native-module check; tests separately spawn a real PTY.
require('node-pty');
console.log('Pinned node-pty is ready. Dependency lifecycle scripts remain disabled.');
