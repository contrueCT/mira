import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ArtifactStore } from '@mira/extension-host/artifacts';

const checkout = fileURLToPath(new URL('../..', import.meta.url));
const setup = path.join(checkout, 'scripts/create-extension-workspace.mts');
// Loading the actual public factories by URL keeps Pi's third-party declarations
// out of this strict NodeNext project. No replacement filesystem/shell operations.
const piUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
type ToolResult = { content: Array<{ type: string; text?: string }> };
type Tool = { execute(id: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> };
type PiTools = Record<'createReadTool' | 'createWriteTool' | 'createEditTool' | 'createBashTool', (cwd: string) => Tool>;
const text = (result: ToolResult): string => result.content.flatMap(part => part.type === 'text' ? [part.text ?? ''] : []).join('\n');
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// Test-only Node API tripwire, not a product isolation layer or OS sandbox.
// Native executables, addons, deliberately restored APIs, and other networking
// implementations are outside this guard. No OS/network settings are changed.
const networkPreload = `
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
import { syncBuiltinESMExports } from 'node:module';
const previous = [];
function denied() { throw new Error('Synthetic fixture blocked Node network API'); }
function block(object, key) {
  if (typeof object[key] !== 'function') return;
  previous.push([object, key, Object.getOwnPropertyDescriptor(object, key)]);
  Object.defineProperty(object, key, { value: denied, writable: true, configurable: true });
}
block(net.Socket.prototype, 'connect');
block(dgram, 'createSocket');
for (const key of ['bind', 'connect', 'send']) block(dgram.Socket.prototype, key);
for (const object of [dns, dnsPromises, dns.Resolver.prototype, dnsPromises.Resolver.prototype]) {
  const keys = new Set();
  for (let parent = object; parent && parent !== Object.prototype; parent = Object.getPrototypeOf(parent)) {
    for (const key of Object.getOwnPropertyNames(parent)) if (/^(lookup|resolve|reverse)/.test(key)) keys.add(key);
  }
  for (const key of keys) block(object, key);
}
block(globalThis, 'fetch');
syncBuiltinESMExports();
export function restore() {
  for (const [object, key, descriptor] of previous.reverse()) {
    if (descriptor) Object.defineProperty(object, key, descriptor);
    else delete object[key];
  }
  syncBuiltinESMExports();
}
`;
const networkProbe = `
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import dns from 'node:dns';
import dnsPromises from 'node:dns/promises';
const blocked = /Synthetic fixture blocked Node network API/;
assert.throws(() => net.connect({ host: '127.0.0.1', port: 9 }), blocked);
assert.throws(() => dgram.createSocket('udp4'), blocked);
assert.throws(() => dns.lookup('synthetic.invalid', () => {}), blocked);
assert.throws(() => dnsPromises.lookup('synthetic.invalid'), blocked);
assert.throws(() => new dns.Resolver().resolve4('synthetic.invalid', () => {}), blocked);
assert.throws(() => new dnsPromises.Resolver().resolve4('synthetic.invalid'), blocked);
assert.throws(() => fetch('http://127.0.0.1:9/'), blocked);
console.log('NODE_NETWORK_APIS_BLOCKED');
`;
const guard = (env: NodeJS.ProcessEnv): string => `export NODE_OPTIONS=${quote(env['NODE_OPTIONS']!)}; `;

async function temporary(run: (directory: string, env: NodeJS.ProcessEnv) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-extension-template-'));
  let restore: (() => void) | undefined;
  try {
    const relative = path.relative(await realpath(checkout), await realpath(directory));
    assert.ok(relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative), 'workspace must really be outside the source checkout');
    const preload = path.join(directory, 'deny-node-network.mjs');
    await writeFile(preload, networkPreload);
    const url = pathToFileURL(preload).href;
    // Guard the native Pi factories in this process and their Node children.
    ({ restore } = await import(url) as { restore: () => void });
    const env = { ...process.env, NODE_OPTIONS: `${process.env['NODE_OPTIONS'] ?? ''} --import=${url}`.trim() };
    await run(directory, env);
  } finally { restore?.(); await rm(directory, { recursive: true, force: true }); }
}

