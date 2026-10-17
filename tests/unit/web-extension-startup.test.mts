import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ExtensionHost, type ExtensionConfiguration } from '@mira/extension-host';
import { readWebExtensionConfiguration } from '../../apps/server/src/web-extensions.ts';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../../apps/server/src/web-cli.mts', import.meta.url));
const hook = fileURLToPath(new URL('./fixtures/web-cli-capture-hook.mjs', import.meta.url));
const guard = fileURLToPath(new URL('../deny-model-network.mts', import.meta.url));
const receive = async () => 'inserted' as const;
interface CapturedOptions { miraHome: string; memoryRoot: string; spoolDirectory: string; settingsFile: string; synthetic: boolean; extensions: ExtensionConfiguration }

async function fixture(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-web-extension-startup-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function absent(file: string): Promise<void> {
  await assert.rejects(stat(file), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
}
async function runCli(root: string, explicitFile?: string, defaultHome = false): Promise<{ code: number | null; stdout: string; stderr: string; capture: string }> {
  const capture = path.join(root, `cli-${randomUUID()}.json`);
  // No inherited provider keys, database variables, proxies, NODE_OPTIONS, or
  // MIRA_EXTENSIONS. Supplying '' must be distinguishable from omitting it.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'], HOME: root, TMPDIR: root,
    XDG_CACHE_HOME: root, XDG_CONFIG_HOME: root, XDG_DATA_HOME: root,
    ...(!defaultHome ? { MIRA_HOME: path.join(root, 'home') } : {}), MIRA_CWD: root,
    MIRA_DATABASE_URL: 'postgres://localhost/mira_test',
    MIRA_TEST_CLI_CAPTURE: capture,
    ...(explicitFile === undefined ? {} : { MIRA_EXTENSIONS: explicitFile }),
  };
  const child = spawn(process.execPath, ['--import', guard, '--import', hook, cli, '--synthetic', '--no-open'], {
    cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
  });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (text: string) => { stdout += text; });
  child.stderr.on('data', (text: string) => { stderr += text; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  return { code, stdout, stderr, capture };
}
async function startup(root: string, explicitFile?: string): Promise<CapturedOptions> {
  const child = await runCli(root, explicitFile);
  assert.equal(child.code, 0, child.stderr);
  assert.match(child.stdout, /Mira synthetic mode/);
  return JSON.parse(await readFile(child.capture, 'utf8')) as CapturedOptions;
}

test('concurrent default configuration initialization publishes complete JSON and leaves no temporary files', async () => fixture(async root => {
  const expected = { entries: [], artifactsDirectory: path.join(root, 'extension-artifacts'), configurationFile: path.join(root, 'extensions.json') };
  const results = await Promise.all(Array.from({ length: 32 }, () => readWebExtensionConfiguration(root)));
  for (const result of results) assert.deepEqual(result, expected);
  assert.deepEqual(JSON.parse(await readFile(expected.configurationFile, 'utf8')), { entries: [], artifactsDirectory: expected.artifactsDirectory });
  assert.deepEqual(await readdir(root), ['extensions.json']);
  assert.equal((await stat(expected.configurationFile)).mode & 0o777, 0o600);
}));

test('existing default configuration is read without replacing paths, entries, metadata or authored bytes', async () => fixture(async root => {
  const file = path.join(root, 'extensions.json');
  const document = { entries: [{ id: 'manual', path: path.join(root, 'manual.mjs'), enabled: false, config: { label: 'keep' } }], hmr: false, artifactsDirectory: path.join(root, 'custom-artifacts'), notes: ['retain', { whitespace: true }] };
  const original = `\n${JSON.stringify(document, null, 4)}\n\n`;
  await writeFile(file, original);
  const result = await readWebExtensionConfiguration(root);
  assert.deepEqual(result, { entries: document.entries, hmr: false, artifactsDirectory: document.artifactsDirectory, configurationFile: file });
  assert.equal(await readFile(file, 'utf8'), original);
  await absent(path.join(root, 'extension-artifacts'));
}));

test('an existing minimal default stays authoritative without silently adding an artifact store', async () => fixture(async root => {
  const file = path.join(root, 'extensions.json');
  const original = '{ "entries": [], "note": "ordinary authored configuration" }\n';
  await writeFile(file, original);
  assert.deepEqual(await readWebExtensionConfiguration(root), { entries: [], configurationFile: file });
  assert.equal(await readFile(file, 'utf8'), original);
  assert.deepEqual(await readdir(root), ['extensions.json']);
}));

test('invalid existing defaults fail without repairing or replacing their bytes', async () => {
  for (const invalid of ['{', '{"entries":false}', '{"entries":[],"artifactsDirectory":"relative"}']) await fixture(async root => {
    const file = path.join(root, 'extensions.json'); await writeFile(file, invalid);
    await assert.rejects(readWebExtensionConfiguration(root));
    assert.equal(await readFile(file, 'utf8'), invalid);
    assert.deepEqual(await readdir(root), ['extensions.json']);
  });
});

test('explicit configuration is authoritative and leaves an invalid default untouched', async () => fixture(async root => {
  const home = path.join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const defaultFile = path.join(home, 'extensions.json'); await writeFile(defaultFile, 'not valid JSON');
  const explicitFile = path.join(root, 'selected.json');
  const document = { entries: [], hmr: false, artifactsDirectory: path.join(root, 'selected-artifacts'), note: 'explicit' };
  const original = JSON.stringify(document); await writeFile(explicitFile, original);
  const options = await startup(root, explicitFile);
  assert.deepEqual(options.extensions, { entries: [], hmr: false, artifactsDirectory: document.artifactsDirectory, configurationFile: explicitFile });
  assert.equal(await readFile(defaultFile, 'utf8'), 'not valid JSON');
  assert.equal(await readFile(explicitFile, 'utf8'), original);
}));

test('a valid explicit CLI configuration creates no default file or artifact store', async () => fixture(async root => {
  const explicitFile = path.join(root, 'selected.json');
  const original = '{ "entries": [], "note": "no implicit store" }\n';
  await writeFile(explicitFile, original);
  const options = await startup(root, explicitFile);
  assert.deepEqual(options.extensions, { entries: [], configurationFile: explicitFile });
  assert.equal(await readFile(explicitFile, 'utf8'), original);
  await absent(path.join(root, 'home/extensions.json'));
  await absent(path.join(root, 'home/extension-artifacts'));
}));

test('missing, invalid and empty explicit CLI overrides fail before service creation with no default fallback', async () => {
  for (const kind of ['missing', 'invalid', 'empty'] as const) await fixture(async root => {
    const explicitFile = kind === 'empty' ? '' : path.join(root, `${kind}.json`);
    if (kind === 'invalid') await writeFile(explicitFile, '{"entries":false}');
    const child = await runCli(root, explicitFile);
    assert.equal(child.code, 1, `Explicit ${kind} override must fail before service creation: ${child.stderr}`);
    await absent(child.capture);
    await absent(path.join(root, 'home/extensions.json'));
    await absent(path.join(root, 'home/extension-artifacts'));
    if (kind === 'invalid') assert.equal(await readFile(explicitFile, 'utf8'), '{"entries":false}');
  });
});

test('actual CLI concurrent startups without MIRA_EXTENSIONS all pass the same persistent empty host options', async () => fixture(async root => {
  const options = await Promise.all(Array.from({ length: 8 }, () => startup(root)));
  const home = await realpath(path.join(root, 'home'));
  const expected = { entries: [], artifactsDirectory: path.join(home, 'extension-artifacts'), configurationFile: path.join(home, 'extensions.json') };
  for (const option of options) {
    assert.equal(option.miraHome, home); assert.equal(option.synthetic, true);
    assert.deepEqual(option.extensions, expected);
    assert.notEqual(option.extensions.artifactsDirectory, option.memoryRoot);
  }
  assert.deepEqual(await readdir(home), ['extensions.json']);
}));

test('actual CLI without MIRA_HOME resolves all managed storage under the isolated HOME/.mira', async () => fixture(async root => {
  const child = await runCli(root, undefined, true);
  assert.equal(child.code, 0, child.stderr);
  const options = JSON.parse(await readFile(child.capture, 'utf8')) as CapturedOptions;
  const home = await realpath(path.join(root, '.mira'));
  assert.equal(options.miraHome, home);
  assert.equal(options.spoolDirectory, path.join(home, 'wake-input'));
  assert.equal(options.memoryRoot, path.join(home, 'memory'));
  assert.equal(options.settingsFile, path.join(home, 'models.json'));
  assert.equal(options.extensions.configurationFile, path.join(home, 'extensions.json'));
}));

test('CLI-created default host stages, installs disabled, activates and restores a generated extension across restarts', { timeout: 30_000 }, async () => fixture(async root => {
  const source = path.join(root, 'authored');
  const lifecycle = path.join(root, 'lifecycle.txt'); await writeFile(lifecycle, '');
  await mkdir(path.join(source, 'node_modules/@mira'), { recursive: true });
  await symlink(fileURLToPath(new URL('../../packages/extension-sdk/', import.meta.url)), path.join(source, 'node_modules/@mira/extension-sdk'));
  await writeFile(path.join(source, 'package.json'), '{"type":"module","private":true}');
  await writeFile(path.join(source, 'entry.mjs'), `
    import { appendFile } from 'node:fs/promises';
    import { defineExtension } from '@mira/extension-sdk';
    await appendFile(${JSON.stringify(lifecycle)}, 'import\\n');
    let calls = 0;
    export default defineExtension({ name: 'default-generated', async apply(context, config) {
      await appendFile(${JSON.stringify(lifecycle)}, 'apply\\n');
      context.registerTool({ name: 'default_generated_echo', description: 'Offline default-startup fixture', parameters: { type: 'object' },
        async execute() { return { text: config.label + ':' + (++calls) }; } });
    } });
  `);
  let host: ExtensionHost | undefined;
  try {
    const options = await startup(root);
    host = new ExtensionHost({ ...options.extensions, receive }); await host.start();
    assert.deepEqual(host.inspect(), []); assert.deepEqual(await host.prepare(), []);
    const staged = await host.stage(source, 'entry.mjs');
    assert.equal(await readFile(lifecycle, 'utf8'), '', 'staging must not import or activate code');
    const install = await host.requestChange('generated', { action: 'install', digest: staged.digest, config: { label: 'persisted' } });
    assert.equal(install.status, 'applied'); assert.equal(install.runtime?.status, 'disabled');
    assert.deepEqual(await host.prepare(), []);
    assert.equal(host.inspect()[0]!.status, 'disabled');
    assert.equal(host.changeStatus().find(item => item.id === install.id)!.persistence, 'saved');
    assert.equal(await readFile(lifecycle, 'utf8'), '', 'install must remain disabled');
    await host.close(); host = undefined;

    const disabledOptions = await startup(root);
    assert.equal(disabledOptions.extensions.entries[0]!.enabled, false);
    host = new ExtensionHost({ ...disabledOptions.extensions, receive }); await host.start();
    assert.deepEqual(await host.prepare(), []);
    assert.equal(await readFile(lifecycle, 'utf8'), '', 'a default restart must not activate a disabled install');
    const activate = await host.requestChange('generated', { action: 'activate' });
    assert.equal(activate.status, 'applied'); assert.equal(activate.runtime?.status, 'active');
    const [tool] = await host.prepare(); assert.ok(tool);
    assert.equal(tool.tool.name, 'default_generated_echo'); assert.equal(tool.digest, staged.digest);
    assert.equal((await tool.tool.execute({}, { callId: 'before-restart', signal: new AbortController().signal })).text, 'persisted:1');
    assert.equal(host.changeStatus().find(item => item.id === activate.id)!.persistence, 'saved');
    assert.equal(await readFile(lifecycle, 'utf8'), 'import\napply\n');
    await host.close(); host = undefined;

    const enabledOptions = await startup(root);
    assert.equal(enabledOptions.extensions.entries[0]!.enabled, true);
    assert.equal(enabledOptions.extensions.entries[0]!.generated!.digest, staged.digest);
    host = new ExtensionHost({ ...enabledOptions.extensions, receive }); await host.start();
    const [restored] = await host.prepare(); assert.ok(restored);
    assert.equal(restored.digest, staged.digest);
    assert.equal((await restored.tool.execute({}, { callId: 'after-restart', signal: new AbortController().signal })).text, 'persisted:1');
    assert.equal(await readFile(lifecycle, 'utf8'), 'import\napply\nimport\napply\n');
    assert.deepEqual(host.changeStatus(), [], 'restart must not replay prior management requests');
  } finally { await host?.close(); }
}));
