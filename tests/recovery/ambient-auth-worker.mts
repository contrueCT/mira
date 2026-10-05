import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { SimpleStreamOptions } from '@earendil-works/pi-ai';

// This child receives ONLY a synthetic environment. Detect even unsuccessful
// ambient auth-file probes; SDK catches some auth errors before invoking streams.
const home = process.env['HOME']; assert(home);
const fileAttempts: string[] = [];
for (const target of [fs, fsPromises]) for (const name of ['readFile', 'readFileSync', 'existsSync', 'stat', 'statSync', 'access', 'accessSync', 'open', 'openSync']) {
  const object = target as unknown as Record<string, unknown>;
  const original = object[name]; if (typeof original !== 'function') continue;
  object[name] = function (...args: unknown[]) {
    const path = args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0]);
    if (path.startsWith(home!)) { fileAttempts.push(path); throw new Error('Synthetic ambient auth-file tripwire'); }
    return Reflect.apply(original, target, args);
  };
}
syncBuiltinESMExports();
const { model, assistant, streamOf, MemoryWriter, runtime, seed, compactionMessages } = await import('./fixtures.mts');
const checks: Array<{ provider: string; requests: number }> = [];
for (const provider of ['openai', 'anthropic', 'amazon-bedrock', 'google-vertex']) {
  const writer = new MemoryWriter(); await seed(writer, compactionMessages());
  const before = structuredClone(writer.state.records);
  const selectedModel = { ...model, provider };
  const requests: Array<{ selected: unknown; options: SimpleStreamOptions | undefined }> = [];
  const compacted = await runtime(writer, (selected, _context, options) => {
    requests.push({ selected: structuredClone(selected), options });
    return streamOf({ ...assistant('Synthetic recognized-provider summary'), provider });
  }, { model: selectedModel }).compact({ keepRecentTokens: 1 });
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.deepEqual(request.selected, selectedModel);
    assert.equal(request.options?.apiKey, undefined);
    assert.equal(request.options?.headers, undefined);
    assert.equal(request.options?.env, undefined);
  }
  assert.equal(compacted.entries.at(-1)?.type, 'compaction');
  assert.deepEqual(compacted.snapshot.records.slice(0, before.length), before);
  assert.deepEqual(compacted.messages.slice(2), compactionMessages().slice(4));
  assert.ok(!JSON.stringify(compacted.snapshot).includes('mira-injected-compaction-'));
  assert.ok(!JSON.stringify(compacted.snapshot).includes('synthetic-ambient-key'));
  checks.push({ provider, requests: requests.length });
}
assert.deepEqual(fileAttempts, []);
process.stdout.write(JSON.stringify({ checks, fileAttempts }));
