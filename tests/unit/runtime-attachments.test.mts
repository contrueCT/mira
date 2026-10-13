import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { validateAttachmentReferences, type AttachmentReference } from '@mira/cognition';
import { hydrateAttachments } from '../../packages/runtime-pi/src/attachments.ts';
import { encodeEntry, messageEntry, PiDurableRuntime, jsonValue } from '@mira/runtime-pi';
import type { UserMessage, ToolResultMessage, Model, Api } from '@earendil-works/pi-ai';
import { model, assistant, streamOf, MemoryWriter } from '../recovery/fixtures.mts';
const input = (text = 'hello'): UserMessage => ({role:'user',content:text,timestamp:1000});
const bytes = Buffer.from('synthetic image bytes');
function ref(mimeType = 'image/png'): AttachmentReference { return { id:randomUUID(), name:'test.png', mimeType, size:bytes.length, sha256:createHash('sha256').update(bytes).digest('hex'), path:'/private/immutable/test' }; }
const signal = new AbortController().signal;
test('native images hydrate from stable refs in order but are never stored as base64', async () => {
  const first=ref(),second=ref(); const writer=new MemoryWriter(); let calls=0;
  const runtime=new PiDurableRuntime({writer,model:{...model,contextWindow:65536,input:['text','image']},resolveAttachment:async r=>{assert.ok([first.id,second.id].includes(r.id));return bytes;},streamFn:(_m,context)=>{
    calls++;const user=context.messages.find(m=>m.role==='user'); assert.ok(user?.role==='user' && Array.isArray(user.content));
    assert.deepEqual(user.content.filter(b=>b.type==='image').map(b=>b.data),[bytes.toString('base64'),bytes.toString('base64')]);
    assert.ok(JSON.stringify(user).indexOf(first.id)<JSON.stringify(user).indexOf(second.id));
    return streamOf(assistant('seen'));
  }});
  await runtime.run(Object.assign(input('look'),{miraAttachments:[first,second]}));
  assert.equal(calls,1); assert.ok(!JSON.stringify(writer.state.records).includes(bytes.toString('base64')));
  const recovered=await new PiDurableRuntime({writer,model,streamFn:()=>streamOf(assistant())}).recover();
  assert.ok(JSON.stringify(recovered.messages).includes(first.sha256));
});
test('video arrival is file-only for every model; only explicit read results may carry native video', async()=>{
  const video=ref('video/mp4'),doc=ref('application/pdf'); let reads=0;
  const message=Object.assign(input('video'),{miraAttachments:[video,doc]});
  const google: Model<Api>={...model,provider:'google',api:'google-generative-ai',id:'gemini-2.5-flash'};
  for(const selected of [google,model]) {
    const hydrated=await hydrateAttachments([message],selected,async()=>{reads++;return bytes;},signal);
    assert.equal(reads,0);assert.ok(!JSON.stringify(hydrated).includes('miraNativeVideos'));assert.ok(JSON.stringify(hydrated).includes(video.path));
  }
  const read:ToolResultMessage={role:'toolResult',toolCallId:'video-read',toolName:'read',content:[{type:'text',text:'Video read requested'}],timestamp:1000,isError:false,details:jsonValue({version:1,type:'attachment-read',attachments:[video]})};
  const native=await hydrateAttachments([read],google,async()=>{reads++;return bytes;},signal);
  assert.equal(reads,1);assert.ok(JSON.stringify(native).includes('miraNativeVideos'));
  assert.throws(()=>encodeEntry(messageEntry(native[0]!,null)),/never be persisted/);
  const unsupported=await hydrateAttachments([read],model,undefined,signal);
  assert.match(JSON.stringify(unsupported),/NOT provided/);assert.ok(!JSON.stringify(unsupported).includes('miraNativeVideos'));
});
test('invalid reference metadata, corrupted bytes and request-size overflows fail before provider', async()=>{
 const reference=ref();assert.throws(()=>validateAttachmentReferences([{...reference,path:'relative'}]));
 assert.throws(()=>encodeEntry(messageEntry(Object.assign(assistant(),{miraAttachments:[reference]}),null)),/require a user/);
 await assert.rejects(hydrateAttachments([Object.assign(input(),{miraAttachments:[reference]})],{...model,input:['image']},async()=>Buffer.from('changed'),signal),/differ/);
 const huge={...reference,size:13*1024*1024}; const over=await hydrateAttachments([Object.assign(input(),{miraAttachments:[huge]})],{...model,input:['image']},async()=>{throw Error('must not read');},signal);assert.match(JSON.stringify(over),/bytes were NOT provided/);
});
test('repeated compaction preserves immutable references even when summary model omits them',async()=>{
 const writer=new MemoryWriter(); const reference=ref();
 const {seed}=await import('../recovery/fixtures.mts');
 await seed(writer,[Object.assign(input('old image'),{miraAttachments:[reference]}),assistant('old response'),input('recent tail')]);
 for(let i=0;i<2;i++) {
  const runtime=new PiDurableRuntime({writer,model:{...model,contextWindow:65536},autoCompaction:{enabled:false},streamFn:()=>streamOf(assistant('Summary deliberately omits the image identity.'))});
  if(i) await runtime.run(input('new material before second compaction'));
  const state=await runtime.compact({keepRecentTokens:1});
  const checkpoints=state.entries.filter(e=>e.type==='compaction');
  assert.ok(checkpoints.at(-1)?.summary.includes(i ? checkpoints.at(-2)!.id : writer.state.records[0]!.id));assert.ok(checkpoints.at(-1)?.summary.includes('history_read'));
 }
 const restored=await new PiDurableRuntime({writer,model,streamFn:()=>streamOf(assistant())}).recover();
 assert.ok(JSON.stringify(restored.entries).includes(reference.sha256));
});

