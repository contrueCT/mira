import { cp, mkdir, readdir, realpath, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// An ordinary file-copy helper, not a package installer or execution boundary.
const checkout = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const argument = process.argv[2];
if (!argument || process.argv.length !== 3 || !path.isAbsolute(argument)) {
  throw new Error('Usage: node scripts/create-extension-workspace.mts /absolute/new/workspace');
}
const destination = path.join(await realpath(path.dirname(argument)), path.basename(argument));
const relative = path.relative(checkout, destination);
if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
  throw new Error('Keep the extension workspace outside the Mira source checkout');
}
// Resolve only the already installed, explicitly named local dependencies.
// Do this before creating anything so missing checkout dependencies fail early.
const sdk = await realpath(path.join(checkout, 'packages/extension-sdk'));
const typescript = await realpath(path.join(checkout, 'node_modules/typescript'));
const nodeTypes = await realpath(path.join(checkout, 'node_modules/@types/node'));
const undiciTypes = path.dirname(createRequire(path.join(nodeTypes, 'package.json')).resolve('undici-types/package.json'));
await mkdir(destination); // Deliberately refuse to overwrite any existing directory.
for (const name of await readdir(path.join(checkout, 'templates/extension'))) {
  await cp(path.join(checkout, 'templates/extension', name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true });
}
await mkdir(path.join(destination, '.deps'));
await mkdir(path.join(destination, 'node_modules/@mira'), { recursive: true });
await mkdir(path.join(destination, 'node_modules/@types'), { recursive: true });
// Node resolves the SDK's realpath outside node_modules before stripping .ts.
// Copying the SDK's .ts sources directly into node_modules does not work.
await symlink(sdk, path.join(destination, '.deps/extension-sdk'), 'dir');
await symlink('../../.deps/extension-sdk', path.join(destination, 'node_modules/@mira/extension-sdk'), 'dir');
await symlink(typescript, path.join(destination, 'node_modules/typescript'), 'dir');
// Keep the declaration package's existing transitive dependency explicit. This
// small local copy remains resolvable when the entire workspace is snapshotted.
await cp(nodeTypes, path.join(destination, '.deps/node-types'), { recursive: true, force: false, errorOnExist: true });
await mkdir(path.join(destination, '.deps/node-types/node_modules'));
await symlink(undiciTypes, path.join(destination, '.deps/node-types/node_modules/undici-types'), 'dir');
await symlink('../../.deps/node-types', path.join(destination, 'node_modules/@types/node'), 'dir');
console.log(`Created ${destination}`);
console.log('Run from that directory: node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json');
console.log('Then: node --test tests/*.test.mts');
