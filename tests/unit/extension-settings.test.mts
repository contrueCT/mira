import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, readFile, stat, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ExtensionHost, ExtensionSettingsError, readExtensionConfiguration } from '@mira/extension-host';
import { RegisteredSettings } from '../../packages/extension-host/src/settings.ts';
import { ExtensionPrivateStorage } from '../../packages/extension-host/src/private-storage.ts';
const sdk = import.meta.resolve('@mira/extension-sdk');
async function fixture(run: (host: ExtensionHost, state: any, directory: string, file: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mira-extension-settings-'));
  const file = path.join(directory, 'plugin.mjs');
  await writeFile(file, `import { defineExtension } from ${JSON.stringify(sdk)};
    export const state = { contexts: [], status: {state:'disconnected'}, cleanups:0, starts:0, failCleanup:false, failApply:false, observed:[] };
    export default defineExtension({ name: 'settings', async apply(ctx,config) {
      state.contexts.push(ctx);
      state.observed.push(await ctx.credentials.get('secret'));
      if (state.failApply) throw Error('synthetic-private-apply-error');
      ctx.registerSettings({fields:[{key:'appId',label:'App ID',type:'text'},{key:'secret',label:'Secret',type:'secret'}],
        actions:[{id:'connect',label:'Connect',async execute({signal}) {state.starts++; state.status={state:'connecting'}; await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true})); state.status={state:'disconnected'};}}],
        status:()=>state.status});
      ctx.onCleanup(()=>{state.cleanups++; if(state.failCleanup) throw Error('synthetic-cleanup-error')});
    }});`);
  const { state } = await import(pathToFileURL(file).href);
  await writeFile(path.join(directory,'extensions.json'),JSON.stringify({entries:[{id:'plugin',path:file,config:{appId:'visible-id'}}]}));
  const host = new ExtensionHost({ entries: [{ id:'plugin', path:file, config:{appId:'visible-id'} }], configurationFile:path.join(directory,'extensions.json'), receive:async()=> 'inserted' });
  try { await host.start(); await run(host,state,directory,file); } finally { await host.close(); await rm(directory,{recursive:true,force:true}); }
}
test('private credentials persist, project only configured, merge public config, and fence retired activation',async()=>{
  await fixture(async(host,state,directory)=>{
    const before=await host.extensionSettings('plugin'); assert.ok(before);
    const secret='synthetic-super-private-value';
    await host.saveExtensionSettings('plugin',{expectedRevision:before.revision, values:{appId:'updated'}, secrets:{secret}});
    const after=await host.extensionSettings('plugin'); assert.ok(after);
    assert.equal(after.fields.find(f=>f.key==='secret')?.configured,true);
    assert.equal(after.fields.find(f=>f.key==='appId')?.value,'updated');
    assert.ok(!JSON.stringify(after).includes(secret));
    assert.ok(!(await readFile(path.join(directory,'extensions.json'),'utf8')).includes(secret));
    assert.equal(await state.contexts.at(-1).credentials.get('secret'),secret);
    await assert.rejects(()=>state.contexts[0].credentials.set('secret','late'),/retir|inactive/);
    await assert.rejects(()=>host.saveExtensionSettings('plugin',{expectedRevision:before.revision,values:{},secrets:{secret:null}}),ExtensionSettingsError);
    await host.requestChange('plugin',{action:'disable'});
    assert.equal(await host.extensionSettings('plugin'),null);
    await host.requestChange('plugin',{action:'enable'});
    assert.equal(await state.contexts.at(-1).credentials.get('secret'),secret);
    const current=await host.extensionSettings('plugin'); assert.ok(current);
    await host.saveExtensionSettings('plugin',{expectedRevision:current.revision,values:{},secrets:{secret:null}});
    assert.equal(await state.contexts.at(-1).credentials.get('secret'),null);
  });
});
test('settings actions are single-flight, cancel and lifecycle cleanup abort without leaking errors',async()=>{
  await fixture(async(host,state)=>{
    const view=await host.extensionSettings('plugin'); assert.ok(view);
    const receipt=await host.startSettingsAction('plugin','connect',view.revision);
    assert.ok(receipt.operation); assert.equal(receipt.operation.state,'pending');
    await assert.rejects(()=>host.startSettingsAction('plugin','connect',receipt.revision),ExtensionSettingsError);
    await host.requestChange('plugin',{action:'reload'});
    assert.equal(state.starts,1); assert.equal(state.cleanups,1);
    const next=await host.extensionSettings('plugin'); assert.ok(next); assert.equal(next.operation,null);
    const started=await host.startSettingsAction('plugin','connect',next.revision); assert.ok(started.operation);
    await host.cancelSettingsAction('plugin',started.operation.id);
    await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal((await host.extensionSettings('plugin'))?.operation?.state,'cancelled');
  });
});
test('explicit public status cannot echo a stored credential; uninstall deletes only credential file',async()=>{
  await fixture(async(host,state)=>{
    const ctx=state.contexts.at(-1); await ctx.credentials.set('secret','synthetic-sensitive-credential');
    state.status={state:'error',details:[{label:'Oops',value:'synthetic-sensitive-credential'}]};
    assert.equal((await host.extensionSettings('plugin'))?.status.code,'unknown');
    state.status={state:'disconnected'};
    const data=ctx.privateDirectory; assert.ok(data);
    await writeFile(path.join(data,'ledger.json'),'important private plugin ledger');
    const credentials=path.join(path.dirname(data),'credentials.json'); assert.equal((await stat(credentials)).mode & 0o777,0o600);
    await host.requestChange('plugin',{action:'remove'});
    await assert.rejects(()=>stat(credentials),{code:'ENOENT'});
    assert.equal(await readFile(path.join(data,'ledger.json'),'utf8'),'important private plugin ledger');
  });
});
test('private storage isolates owners, rejects traversal keys and symlink roots',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-store-'));
  try {
    const store=new ExtensionPrivateStorage(path.join(directory,'private'));
    await store.update('one',{token:'synthetic-first-token'},()=>{});
    assert.equal((await store.values('two')).token,undefined);
    await assert.rejects(()=>store.update('one',{'../bad':'no'},()=>{}));
    await symlink(path.join(directory,'private'),path.join(directory,'linked'));
    await assert.rejects(()=>new ExtensionPrivateStorage(path.join(directory,'linked')).values('one'));
    assert.equal((await readdir(path.join(directory,'private'))).length,2);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('escaped credentials cannot leak and prototype names do not count as configured',async()=>{
  await fixture(async(host,state)=>{
    const ctx=state.contexts.at(-1);
    assert.equal(await ctx.credentials.get('toString'),null); assert.equal(await ctx.credentials.has('constructor'),false);
    await assert.rejects(() => ctx.credentials.set('__proto__', 'synthetic-invalid-key'));
    await assert.rejects(() => ctx.credentials.get('__proto__'));
    for (const key of ['constructor', 'toString', 'valueOf']) {
      await ctx.credentials.set(key, 'synthetic-' + key);
      assert.equal(await ctx.credentials.get(key), 'synthetic-' + key);
    }
    const secret='quote"slash\\private-value'; await ctx.credentials.set('secret',secret);
    state.status={state:'pending',details:[{label:'Status',value:secret}]};
    assert.equal((await host.extensionSettings('plugin'))?.status.code,'unknown');
  });
});
test('credential capacity rejects write before corrupting readable storage',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-capacity-'));
  try {
    const store=new ExtensionPrivateStorage(path.join(directory,'private'));
    for(let i=0;i<15;i++) await store.update('owner',{['token'+i]:'x'.repeat(16_384)},()=>{});
    await assert.rejects(()=>store.update('owner',{overflow:'x'.repeat(16_384)},()=>{}),/limit/);
    assert.equal(Object.keys(await store.values('owner')).length,15);
    await store.update('owner',{token0:null},()=>{}); assert.equal(Object.keys(await store.values('owner')).length,14);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('cleanup-failed uninstall still deletes credentials and leaves plugin data',async()=>{
  await fixture(async(host,state)=>{
    const ctx=state.contexts.at(-1); await ctx.credentials.set('secret','synthetic-delete-on-failure');
    const file=path.join(path.dirname(ctx.privateDirectory),'credentials.json');
    state.failCleanup=true;
    const receipt=await host.requestChange('plugin',{action:'remove'});
    assert.equal(receipt.status,'failed'); assert.equal(receipt.persistence,'saved');
    await assert.rejects(()=>stat(file),{code:'ENOENT'});
  });
});
test('runtime credential refresh racing a UI write is not overwritten by stale revision',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-race-'));
  try {
    const store=new ExtensionPrivateStorage(path.join(directory,'private'));
    await store.update('owner',{token:'old-private-token'},()=>{});
    const settings=new RegisteredSettings({fields:[{key:'token',label:'Token',type:'secret'}],actions:[],status:()=>({state:'disconnected'})},'activation','owner',store,()=>null,()=>{},()=>{});
    const view=await settings.view();
    const edit=settings.write({expectedRevision:view.revision,values:{},secrets:{token:'ui-private-token'}});
    const refresh=store.update('owner',{token:'refreshed-private-token'},()=>{});
    await assert.rejects(()=>edit,ExtensionSettingsError); await refresh;
    assert.equal((await store.values('owner')).token,'refreshed-private-token');
  } finally { await rm(directory,{recursive:true,force:true}); }
});
test('uninstall removes recognized crash temporary credentials without removing data',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-temp-'));
  try {
    const store=new ExtensionPrivateStorage(path.join(directory,'private'));
    const owner=await store.prepare('owner');
    const temporary=path.join(owner,'.credentials-12345678-1234-4123-8123-123456789abc.tmp');
    await writeFile(temporary,'synthetic-crash-secret',{mode:0o600});
    await writeFile(path.join(owner,'plugin-note.txt'),'preserve');
    await store.removeCredentials('owner');
    await assert.rejects(()=>stat(temporary),{code:'ENOENT'});
    assert.equal(await readFile(path.join(owner,'plugin-note.txt'),'utf8'),'preserve');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('short credential values do not collide with JSON syntax or block explicit clearing',async()=>{
  await fixture(async(host,state)=>{
    await state.contexts.at(-1).credentials.set('secret','true');
    const view=await host.extensionSettings('plugin'); assert.ok(view);
    assert.equal(view.fields.find(field=>field.key==='secret')?.configured,true);
    await host.saveExtensionSettings('plugin',{expectedRevision:view.revision,values:{},secrets:{secret:null}});
    assert.equal(await state.contexts.at(-1).credentials.get('secret'),null);
  });
});

test('secret-only writes preserve every supported JSON config shape',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-config-'));
  try {
    const store=new ExtensionPrivateStorage(path.join(directory,'private'));
    for(const config of [null,'string',false,3,[],{existing:'value'}]) {
      const settings=new RegisteredSettings({fields:[{key:'token',label:'Token',type:'secret'}],actions:[],status:()=>({state:'disconnected'})},'activation','owner',store,()=>config,()=>{},()=>{});
      const view=await settings.view();
      assert.deepEqual((await settings.write({expectedRevision:view.revision,values:{},secrets:{token:'synthetic-secret-only'}})).config,config);
    }
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('malformed UTF-16 credentials remain clearable and private select values are withheld',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-projection-'));
  try {
    const store=new ExtensionPrivateStorage(path.join(directory,'private'));
    await store.update('owner',{token:'\ud800'},()=>{});
    const fields=[{key:'token',label:'Token',type:'secret' as const},{key:'target',label:'Target',type:'select' as const,options:[{label:'Account',value:'synthetic-option-private'}]}];
    const settings=new RegisteredSettings({fields,actions:[],status:()=>({state:'disconnected'})},'activation','owner',store,()=>null,()=>{},()=>{});
    const before=await settings.view();
    await settings.write({expectedRevision:before.revision,values:{},secrets:{token:'synthetic-option-private'}});
    const after=await settings.view(); assert.ok(!JSON.stringify(after).includes('synthetic-option-private'));
    await settings.write({expectedRevision:after.revision,values:{},secrets:{token:null}});
    assert.equal((await settings.view()).fields.find(field=>field.key==='target')?.type,'select');
    assert.equal(fields[1]?.options?.length,1,'projection does not mutate schema');
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('private root rejects source, Memory, artifact and canonical alias overlap before creating files',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-placement-'));
  try {
    for(const name of ['source','memory','artifacts']) {
      const excluded=path.join(directory,name);
      const store=new ExtensionPrivateStorage(path.join(excluded,'extension-private'),[excluded]);
      await assert.rejects(()=>store.prepare('owner'),/outside/);
      await assert.rejects(()=>stat(excluded),{code:'ENOENT'});
    }
    const source=path.join(directory,'source');
    const {mkdir}=await import('node:fs/promises'); await mkdir(source);
    await symlink(source,path.join(directory,'source-alias'));
    const alias=new ExtensionPrivateStorage(path.join(directory,'source-alias','private'),[source]);
    await assert.rejects(()=>alias.prepare('owner'),/outside/);
    const config=path.join(source,'extensions.json');await writeFile(config,JSON.stringify({entries:[]}));
    const host=new ExtensionHost({entries:[],configurationFile:config,privateStorageExcludedDirectories:[source],receive:async()=> 'inserted'});
    try {await assert.rejects(()=>host.start(),/outside/);}finally{await host.close();}
    await assert.rejects(()=>stat(path.join(source,'extension-private')),{code:'ENOENT'});
  }finally{await rm(directory,{recursive:true,force:true});}
});

test('restart uses the saved installation identity and private credentials without config leakage',async()=>{
  await fixture(async(host,state,directory)=>{
    const ctx=state.contexts.at(-1);await ctx.credentials.set('secret','synthetic-restart-private');
    const originalDirectory=ctx.privateDirectory;
    await host.close();
    const configuration=await readExtensionConfiguration(path.join(directory,'extensions.json'));
    assert.ok(configuration.entries[0]?.installationId);
    const restored=new ExtensionHost({...configuration,receive:async()=> 'inserted'});
    try {await restored.start();assert.equal(state.contexts.at(-1).privateDirectory,originalDirectory);assert.equal(await state.contexts.at(-1).credentials.get('secret'),'synthetic-restart-private');}
    finally{await restored.close();}
  });
});

test('private location guard uses source identity rather than an ordinary launch cwd',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'mira-private-launch-'));
  try {
    const {spawnSync}=await import('node:child_process');
    const script=`import {mkdir,writeFile} from 'node:fs/promises'; import path from 'node:path'; import {ExtensionHost} from ${JSON.stringify(import.meta.resolve('@mira/extension-host'))};
      const home=${JSON.stringify(directory)};process.chdir(home);await mkdir('.mira');const configurationFile=path.join(home,'.mira/extensions.json');await writeFile(configurationFile,JSON.stringify({entries:[]}));
      const host=new ExtensionHost({entries:[],configurationFile,privateStorageExcludedDirectories:[${JSON.stringify(process.cwd())}],receive:async()=> 'inserted'});try{await host.start();}finally{await host.close();}
      const relative=new ExtensionHost({entries:[],configurationFile:'.mira/extensions.json',receive:async()=> 'inserted'});try{await relative.start();}finally{await relative.close();}`;
    const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'});
    assert.equal(child.status,0,child.stderr);
  } finally {await rm(directory,{recursive:true,force:true});}
});


test('UI credential changes reapply initialized clients once, no-ops and runtime refresh do not', async () => {
  await fixture(async (host, state) => {
    const save = async (secrets: Record<string, string | null>, values = {}) => {
      const view = await host.extensionSettings('plugin'); assert.ok(view);
      await host.saveExtensionSettings('plugin', { expectedRevision: view.revision, values, secrets });
    };
    const initial = state.contexts[0];
    assert.deepEqual(state.observed, [null]);
    await save({}); await save({}, {appId:'visible-id'}); await save({secret:null});
    assert.deepEqual(state.observed, [null]);
    await save({secret:'synthetic-first'});
    assert.deepEqual(state.observed, [null, 'synthetic-first']);
    assert.equal(state.cleanups, 1);
    assert.equal(host.changeStatus().at(-1)?.action, 'reload');
    assert.equal(host.changeStatus().at(-1)?.persistence, 'not-required');
    await assert.rejects(() => initial.credentials.set('secret', 'late'));
    await save({secret:'synthetic-first'});
    assert.equal(state.observed.length, 2);
    await save({secret:'synthetic-second'});
    await save({secret:null});
    assert.deepEqual(state.observed, [null, 'synthetic-first', 'synthetic-second', null]);
    await state.contexts.at(-1).credentials.set('secret', 'synthetic-runtime-refresh');
    assert.equal(state.observed.length, 4);
  });
});

test('credential save with failed reapply preserves new credential and reports failure until explicit recovery', async () => {
  await fixture(async (host, state, directory) => {
    const view = await host.extensionSettings('plugin'); assert.ok(view);
    const privateDirectory = state.contexts[0].privateDirectory;
    state.failApply = true;
    await assert.rejects(() => host.saveExtensionSettings('plugin', {expectedRevision:view.revision, values:{}, secrets:{secret:'synthetic-recovery-token'}}), ExtensionSettingsError);
    assert.deepEqual(state.observed, [null, 'synthetic-recovery-token']);
    assert.equal(host.inspect().find(entry => entry.id === 'plugin')?.status, 'failed');
    assert.equal(await host.extensionSettings('plugin'), null);
    assert.equal(host.changeStatus().at(-1)?.status, 'failed');
    assert.equal(host.changeStatus().at(-1)?.persistence, 'not-required');
    assert.equal(JSON.parse(await readFile(path.join(path.dirname(privateDirectory), 'credentials.json'), 'utf8')).secret, 'synthetic-recovery-token');
    assert.ok(!(await readFile(path.join(directory, 'extensions.json'), 'utf8')).includes('synthetic-recovery-token'));
    state.failApply = false;
    assert.equal(state.observed.length, 2); // No rollback or implicit retry.
    const recovered = await host.requestChange('plugin', {action:'reload'});
    assert.equal(recovered.status, 'applied');
    assert.deepEqual(state.observed, [null, 'synthetic-recovery-token', 'synthetic-recovery-token']);
    assert.equal((await host.extensionSettings('plugin'))?.fields.find(field => field.key === 'secret')?.configured, true);
  });
});
