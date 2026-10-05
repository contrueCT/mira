import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

function pnpm(args: string[], cwd: string): ReturnType<typeof spawnSync> {
  // pnpm test supplies the exact package-manager entry point on every platform.
  const entry = process.env['npm_execpath'];
  assert.ok(entry, 'Run these checks with pnpm test or pnpm check');
  return spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
}

test('pinned pnpm activates strict engine and exact-version settings', () => {
  for (const key of ['engineStrict', 'saveExact']) {
    const result = pnpm(['config', 'get', key], process.cwd());
    assert.equal(result.status, 0, String(result.stderr));
    assert.equal(String(result.stdout).trim(), 'true');
  }
});

test('installation rejects an unsupported Node engine before doing work', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-engine-'));
  try {
    const manifest = JSON.parse(await readFile(path.join(process.cwd(), 'package.json'), 'utf8'));
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'mira-engine-fixture', private: true, packageManager: manifest.packageManager, engines: { node: '>=99' } }));
    await writeFile(path.join(root, 'pnpm-workspace.yaml'), await readFile(path.join(process.cwd(), 'pnpm-workspace.yaml')));
    const result = pnpm(['install', '--offline', '--lockfile-only'], root);
    assert.notEqual(result.status, 0);
    assert.match(String(result.stdout) + String(result.stderr), /ERR_PNPM_UNSUPPORTED_ENGINE/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Pi declaration exception is scoped and source strictness remains inherited', async () => {
  const core = JSON.parse(await readFile('tsconfig.json', 'utf8'));
  const pi = JSON.parse(await readFile('tsconfig.pi.json', 'utf8'));
  const manifest = JSON.parse(await readFile('package.json', 'utf8'));
  assert.equal(core.compilerOptions.skipLibCheck, false);
  assert.equal(pi.extends, './tsconfig.json');
  assert.deepEqual(pi.compilerOptions, { skipLibCheck: true, module: 'ESNext', moduleResolution: 'Bundler' });
  const extensions = JSON.parse(await readFile('tsconfig.extensions.json', 'utf8'));
  assert.deepEqual(extensions.compilerOptions, { module: 'ESNext', moduleResolution: 'Bundler' });
  assert.equal(core.compilerOptions.moduleResolution, 'NodeNext');
  assert.equal(core.compilerOptions.module, 'NodeNext');
  for (const flag of ['strict', 'noUncheckedIndexedAccess', 'exactOptionalPropertyTypes']) assert.equal(core.compilerOptions[flag], true);
  assert.ok(core.exclude.includes('packages/runtime-pi'));
  assert.ok(pi.include.includes('packages/runtime-pi/**/*.ts'));
  assert.ok(pi.include.includes('tests/unit/runtime.test.mts'));
  assert.ok(pi.include.includes('tests/recovery/**/*.mts'));
  assert.match(manifest.scripts.typecheck, /tsc --noEmit && tsc --noEmit -p tsconfig.pi.json/);
});

test('CI explicitly suppresses dependency install scripts without broadening build permission', async () => {
  assert.match(await readFile('.github/workflows/ci.yml', 'utf8'), /pnpm install --frozen-lockfile --ignore-scripts/);
  assert.match(await readFile('pnpm-workspace.yaml', 'utf8'), /allowBuilds: \{\}/);
});
