import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { LocalWebService } from '@mira/server';
import { createTestDatabase } from '../integration/database.mts';
import { assistant, streamOf } from './fixtures.mts';

async function until(check: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10_000;
  while (!await check()) { if (Date.now() > end) throw Error('Ownership cleanup did not settle'); await delay(5); }
}
async function terminateOwner(db: Awaited<ReturnType<typeof createTestDatabase>>, id: string) {
  const owners = await db.admin.query(`SELECT l.pid FROM pg_locks l JOIN mira_owners o ON l.objid=o.lock_key::oid
    WHERE l.locktype='advisory' AND l.classid=1296650817::oid AND l.objsubid=2
    AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND o.mira_id=$1`, [id]);
  assert.equal(owners.rows.length, 1);
  assert.equal((await db.admin.query('SELECT pg_terminate_backend($1) AS killed', [owners.rows[0].pid])).rows[0].killed, true);
}
async function fixture() {
  const db = await createTestDatabase(), root = await mkdtemp('/tmp/mira-owner-service-');
  const plugin = path.join(root, 'plugin.mjs'), configurationFile = path.join(root, 'extensions.json');
  await writeFile(plugin, `import { defineExtension } from ${JSON.stringify(import.meta.resolve('@mira/extension-sdk'))};
    export const state = { generations:[], effects:[], cancelled:0 };
    export default defineExtension({ name:'ownership-fixture', apply(ctx) {
      const generation = { ctx, ticks:0, events:0, cleaned:0, action:false, cancelled:false }; state.generations.push(generation);
      ctx.onCleanup(() => { generation.cleaned++; });
      ctx.interval(() => { generation.ticks++; }, 2);
      ctx.onEvent('test', () => { generation.events++; });
      generation.actions = ctx.registerSettings({ fields:[], status:()=>({state:'connected'}), actions:[{
        id:'hold', label:'Hold', async execute({signal}) {
          generation.action=true; await new Promise(resolve => signal.addEventListener('abort',resolve,{once:true})); generation.cancelled=true;
        }
      }] });
      ctx.registerTool({ name:'ownership_effect', description:'Synthetic non-replayable effect', parameters:{type:'object'}, async execute(args,{callId,signal}) {
        state.effects.push(callId); await new Promise(resolve => signal.addEventListener('abort',resolve,{once:true}));
        state.cancelled++; return {text:'remote outcome was not durably committed'};
      } });
    } });`);
  const entries = [{id:'owned',path:plugin,installationId:randomUUID()}];
  await writeFile(configurationFile, JSON.stringify({ entries }));
  const { state } = await import(pathToFileURL(plugin).href);
  const options = { connectionString:db.connectionString, schema:db.schema, miraId:'ownership-service', sourceDirectory:process.cwd(),
    spoolDirectory:path.join(root,'spool'), settingsFile:path.join(root,'settings.json'), workingDirectory:root, miraHome:root,
    synthetic:true, extensions:{ entries, configurationFile } };
  return { db, root, state, options, async close() { await db.close(); await rm(root,{recursive:true,force:true}); } };
}

test('PG owner termination automatically cancels settings and cleans extension resources before explicit service close', {timeout:30_000}, async () => {
  const f = await fixture(); let service: LocalWebService | undefined;
  try {
    service = await LocalWebService.open(f.options);
    await until(async () => (await service!.status()).state === 'idle');
    const old = f.state.generations[0]; await old.ctx.credentials.set('keep', 'synthetic-private-value');
    const view = await service.extensionSettings('owned'); assert.ok(view);
    await service.startExtensionSettingsAction('owned','hold',view.revision);
    await until(() => old.action && old.ticks > 0);
    await terminateOwner(f.db,f.options.miraId);
    await until(() => old.cancelled && old.cleaned === 1);
    assert.equal((await service.status()).state,'stopped');
    await assert.rejects(service.discover({}), error => error instanceof Error && error.message.includes('unavailable'));
    await assert.rejects(service.extensionSettings('owned'));
    await assert.rejects(service.browser.bind(f.options.miraId).open('https://example.com'), /closed/i);
    const ticks = old.ticks; await delay(20); assert.equal(old.ticks,ticks);
    const event = {id:'late',type:'test',occurredAt:new Date().toISOString(),payload:null};
    await assert.rejects(old.ctx.emitEvent(event));
    await assert.rejects(old.ctx.requestWake({id:'late',reason:'late',event}));
    await assert.rejects(old.ctx.credentials.set('keep','stale'));
    await assert.rejects(old.actions.start('hold'));
    assert.throws(() => old.ctx.publish('test',null));
    assert.throws(() => old.ctx.interval(() => {},1));
    assert.equal((await f.db.admin.query('SELECT count(*) FROM life_events')).rows[0].count,'0');
    const replacement = await LocalWebService.open(f.options);
    try { assert.equal(await f.state.generations[1].ctx.credentials.get('keep'),'synthetic-private-value'); }
    finally { await replacement.close(); }
    const closing = service.close(); assert.equal(service.close(),closing); await closing;
    assert.equal(old.cleaned,1);
  } finally { await service?.close(); await f.close(); }
});

