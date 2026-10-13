import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { ExternalAccessStore, ExternalAccessError, externalAccessMaxBytes, type ExternalAccessStatus } from '@mira/server';

const execute = promisify(execFile);
const cli = path.resolve('apps/server/src/external-access-cli.mts');
const sender = 'calendar:local';
const safeCode = (code: ExternalAccessError['code']) => (error: unknown): boolean => error instanceof ExternalAccessError && error.code === code;
interface Fixture { store: ExternalAccessStore; directory: string; home: string; source: string }
async function fixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mira-external-access-'));
  const source = path.join(directory, 'source'); const home = path.join(directory, 'home');
  await mkdir(source, { mode: 0o700 });
  try { await run({ store: new ExternalAccessStore({ miraHome: home, sourceDirectory: source }), directory, home, source }); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
async function token(status: ExternalAccessStatus): Promise<string> {
  assert.ok(status.sender);
  const value = JSON.parse(await readFile(status.sender.credentialFile, 'utf8')) as { token: unknown };
  assert.equal(typeof value.token, 'string');
  return value.token as string;
}
function environment(home: string): NodeJS.ProcessEnv {
  return { PATH: process.env['PATH'], HOME: home, MIRA_HOME: home, NODE_OPTIONS: process.env['NODE_OPTIONS'] };
}
async function command(home: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execute(process.execPath, [cli, ...args], { env: environment(home), timeout: 8_000 });
}

// All homes and random credentials are disposable synthetic fixtures. Tests
// never read user homes, contact a model, or send authentication over a network.
test('external access starts disabled without creating files; metadata is global or one sender', async () => fixture(async ({ store, directory }) => {
  assert.deepEqual(await store.status(), { enabled: false, accessFile: store.accessFile });
  const status = await store.status(sender);
  assert.equal(status.sender?.state, 'missing');
  assert.equal(status.sender?.id, sender);
  assert.match(path.basename(status.sender!.credentialFile), /^[a-f0-9]{64}\.json$/u);
  assert.equal(await store.authenticate(sender, randomBytes(32).toString('base64url')), false);
  assert.deepEqual(await readdir(directory), ['source']);
}));

test('create stores only a private 32-byte token and never enables ingress or returns the token', async () => fixture(async ({ store, home, source }) => {
  const result = await store.create(sender); const secret = await token(result);
  assert.equal(result.enabled, false); assert.equal(result.sender?.state, 'active');
  assert.match(secret, /^[A-Za-z0-9_-]{43}$/u); assert.equal(Buffer.from(secret, 'base64url').length, 32);
  assert.equal(await store.authenticate(sender, secret), false);
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes('"token"'));
  assert.deepEqual(Object.keys(JSON.parse(await readFile(result.sender!.credentialFile, 'utf8'))).sort(), ['id', 'token', 'version']);
  for (const file of [home, store.externalDirectory, path.dirname(result.sender!.credentialFile)]) assert.equal((await lstat(file)).mode & 0o777, 0o700);
  assert.equal((await lstat(result.sender!.credentialFile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(store.externalDirectory), ['senders']);
  assert.deepEqual(await new ExternalAccessStore({ miraHome: home, sourceDirectory: source }).status(sender), result);
  await assert.rejects(store.create(sender), safeCode('external_access_conflict'));
  assert.equal(await token(result), secret);
}));

test('enable, rotate, revoke, reissue and disable take effect on the next request across store instances', async () => fixture(async ({ store, home, source }) => {
  const other = new ExternalAccessStore({ miraHome: home, sourceDirectory: source });
  const created = await store.create(sender); const oldToken = await token(created);
  const another = await store.create('another'); const anotherToken = await token(another);
  assert.equal((await store.setEnabled(true)).enabled, true);
  assert.deepEqual(JSON.parse(await readFile(store.accessFile, 'utf8')), { version: 1, enabled: true });
  assert.equal((await lstat(store.accessFile)).mode & 0o777, 0o600);
  assert.equal(await other.authenticate(sender, oldToken), true);
  assert.equal(await other.authenticate('another', oldToken), false);
  assert.equal(await other.authenticate(sender, anotherToken), false);
  const rotated = await store.rotate(sender); const newToken = await token(rotated);
  assert.notEqual(newToken, oldToken);
  assert.equal(await other.authenticate(sender, oldToken), false); assert.equal(await other.authenticate(sender, newToken), true);
  assert.equal(await other.authenticate('another', anotherToken), true);
  const revoked = await store.revoke(sender); assert.equal(revoked.sender?.state, 'revoked');
  assert.deepEqual(JSON.parse(await readFile(revoked.sender!.credentialFile, 'utf8')), { version: 1, id: sender, token: null });
  assert.equal(await other.authenticate(sender, newToken), false);
  await store.revoke(sender); // Explicit repeated revoke is safe and leaves no key.
  await assert.rejects(store.create(sender), safeCode('external_access_conflict'));
  const reissued = await store.rotate(sender); const lastToken = await token(reissued);
  assert.equal(await other.authenticate(sender, lastToken), true);
  await store.setEnabled(false);
  assert.equal(await other.authenticate(sender, lastToken), false); assert.equal(await other.authenticate('another', anotherToken), false);
  assert.ok(!JSON.stringify([rotated, revoked, reissued, await store.status(sender)]).includes(oldToken));
  assert.ok(!JSON.stringify([rotated, revoked, reissued, await store.status(sender)]).includes(newToken));
  assert.ok(!JSON.stringify([rotated, revoked, reissued, await store.status(sender)]).includes(lastToken));
}));

test('identity validation is strict, paths are portable and authentication rejects malformed inputs', async () => fixture(async ({ store }) => {
  for (const id of ['', '.', '..', '../escape', 'with/slash', 'with\\slash', '-first', 'has space', 'x\n', 'Å', 'a'.repeat(129)]) {
    await assert.rejects(store.status(id), safeCode('invalid_external_access'));
    await assert.rejects(store.create(id), safeCode('invalid_external_access'));
    assert.equal(await store.authenticate(id, randomBytes(32).toString('base64url')), false);
  }
  const identities = ['CON', 'con', 'sender.', 'sender:', 'a'.repeat(128), '__proto__'.slice(2)];
  const paths = new Set<string>();
  for (const id of identities) { const result = await store.create(id); paths.add(result.sender!.credentialFile); assert.equal(result.sender?.id, id); }
  assert.equal(paths.size, identities.length);
  await assert.rejects(store.rotate('missing'), safeCode('external_access_conflict'));
  await assert.rejects(store.revoke('missing'), safeCode('external_access_conflict'));
  await store.setEnabled(true);
  const status = await store.create(sender); const secret = await token(status);
  for (const value of ['', ' ', secret + '=', secret.slice(1), secret + '\n', 'x'.repeat(44), 'x'.repeat(43), null, undefined, 17, {}]) {
    assert.equal(await store.authenticate(sender, value as string), false);
  }
  assert.equal(await store.authenticate(sender, secret), true);
  await assert.rejects(store.setEnabled('true' as unknown as boolean), safeCode('invalid_external_access'));
}));

test('malformed global or sender files fail closed without leaking contents or replacing bad files', async () => fixture(async ({ store }) => {
  const created = await store.create(sender); const secret = await token(created); await store.setEnabled(true);
  const credentialFile = created.sender!.credentialFile;
  const originalAccess = await readFile(store.accessFile); const originalSender = await readFile(credentialFile);
  for (const [file, values] of [
    [store.accessFile, ['{', JSON.stringify({ version: 1, enabled: true, token: secret }), JSON.stringify({ version: 2, enabled: true }), JSON.stringify({ version: 1, enabled: 'true' }), 'x'.repeat(externalAccessMaxBytes + 1), Buffer.from([0xff])]],
    [credentialFile, ['{', JSON.stringify({ version: 1, id: 'different', token: secret }), JSON.stringify({ version: 1, id: sender, token: secret, enabled: true }), JSON.stringify({ version: 1, id: sender, token: '' }), JSON.stringify({ version: 1, id: sender, token: secret + '=' }), JSON.stringify({ version: 2, id: sender, token: secret })]],
  ] as Array<[string, Array<string | Buffer>]>) {
    for (const value of values) {
      await writeFile(file, value);
      assert.equal(await store.authenticate(sender, secret), false);
      await assert.rejects(store.status(sender), safeCode('external_access_unavailable'));
      await assert.rejects(store.rotate(sender), error => {
        assert.ok(error instanceof ExternalAccessError); assert.ok(!String(error).includes(secret)); return true;
      });
      assert.deepEqual(await readFile(file), Buffer.from(value));
      await writeFile(store.accessFile, originalAccess); await writeFile(credentialFile, originalSender);
    }
  }
  await unlink(store.accessFile); assert.equal(await store.authenticate(sender, secret), false);
  await store.setEnabled(true); await unlink(credentialFile); assert.equal(await store.authenticate(sender, secret), false);
}));

test('global disable remains available when a sender file is corrupt', async () => fixture(async ({ store }) => {
  const created = await store.create(sender); await store.setEnabled(true);
  await writeFile(created.sender!.credentialFile, 'corrupted synthetic sender');
  assert.equal((await store.setEnabled(false)).enabled, false);
  assert.equal((await store.status()).enabled, false);
}));

test('safe metadata refuses a credential deliberately equal to a public identity', async () => fixture(async ({ store }) => {
  const synthetic = randomBytes(32).toString('base64url');
  // A valid ID starts alphanumeric; prefixing a fixed byte avoids random '-'/'_'.
  const id = `A${synthetic.slice(1, 42)}A`;
  const canonical = Buffer.from(id, 'base64url').toString('base64url');
  const created = await store.create(canonical);
  await writeFile(created.sender!.credentialFile, JSON.stringify({ version: 1, id: canonical, token: canonical }));
  await assert.rejects(store.status(canonical), safeCode('external_access_unavailable'));
}));

for (const target of ['home', 'external', 'senders', 'access', 'credential'] as const) {
  test(`unsafe permissions on ${target} reject reads and writes without chmod`, async () => fixture(async ({ store, home }) => {
    const created = await store.create(sender); const secret = await token(created); await store.setEnabled(true);
    const file = { home, external: store.externalDirectory, senders: path.dirname(created.sender!.credentialFile), access: store.accessFile, credential: created.sender!.credentialFile }[target];
    await chmod(file, target === 'access' || target === 'credential' ? 0o644 : 0o755);
    assert.equal(await store.authenticate(sender, secret), false);
    await assert.rejects(store.status(sender), safeCode('external_access_unavailable'));
    await assert.rejects(store.rotate(sender), safeCode('external_access_unavailable'));
    assert.ok(((await lstat(file)).mode & 0o077) !== 0);
  }));
}

for (const kind of ['symlink', 'hardlink', 'directory', 'fifo'] as const) {
  test(`credential ${kind} fails closed without altering its target`, async () => fixture(async ({ store, directory }) => {
    const created = await store.create(sender); const secret = await token(created); await store.setEnabled(true);
    const file = created.sender!.credentialFile; const original = await readFile(file);
    const valuable = path.join(directory, 'valuable'); await writeFile(valuable, original, { mode: 0o600 }); await unlink(file);
    if (kind === 'symlink') await symlink(valuable, file);
    if (kind === 'hardlink') await link(valuable, file);
    if (kind === 'directory') await mkdir(file, { mode: 0o700 });
    if (kind === 'fifo') await execute('mkfifo', ['-m', '600', file]);
    assert.equal(await store.authenticate(sender, secret), false);
    await assert.rejects(store.status(sender), safeCode('external_access_unavailable'));
    await assert.rejects(store.rotate(sender), safeCode('external_access_unavailable'));
    assert.deepEqual(await readFile(valuable), original);
  }));
}

test('symlink directories and source/Memory/artifact overlaps are rejected before credential creation', async () => fixture(async ({ directory, source, home }) => {
  for (const options of [
    { miraHome: source, sourceDirectory: source },
    { miraHome: home, sourceDirectory: source, memoryRoot: path.join(home, 'external') },
    { miraHome: home, sourceDirectory: source, memoryRoot: path.join(home, 'external', 'memory') },
    { miraHome: home, sourceDirectory: source, artifactsDirectory: home },
    { miraHome: 'relative', sourceDirectory: source },
  ]) assert.throws(() => new ExternalAccessStore(options), safeCode('external_access_unavailable'));
  await mkdir(home, { mode: 0o700 });
  const alias = path.join(directory, 'alias'); await symlink(home, alias);
  const aliasStore = new ExternalAccessStore({ miraHome: alias, sourceDirectory: source });
  await assert.rejects(aliasStore.create(sender), safeCode('external_access_unavailable'));
  const external = path.join(home, 'external'); await symlink(source, external);
  const store = new ExternalAccessStore({ miraHome: home, sourceDirectory: source });
  await assert.rejects(store.create(sender), safeCode('external_access_unavailable'));
  assert.deepEqual(await readdir(source), []);
  await unlink(external);
  const forbiddenAlias = path.join(directory, 'memory-alias'); await symlink(home, forbiddenAlias);
  const canonicalOverlap = new ExternalAccessStore({ miraHome: home, sourceDirectory: source, memoryRoot: path.join(forbiddenAlias, 'external', 'nested') });
  await assert.rejects(canonicalOverlap.create(sender), safeCode('external_access_unavailable'));
  assert.deepEqual(await readdir(home), []);
}));

test('simultaneous stores reject stale changes and leave only complete files', async () => fixture(async ({ store, source, home }) => {
  await store.create(sender); await store.setEnabled(true);
  const other = new ExternalAccessStore({ miraHome: home, sourceDirectory: source });
  const results = await Promise.allSettled([store.rotate(sender), other.revoke(sender)]);
  // Both snapshot before one lock owner publishes, so exactly one may commit.
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected');
  assert.ok(rejection?.status === 'rejected' && safeCode('external_access_conflict')(rejection.reason));
  assert.deepEqual((await readdir(store.externalDirectory)).sort(), ['access.json', 'senders']);
  assert.equal((await readdir(path.join(store.externalDirectory, 'senders'))).length, 1);
}));

test('cross-process CLI writers cannot replace another create, and stdout/stderr never contain credentials', async () => fixture(async ({ store, home }) => {
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => command(home, 'create', '--id', sender)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const status = await store.status(sender); const secret = await token(status);
  for (const result of results) {
    const output = result.status === 'fulfilled' ? JSON.stringify(result.value) : JSON.stringify({ stdout: result.reason.stdout, stderr: result.reason.stderr });
    assert.ok(!output.includes(secret)); assert.ok(!output.includes('"token"'));
  }
  assert.equal((await store.status()).enabled, false);
  assert.equal(JSON.parse((await command(home, 'enable')).stdout).enabled, true);
  assert.equal(await store.authenticate(sender, secret), true);
  const rotated = JSON.parse((await command(home, 'rotate', '--id', sender)).stdout) as ExternalAccessStatus;
  const next = await token(rotated); assert.notEqual(next, secret);
  assert.equal(await store.authenticate(sender, secret), false); assert.equal(await store.authenticate(sender, next), true);
  assert.equal(JSON.parse((await command(home, 'revoke', '--id', sender)).stdout).sender.state, 'revoked');
  assert.equal(await store.authenticate(sender, next), false);
  assert.equal(JSON.parse((await command(home, 'disable')).stdout).enabled, false);
  assert.deepEqual(JSON.parse((await command(home, 'status', '--home', home)).stdout), await store.status());
  assert.ok(!(await command(home, 'status', '--id', sender)).stdout.includes(next));
}));

for (const scenario of ['revoke', 'sender-aba', 'global-aba'] as const) {
  test(`cross-process stale ${scenario} intent cannot replace a later change`, async () => fixture(async ({ store, home, source }) => {
    await store.create(sender);
    if (scenario === 'sender-aba') await store.revoke(sender);
    // Pause exactly after the child's snapshot and before it acquires the real
    // file lock. This test-only method wrapper leaves the disk algorithm intact.
    const script = `
      import { ExternalAccessStore } from ${JSON.stringify(pathToFileURL(path.resolve('apps/server/src/external-access.ts')).href)};
      const store = new ExternalAccessStore(${JSON.stringify({ miraHome: home, sourceDirectory: source })});
      const originalLock = store.lock.bind(store);
      store.lock = async () => {
        process.send('snapshotted');
        await new Promise(resolve => process.once('message', resolve));
        return originalLock();
      };
      try {
        await ${scenario === 'global-aba' ? 'store.setEnabled(true)' : `store.rotate(${JSON.stringify(sender)})`};
        process.send({ result: 'unexpected-success' });
      } catch (error) { process.send({ result: error.code }); }
      process.disconnect();
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: environment(home), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    assert.ok(child.stdout && child.stderr);
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    try {
      assert.equal(await new Promise(resolve => child.once('message', resolve)), 'snapshotted');
      if (scenario === 'global-aba') { await store.setEnabled(true); await store.setEnabled(false); }
      else {
        if (scenario === 'sender-aba') await store.rotate(sender);
        await store.revoke(sender);
      }
      const result = new Promise(resolve => child.once('message', resolve));
      child.send('resume');
      assert.deepEqual(await result, { result: 'external_access_conflict' });
      assert.equal(await exited, 0); assert.equal(output, '');
      if (scenario === 'global-aba') assert.equal((await store.status()).enabled, false);
      else assert.equal((await store.status(sender)).sender?.state, 'revoked');
    } finally { if (child.exitCode === null) child.kill(); }
  }));
}

test('held and orphan locks fail closed; queued rotation cannot overwrite a revocation', async () => fixture(async ({ store, home }) => {
  const created = await store.create(sender); const secret = await token(created); await store.setEnabled(true);
  const lock = path.join(store.externalDirectory, '.access.lock'); await writeFile(lock, 'synthetic held lock', { mode: 0o600 });
  const child = spawn(process.execPath, [cli, 'rotate', '--id', sender], { env: environment(home), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.setEncoding('utf8').on('data', data => { stdout += data; });
  child.stderr.setEncoding('utf8').on('data', data => { stderr += data; });
  const finished = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  // The lock prevents either state from changing while the child starts. Waiting
  // here is only for process startup; both possible late starts still fail safe.
  await delay(200);
  await writeFile(created.sender!.credentialFile, JSON.stringify({ version: 1, id: sender, token: null }));
  // Keep the lock held: a very slow child must fail busy rather than reissue.
  assert.equal(await finished, 1);
  assert.match(stderr, /changed or is busy/); assert.equal(stdout, ''); assert.ok(!stderr.includes(secret));
  assert.equal(await store.authenticate(sender, secret), false);
  assert.equal((await store.status(sender)).sender?.state, 'revoked');
  assert.equal(await readFile(lock, 'utf8'), 'synthetic held lock');
  await unlink(lock);
  assert.equal((await store.status(sender)).sender?.state, 'revoked');
}));

test('CLI validates all arguments before file access and never echoes unknown or secret arguments', async () => fixture(async ({ home, directory }) => {
  const syntheticSecret = 'synthetic-argument-that-must-not-echo';
  const invalid = [
    ['unknown'], ['create'], ['rotate'], ['revoke'], ['enable', '--id', sender], ['disable', '--id', sender],
    ['create', '--id', sender, '--token', syntheticSecret], ['status', '--home'], ['status', '--id', sender, '--id', 'another'],
    ['status', syntheticSecret], ['status', '--home', 'relative'], ['status', '--id', '../escape'], ['--help', syntheticSecret],
  ];
  for (const args of invalid) await assert.rejects(command(home, ...args), error => {
    const result = error as Error & { stdout: string; stderr: string };
    assert.equal(result.stdout, ''); assert.ok(!result.stderr.includes(syntheticSecret)); assert.ok(!result.stderr.includes('stack'));
    return true;
  });
  assert.match((await command(home, '--help')).stdout, /Tokens are never accepted/);
  assert.equal(JSON.parse((await command(home, 'status')).stdout).enabled, false);
  assert.deepEqual(await readdir(directory), ['source']);
}));


test('CLI resolves relative MIRA_HOME like Web startup without creating files for status', async () => fixture(async ({ home, directory, source }) => {
  const result = await execute(process.execPath, [cli, 'status'], {
    cwd: source, env: { ...environment(home), MIRA_HOME: '../home' }, timeout: 8_000,
  });
  assert.deepEqual(JSON.parse(result.stdout), { enabled: false, accessFile: path.join(home, 'external', 'access.json') });
  assert.deepEqual(await readdir(directory), ['source']);
}));

test('CLI excludes configured artifact paths without initializing or running extensions', async () => fixture(async ({ home, directory }) => {
  await mkdir(home, { mode: 0o700 });
  const configFile = path.join(home, 'extensions.json');
  for (const artifactRoot of [home, path.join(home, 'external'), path.join(home, 'external', 'nested')]) {
    await writeFile(configFile, JSON.stringify({ entries: [], artifactsDirectory: artifactRoot }), { mode: 0o600 });
    await assert.rejects(command(home, 'create', '--id', sender));
    assert.deepEqual(await readdir(home), ['extensions.json']);
  }
  await writeFile(configFile, '{ malformed synthetic config');
  await assert.rejects(command(home, 'status'));
  await unlink(configFile);
  const explicitFile = path.join(directory, 'explicit-extensions.json');
  await writeFile(explicitFile, JSON.stringify({ entries: [], artifactsDirectory: home }), { mode: 0o600 });
  await assert.rejects(execute(process.execPath, [cli, 'create', '--id', sender], {
    env: { ...environment(home), MIRA_EXTENSIONS: explicitFile }, timeout: 8_000,
  }));
  assert.deepEqual(await readdir(home), []);
  await assert.rejects(execute(process.execPath, [cli, 'create', '--id', sender], {
    env: { ...environment(home), MIRA_EXTENSIONS: path.join(directory, 'missing-extensions.json') }, timeout: 8_000,
  }));
  assert.deepEqual(await readdir(home), []);
  // Merely configured code is never imported by the management command.
  await writeFile(configFile, JSON.stringify({ entries: [{ id: 'unexecuted', path: '/not/a/real/extension.ts', enabled: true }], artifactsDirectory: path.join(home, 'artifacts') }), { mode: 0o600 });
  assert.equal(JSON.parse((await command(home, 'create', '--id', sender)).stdout).sender.state, 'active');
}));
