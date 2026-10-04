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