test('PG owner termination through service preserves unknown extension effect and never executes the unstarted sibling on takeover', {timeout:30_000}, async () => {
  const f = await fixture(); let service: LocalWebService | undefined, replacement: LocalWebService | undefined; let requests=0, recovery='';
  try {
    const stream: StreamFn = () => { requests++; return streamOf({ ...assistant(), stopReason:'toolUse', content:[
      {type:'toolCall',id:'ownership-first',name:'ownership_effect',arguments:{}},
      {type:'toolCall',id:'ownership-sibling',name:'ownership_effect',arguments:{}}
    ] }); };
    service = await LocalWebService.open({...f.options,syntheticStream:stream});
    await service.submit({id:'effect-input',text:'Run the synthetic effect',occurredAt:new Date().toISOString()});
    await until(() => f.state.effects.length === 1);
    assert.equal((await f.db.admin.query('SELECT count(*) FROM tool_executions WHERE mira_id=$1',[f.options.miraId])).rows[0].count,'1');
    await terminateOwner(f.db,f.options.miraId);
    await until(() => f.state.cancelled === 1 && f.state.generations[0].cleaned === 1);
    const evidence = (await f.db.admin.query('SELECT intent,outcome FROM tool_executions WHERE mira_id=$1',[f.options.miraId])).rows;
    assert.equal(evidence.length,1); assert.equal(evidence[0].outcome,null); assert.equal(requests,1);
    replacement = await LocalWebService.open({...f.options,syntheticStream:(_model,context) => { recovery=JSON.stringify(context.messages); return streamOf(assistant('Inspect the uncertain effect; do not retry.')); }});
    await until(async () => (await replacement!.status()).state === 'idle');
    assert.match(recovery,/no durable outcome|unknown/i);
    assert.deepEqual(f.state.effects,['ownership-first']);
    assert.deepEqual((await f.db.admin.query('SELECT intent,outcome FROM tool_executions WHERE mira_id=$1',[f.options.miraId])).rows,evidence);
    assert.equal(f.state.generations[0].cleaned,1);
  } finally { await replacement?.close(); await service?.close(); await f.close(); }
});

test('actual service owner backend loss cancels an active child model and releases its independent writer', {timeout:30_000}, async () => {
  const f = await fixture(); let service:LocalWebService|undefined, replacement:LocalWebService|undefined; let childStarted=false, childCancelled=false, parentRequests=0;
  try {
    const stream:StreamFn = async (_model,context,options) => {
      const system = getCurrentSystemMessage(context.messages);
      if (system && getSystemMessageText(system).includes('task-scoped worker')) {
        childStarted=true;
        await new Promise<void>(resolve => { if(options?.signal?.aborted) resolve(); else options?.signal?.addEventListener('abort',()=>resolve(),{once:true}); });
        childCancelled=true; return streamOf({...assistant(),stopReason:'aborted',errorMessage:'synthetic cancelled child'});
      }
      parentRequests++;
      if(parentRequests===1) return streamOf({...assistant(),stopReason:'toolUse',content:[{type:'toolCall',id:'owner-spawn',name:'subagent_spawn',arguments:{task:'Wait for ownership cancellation'}}]});
      return streamOf(assistant('Parent continues'));
    };
    service=await LocalWebService.open({...f.options,syntheticStream:stream});
    await service.submit({id:'child-input',text:'Delegate a test',occurredAt:new Date().toISOString()});
    await until(()=>childStarted);
    await terminateOwner(f.db,f.options.miraId);
    await until(()=>childCancelled && f.state.generations[0].cleaned===1);
    // Observe the child writer release before joining/explicitly closing the service.
    await until(async () => (await f.db.admin.query(`SELECT count(*) FROM pg_locks l JOIN mira_owners o ON l.objid=o.lock_key::oid
      WHERE l.locktype='advisory' AND l.classid=1296650817::oid AND l.objsubid=2
      AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND o.mira_id IN (SELECT stream_id FROM subagents)`)).rows[0].count === '0');
    const before=parentRequests;
    replacement=await LocalWebService.open({...f.options,syntheticStream:()=>streamOf(assistant('Recovered without replay'))});
    await until(async()=>(await replacement!.status()).state==='idle');
    assert.equal(parentRequests,before);
    assert.equal((await f.db.admin.query("SELECT count(*) FROM subagent_turns WHERE status='running'")).rows[0].count,'0');
  } finally {await replacement?.close();await service?.close();await f.close();}
});
