import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { ExtensionHost } from '@mira/extension-host';
const directory = await mkdtemp('/tmp/mira-dependent-hmr-');
const sdk = import.meta.resolve('@mira/extension-sdk');
const state = globalThis.dependentHmrState = { version: 0, listeners: 0, trace: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const provider = version => `import { defineExtension } from ${JSON.stringify(sdk)};
export default defineExtension({name:'provider',apply(api){
  const s=globalThis.dependentHmrState; let live=true; s.version=${version};
  api.provideService('ordered',{subscribe(){s.listeners++;return()=>{if(!live)throw Error('provider closed early');s.listeners--;s.trace.push('consumer-${version}')}}});
  api.onCleanup(()=>{live=false;s.trace.push('provider-${version}')});
}});`;
await writeFile(`${directory}/provider.mjs`, provider(1));
await writeFile(`${directory}/consumer.mjs`, `import { defineExtension } from ${JSON.stringify(sdk)};
export default defineExtension({name:'consumer',requires:['ordered'],apply(api){
 const unsubscribe=api.service('ordered').subscribe();
 api.onCleanup(async()=>{await new Promise(resolve=>setTimeout(resolve,15));unsubscribe()});
}});`);
const host = new ExtensionHost({ entries: [{id:'provider',path:`${directory}/provider.mjs`},{id:'consumer',path:`${directory}/consumer.mjs`}], hmr:true, receive:async()=> 'inserted' });
try {
 await host.start(); await host.prepare(); assert.equal(state.listeners,1); await sleep(200);
 await writeFile(`${directory}/provider.mjs`,provider(2));
 const deadline=Date.now()+5000;
 while(host.inspect()[0].status!=='unloading'&&Date.now()<deadline)await sleep(5);
 assert.equal(host.inspect()[0].status,'unloading'); assert.deepEqual(state.trace,[]);
 await host.prepare();
 while(state.version!==2&&Date.now()<deadline)await sleep(5);
 // HMR creates the new fiber after old inertia settles; release/re-read its settled registry.
 await host.finish();
 assert.equal(state.version,2); assert.equal(state.listeners,1);
 assert.deepEqual(state.trace,['consumer-1','provider-1']);
 await Promise.all([host.close(),host.close()]);
 assert.deepEqual(state.trace,['consumer-1','provider-1','consumer-2','provider-2']);
 assert.equal(state.listeners,0);
} finally { await host.close(); await rm(directory,{recursive:true,force:true}); }
console.log('DEPENDENT_HMR_CLEANUP_COMPLETE');
