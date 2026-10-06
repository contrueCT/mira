import path from 'node:path';
import { ArtifactStore } from '@mira/extension-host/artifacts';

const usage = [
  'Usage:',
  '  node scripts/extension-artifact.mts stage <artifact-store> <workspace> <entry-relative> [expected-sha256]',
  '  node scripts/extension-artifact.mts status <artifact-store> [sha256]',
  '  node scripts/extension-artifact.mts test <artifact-store> <sha256> -- <command> [arguments...]',
  'Staging is file-only. Testing runs the explicit command on this OS host in a fresh copy.',
].join('\n');
async function main(): Promise<void> {
  const [action, directory, ...args] = process.argv.slice(2);
  if (!directory || !action || !['stage', 'status', 'test'].includes(action)) throw new Error(usage);
  const store = new ArtifactStore(path.resolve(directory));
  let result: unknown;
  if (action === 'stage') {
    if (args.length < 2 || args.length > 3) throw new Error(usage);
    result = await store.stage(path.resolve(args[0]!), args[1]!, args[2]);
  } else if (action === 'status') {
    if (args.length > 1) throw new Error(usage);
    const artifacts = args[0] ? [await store.read(args[0])] : await store.list();
    result = await Promise.all(artifacts.map(async artifact => ({ ...artifact, test: await store.testResult(artifact) ?? null })));
  } else {
    if (args.length < 3 || args[1] !== '--') throw new Error(usage);
    const receipt = await store.test(await store.read(args[0]!), { command: args[2]!, args: args.slice(3) });
    result = receipt;
    if (!receipt.passed) process.exitCode = 1;
  }
  console.log(JSON.stringify(result, null, 2));
}
try { await main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