test('native Pi tools author and test an external strict NodeNext extension with Node network APIs blocked', async () => {
  await temporary(async (directory, env) => {
    const pi = await import(piUrl) as PiTools;
    const workspace = path.join(directory, 'ordinary workspace');
    const bash = pi.createBashTool(directory);
    const blocked = await bash.execute('verify-node-network-disabled', {
      command: `${guard(env)}${quote(process.execPath)} --input-type=module -e ${quote(networkProbe)}`, timeout: 20,
    });
    assert.match(text(blocked), /NODE_NETWORK_APIS_BLOCKED/);
    const created = await bash.execute('create-workspace', {
      command: `${guard(env)}${quote(process.execPath)} ${quote(setup)} ${quote(workspace)}`, timeout: 20,
    });
    assert.match(text(created), /Created .*ordinary workspace/);
    assert.equal(await realpath(path.join(workspace, 'node_modules/@mira/extension-sdk')), await realpath(path.join(checkout, 'packages/extension-sdk')));
    assert.equal((await lstat(path.join(workspace, 'node_modules/@mira/extension-sdk'))).isSymbolicLink(), true);
    const manifest = JSON.parse(await readFile(path.join(workspace, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; scripts: Record<string, string> };
    assert.deepEqual(manifest.dependencies, { '@mira/extension-sdk': 'file:./.deps/extension-sdk' });
    assert.deepEqual(Object.keys(manifest.scripts).sort(), ['test', 'typecheck']);
    const config = JSON.parse(await readFile(path.join(workspace, 'tsconfig.json'), 'utf8')) as { compilerOptions: Record<string, unknown> };
    assert.equal(config.compilerOptions['module'], 'NodeNext');
    assert.equal(config.compilerOptions['moduleResolution'], 'NodeNext');
    assert.equal(config.compilerOptions['strict'], true);
    assert.equal(config.compilerOptions['skipLibCheck'], false);

    const read = pi.createReadTool(workspace);
    const original = text(await read.execute('read-entry', { path: 'src/index.ts' }));
    assert.match(original, /import \{ defineExtension \} from '@mira\/extension-sdk'/);
    const write = pi.createWriteTool(workspace);
    await write.execute('write-helper', { path: 'src/greeting.ts', content: "export const greetingPrefix: string = 'Hello';\n" });
    const edit = pi.createEditTool(workspace);
    await edit.execute('edit-entry', { path: 'src/index.ts', edits: [
      { oldText: "import { defineExtension } from '@mira/extension-sdk';", newText: "import { defineExtension } from '@mira/extension-sdk';\nimport { greetingPrefix } from './greeting.ts';" },
      { oldText: 'return `Hello, ${name}!`;', newText: 'return `${greetingPrefix}, ${name}!`;' },
    ] });
    const edited = text(await read.execute('read-edited-entry', { path: 'src/index.ts' }));
    assert.match(edited, /from '\.\/greeting\.ts'/);
    const node = quote(process.execPath);
    // Node's test runner otherwise makes nested --test children silently skip
    // files. Remove only that runner flag in this synthetic acceptance command.
    const validated = await pi.createBashTool(workspace).execute('validate-extension', {
      command: `${guard(env)}unset NODE_TEST_CONTEXT; ${node} node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && ${node} --test tests/*.test.mts && printf '\\nEXTERNAL_EXTENSION_VERIFIED\\n'`, timeout: 30,
    });
    assert.match(text(validated), /EXTERNAL_EXTENSION_VERIFIED/);
    assert.match(text(validated), /pass 3/);
    assert.doesNotMatch(text(validated), /ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);

    // A real type error must fail, not quietly pass through a permissive config.
    await write.execute('write-type-error', { path: 'src/invalid.ts', content: "export const invalid: number = 'not a number';\n" });
    const rejected = spawnSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'], { cwd: workspace, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.match(rejected.stdout, /Type 'string' is not assignable to type 'number'/);
  });
});

test('workspace creation refuses in-checkout or existing paths without changing authored files', async () => {
  await temporary(async (directory, env) => {
    const inside = spawnSync(process.execPath, [setup, path.join(checkout, 'templates/extension')], { env, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(inside.status, 0);
    assert.match(inside.stderr, /outside the Mira source checkout/);
    const workspace = path.join(directory, 'workspace');
    const first = spawnSync(process.execPath, [setup, workspace], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(first.status, 0, first.stderr);
    const before = await readFile(path.join(workspace, 'src/index.ts'), 'utf8');
    const repeated = spawnSync(process.execPath, [setup, workspace], { env, encoding: 'utf8', timeout: 20_000 });
    assert.notEqual(repeated.status, 0);
    assert.match(repeated.stderr, /EEXIST/);
    assert.equal(await readFile(path.join(workspace, 'src/index.ts'), 'utf8'), before);
  });
});

test('the complete external template still typechecks and tests after its workspace is removed', async () => {
  await temporary(async (directory, env) => {
    const workspace = path.join(directory, 'source');
    const created = spawnSync(process.execPath, [setup, workspace], { env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(created.status, 0, created.stderr);
    const store = new ArtifactStore(path.join(directory, 'artifacts'));
    const artifact = await store.stage(workspace, 'src/index.ts');
    const sdk = await realpath(path.join(artifact.directory, 'node_modules/@mira/extension-sdk'));
    assert.ok(sdk.startsWith(`${path.dirname(artifact.directory)}${path.sep}`), 'SDK belongs to the immutable private snapshot');
    assert.equal(sdk.split(path.sep).includes('node_modules'), false, 'SDK .ts realpath is outside node_modules');
    await rm(workspace, { recursive: true, force: true });
    const node = quote(process.execPath);
    const result = await store.test(artifact, {
      command: 'bash',
      args: ['-c', `${guard(env)}unset NODE_TEST_CONTEXT; ${node} --input-type=module -e ${quote(networkProbe)} && ${node} node_modules/typescript/bin/tsc --noEmit -p tsconfig.json && ${node} --test tests/*.test.mts`],
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.unchanged, true);
    assert.match(result.stdout, /NODE_NETWORK_APIS_BLOCKED/);
    assert.match(result.stdout, /pass 3/);
    assert.doesNotMatch(result.stderr, /skipping running files|ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING/);
    await store.verify(artifact);
  });
});
