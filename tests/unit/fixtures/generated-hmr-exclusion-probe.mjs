import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArtifactStore, ExtensionHost } from '@mira/extension-host';

const sdk = import.meta.resolve('@mira/extension-sdk');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
for (const alias of [false, true]) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-generated-hmr-'));
  const manual = path.join(root, 'manual'); const source = path.join(root, 'source');
  const canonicalStore = path.join(manual, '[artifact*store]');
  const storePath = alias ? path.join(root, 'store-alias') : canonicalStore;
  const state = globalThis.generatedHmrProbe = { entries: [] };
  let host;
  try {
    await mkdir(manual); await mkdir(source); await mkdir(canonicalStore);
    if (alias) await symlink(canonicalStore, storePath);
    const manualEntry = path.join(manual, 'manual.mjs');
    const manualSource = version => `import { defineExtension } from ${JSON.stringify(sdk)};
      export default defineExtension({name:'manual', apply(ctx) { ctx.registerTool({name:'manual_echo',description:'Manual test',parameters:{type:'object'},async execute(){return {text:${JSON.stringify(version)}};}}); }});`;
    await writeFile(manualEntry, manualSource('manual-one'));
    await writeFile(path.join(source, 'package.json'), '{"type":"module"}');
    await mkdir(path.join(source, 'node_modules/@mira'), {recursive:true});
    await symlink(fileURLToPath(new URL('../../../packages/extension-sdk/', import.meta.url)), path.join(source, 'node_modules/@mira/extension-sdk'));
    await writeFile(path.join(source,'helper.mjs'), "export const value = 'one';");
    await writeFile(path.join(source,'entry.mjs'), `import {defineExtension} from '@mira/extension-sdk'; import {value} from './helper.mjs';
      globalThis.generatedHmrProbe.entries.push(import.meta.url);
      export default defineExtension({name:'generated',apply(ctx){ctx.registerTool({name:'generated_echo',description:'Generated test',parameters:{type:'object'},async execute(){return{text:value}}});}});`);
    const store = new ArtifactStore(storePath); const artifact = await store.stage(source,'entry.mjs');
    host = new ExtensionHost({entries:[{id:'manual',path:manualEntry}],artifactsDirectory:storePath,hmr:true,receive:async()=> 'inserted'});
    await host.start(); await host.requestChange('generated',{action:'install',digest:artifact.digest}); await host.finish();
    await host.requestChange('generated',{action:'activate'}); let tools = await host.prepare();
    const generated = tools.find(item=>item.tool.name==='generated_echo'); assert.ok(generated);
    const originalActivation = generated.activation;
    const execute = async tool => (await tool.tool.execute(null,{callId:'hmr-test',signal:new AbortController().signal})).text;
    assert.equal(await execute(generated),'one'); await host.finish();
    await sleep(350);
    await writeFile(fileURLToPath(new URL('./helper.mjs',state.entries[0])),"export const value = 'changed-without-new-digest';");
    await writeFile(manualEntry,manualSource('manual-two'));
    const deadline = Date.now()+5000;
    do {
      await sleep(30); tools=await host.prepare();
      if (await execute(tools.find(item=>item.tool.name==='manual_echo'))==='manual-two') break;
      await host.finish();
    } while(Date.now()<deadline);
    assert.equal(await execute(tools.find(item=>item.tool.name==='manual_echo')),'manual-two','manual HMR must still work');
    await host.finish(); await sleep(250); tools=await host.prepare();
    const after=tools.find(item=>item.tool.name==='generated_echo');
    assert.equal(await execute(after),'one'); assert.equal(after.activation,originalActivation); assert.equal(after.digest,artifact.digest);
    assert.equal(state.entries.length,1,'generated code must not be reimported by the manual watcher');
    await store.verify(artifact);
    if (alias) {
      const movedStore = new ArtifactStore(path.join(manual,'retargeted-store'));
      const moved = await movedStore.stage(source,'entry.mjs');
      await rm(storePath); await symlink(movedStore.root,storePath);
      const requested = await host.requestChange('generated',{action:'update',digest:moved.digest});
      tools=await host.prepare();
      const receipt=host.changeStatus().find(item=>item.id===requested.id);
      assert.equal(receipt.status,'failed'); assert.match(receipt.error,/Artifact store path changed/);
      assert.equal(tools.find(item=>item.tool.name==='generated_echo').activation,originalActivation);
    }
  } finally { await host?.close(); await rm(root,{recursive:true,force:true}); }
}
console.log('GENERATED_HMR_EXCLUSION_COMPLETE');