test('oversized historical video cannot suppress native understanding of a new smaller image',async()=>{
 const old={...ref('video/mp4'),size:13*1024*1024};const recent=ref();const google:Model<Api>={...model,provider:'google',api:'google-generative-ai',id:'gemini-2.5-flash',input:['text','image']};
 let reads=0;const hydrated=await hydrateAttachments([Object.assign(input('old'),{miraAttachments:[old]}),Object.assign(input('new'),{miraAttachments:[recent]})],google,async reference=>{reads++;assert.equal(reference.id,recent.id);return bytes;},signal);
 assert.equal(reads,1);assert.ok(!JSON.stringify(hydrated[0]).includes('miraNativeVideos')); assert.ok(JSON.stringify(hydrated[1]).includes(bytes.toString('base64')));
});

test('overflow document references remain spooled and request-local projection is fully budgeted',async()=>{
 const {prepareWakeTurn}=await import('@mira/life');const {estimateRequestTokens}=await import('../../packages/runtime-pi/src/budget.ts');
 const requests=Array.from({length:20},(_,index)=>({eventId:randomUUID(),event:{id:`many-${index}`,type:'web.message',source:'user' as const,occurredAt:'2026-10-13T00:00:00.000Z',payload:{text:'documents',attachments:Array.from({length:10},()=>({...ref('application/pdf'),path:'/immutable/'+ 'nested/'.repeat(20)+'document'}))}},wake:{id:`wake-${index}`,reason:'User message from the local web interface'}}));
 const turn=await prepareWakeTurn({id:'batch',claimedAt:'2026-10-13T00:00:00.000Z',status:'running',requests,inputRecordId:null,finalRecordId:null},async()=>({path:'/spool/batch.txt',bytes:100000}),100);
 const message=Object.assign(input(turn.input),{miraAttachments:turn.attachments,miraAttachmentsInInput:true});
 const projected=await hydrateAttachments([message],model,()=>{throw Error('documents must not be read automatically');},signal);
 assert.ok(JSON.stringify(projected).length<2000);assert.ok(!JSON.stringify(projected).includes('/immutable/'));assert.ok(estimateRequestTokens([message],[],model)<1000);
 const direct=Object.assign(input('manual refs'),{miraAttachments:[ref('application/pdf')]});const actual=await hydrateAttachments([direct],model,undefined,signal);
 assert.ok(estimateRequestTokens([direct],[],model)>=estimateRequestTokens(actual));
});

test('attachment source indexes remain bounded across repeated compaction and chain back to original IDs',async()=>{
 const writer=new MemoryWriter();const {seed}=await import('../recovery/fixtures.mts');let previous:string|undefined;
 await seed(writer,[Object.assign(input('first refs'),{miraAttachments:[ref('application/pdf')]}),assistant('reply'),input('tail')]);
 const original=writer.state.records[0]!.id;
 for(let i=0;i<8;i++) {
  const runtime=new PiDurableRuntime({writer,model:{...model,contextWindow:65536},autoCompaction:{enabled:false},streamFn:()=>streamOf(assistant('Omit all old pointers in synthetic summary.'))});
  if(i) await runtime.run(Object.assign(input(`new docs ${i}`),{miraAttachments:[ref('application/pdf')]}));
  const state=await runtime.compact({keepRecentTokens:1});const checkpoint=state.entries.findLast(entry=>entry.type==='compaction')!;assert.equal(checkpoint.type,'compaction');
  assert.ok(checkpoint.summary.includes(previous??original));assert.ok(checkpoint.summary.length<1300);previous=checkpoint.id;
 }
 const records=new Map(writer.state.records.map(record=>[record.id,record]));let id=previous!;let traversed=0;
 while(id!==original) {const record=records.get(id)!;assert.ok(record);const entry=record.payload as {type:string;summary?:string};if(entry.type!=='compaction')break;const match=entry.summary!.match(/checkpoint History ID "([a-f0-9-]+)"/)??entry.summary!.match(/History ID "([a-f0-9-]+)"/);assert.ok(match);id=match[1]!;assert.ok(++traversed<10);}
 assert.equal(id,original);assert.equal(traversed,8);
});
