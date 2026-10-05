import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/official-hmr-probe.mjs', import.meta.url));
const scenarios = [
  ['esm-source-and-transitive', 'official HMR replaces actual source and transitive ESM modules, cleaning timers and listeners'],
  ['esm-imported-cjs', 'official HMR invalidates a transitive CJS module imported through the ESM graph'],
  ['cjs-require-limit', 'official HMR does not claim to track nested CommonJS require edges'],
  ['watch-gate-and-async-cleanup', 'official watch callback gates reload; ungrouped native resources disappear before async disposal completes'],
  ['grouped-resource-lease', 'official generator effects defer service, timer and listener cleanup until a lease releases'],
  ['import-vs-apply-failure', 'official import failures retain the old plugin, while apply failures clean up without atomic rollback'],
] as const;

for (const [scenario, description] of scenarios) {
  test(description, { timeout: 20_000 }, async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'mira-hmr-test-'));
    try {
      const env: NodeJS.ProcessEnv = {
        PATH: process.env['PATH'], HOME: home, TMPDIR: home,
        XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home,
        NODE_OPTIONS: `--import=${fileURLToPath(new URL('../deny-model-network.mts', import.meta.url))}`,
      };
      const child = spawn(process.execPath, ['--expose-internals', fixture, scenario], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 15_000);
      let status: { code: number | null; signal: NodeJS.Signals | null };
      try {
        status = await new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve({ code, signal }));
        });
      } finally { clearTimeout(timeout); }
      assert.equal(status.signal, null, `${scenario}: child interrupted\n${stdout}\n${stderr}`);
      assert.equal(status.code, 0, `${scenario}: child failed\n${stdout}\n${stderr}`);
      const records = stdout.split('\n').filter((line) => line.startsWith('MIRA_OFFICIAL_HMR_RESULT:'));
      assert.equal(records.length, 1, `${scenario}: exit without completed assertions is not a successful HMR test\n${stdout}\n${stderr}`);
      const result = JSON.parse(records[0]!.slice('MIRA_OFFICIAL_HMR_RESULT:'.length)) as { scenario: string; sourceHmr: boolean };
      assert.equal(result.scenario, scenario);
      assert.equal(result.sourceHmr, true);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
}
