import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { ExtensionHost } from '@mira/extension-host';
import { createToolset } from '../../packages/extension-host/src/toolsets.ts';
import type { ExtensionTool } from '@mira/extension-sdk';
const tool = (name: string): ExtensionTool => ({ name, description: name, parameters: { type: 'object' }, execute: async () => ({ text: name }) });
test('toolset replacement validates all candidates, collisions and snapshots before atomic publish', () => {
  const registry = new Map<string, { tool: ExtensionTool }>();
  let alive = true; let cleanup: (() => void) | undefined;
  const set = createToolset({ registry, reserved: new Set(['core']), assertActive: () => { if (!alive) throw Error('retired'); }, wrap: tool => ({ tool }), cleanup: callback => { cleanup = callback; } }, [tool('old')]);
  const original = registry.get('old');
  for (const candidate of [[tool('next'), tool('core')], [tool('next'), tool('next')], [tool('valid'), { ...tool('bad'), parameters: { type: 'array' as 'object' } }]]) {
    assert.throws(() => set.replace(candidate)); assert.equal(registry.get('old'), original); assert.equal(registry.size, 1);
  }
  registry.set('other', { tool: tool('other') }); assert.throws(() => set.replace([tool('other')]));
  const mutable = tool('next'); set.replace([mutable]); mutable.parameters.properties = { mutated: { type: 'string' } };
  assert.equal(registry.get('next')?.tool.parameters.properties, undefined);
  assert.equal(registry.has('old'), false);
  alive = false; assert.throws(() => set.replace([])); assert.ok(registry.has('next'));
  cleanup?.(); assert.equal(registry.has('next'), false); assert.equal(registry.has('other'), true);
});
test('real Host retains begun revision, fences unbegun snapshots and atomically changes schema', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-toolset-'));
  const file = path.join(root, 'plugin.mts');
  await writeFile(file, `export let replace, release; export let began = false;
export default { name:'dynamic', apply({mira:ctx}) {
 const old = {name:'dynamic_tool', description:'old', parameters:{type:'object', properties:{old:{type:'string'}}}, execute:async()=>{began=true; await new Promise(resolve=>release=resolve); return {text:'old result'};}};
 const set=ctx.registerToolset([old]);
 replace=()=>set.replace([{name:'dynamic_tool',description:'new',parameters:{type:'object',properties:{next:{type:'number'}}},execute:async()=>({text:'new result'})}]);
}};`);
  const module = await import(pathToFileURL(file).href);
  const host = new ExtensionHost({ entries: [{ id: 'dynamic', path: file }], receive: async () => 'inserted' });
  try {
    await host.start();
    const first = (await host.prepare())[0]!;
    const pending = first.tool.execute({}, { callId: 'begun', signal: new AbortController().signal });
    assert.equal(module.began, true);
    module.replace();
    const stale = await first.tool.execute({}, { callId: 'stale', signal: new AbortController().signal });
    assert.equal(stale.isError, true); assert.equal((stale.details as {executed:boolean}).executed, false);
    const next = (await host.prepare())[0]!;
    assert.notEqual(next.toolRevision, first.toolRevision); assert.equal(next.activation, first.activation);
    assert.deepEqual(next.tool.parameters.properties, { next: { type: 'number' } });
    assert.equal((await next.tool.execute({}, { callId: 'new', signal: new AbortController().signal })).text, 'new result');
    module.release(); assert.equal((await pending).text, 'old result');
    await host.requestChange('dynamic', { action: 'disable' }); assert.throws(() => module.replace());
  } finally { module.release?.(); await host.close(); await rm(root, { recursive: true, force: true }); }
});
