import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { resizeImage } from '@earendil-works/pi-coding-agent';
import { normalizeContext } from '@earendil-works/pi-ai';
import { createModelTransport } from '../../apps/server/src/model-transport.ts';
import { createHash, randomUUID } from 'node:crypto';
import { validateAttachmentReferences, type AttachmentReference } from '@mira/cognition';
import { hydrateAttachments } from '../../packages/runtime-pi/src/attachments.ts';
import { encodeEntry, messageEntry, PiDurableRuntime, jsonValue } from '@mira/runtime-pi';
import type { UserMessage, ToolResultMessage, Model, Api } from '@earendil-works/pi-ai';
import { model, assistant, streamOf, MemoryWriter } from '../recovery/fixtures.mts';
const input = (text = 'hello'): UserMessage => ({role:'user',content:text,timestamp:1000});
// Real RGBA PNGs with correct CRCs exercise the actual Pi raster decoder.
function png(width: number, height: number): Buffer {
  const chunk = (name: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(name),data]); let crc = 0xffffffff;
    for (const byte of body) { crc ^= byte; for (let bit=0;bit<8;bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const out = Buffer.alloc(data.length+12); out.writeUInt32BE(data.length); body.copy(out,4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0,out.length-4); return out;
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height,4); header[8]=8; header[9]=6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.alloc((width*4+1)*height))),chunk('IEND',Buffer.alloc(0))]);
}
const bytes = png(1,1);
function referenceFor(data: Buffer, mimeType = 'image/png'): AttachmentReference { return {...ref(mimeType),size:data.length,sha256:createHash('sha256').update(data).digest('hex')}; }
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
test('ordinary Pi image results reserve the same byte budget before native video tool hydration',async()=>{
 const google:Model<Api>={...model,provider:'google',api:'google-generative-ai',id:'gemini-2.5-flash',input:['text','image']};
 const image:ToolResultMessage={role:'toolResult',toolCallId:'ordinary-image',toolName:'read',content:[{type:'image',mimeType:'image/png',data:Buffer.alloc(6*1024*1024).toString('base64')}],timestamp:1000,isError:false};
 const video={...ref('video/mp4'),size:7*1024*1024};
 const read:ToolResultMessage={role:'toolResult',toolCallId:'video',toolName:'read',content:[{type:'text',text:'explicit video read'}],timestamp:1001,isError:false,details:jsonValue({version:1,type:'attachment-read',attachments:[video]})};
 const output=await hydrateAttachments([image,read],google,()=>{throw Error('over-budget video must not be read');},signal);
 assert.match(JSON.stringify(output[1]),/bytes were NOT provided/);assert.ok(!JSON.stringify(output[1]).includes('miraNativeVideos'));
 assert.deepEqual(output[0],image);
});

test('large valid PNG is resized request-only and reaches the actual Anthropic SDK wire as a native image',async()=>{
 const original=png(9000,10);const reference=referenceFor(original);const before=Buffer.from(original);let body:Record<string,unknown>|undefined;
 const selected=createModelTransport({builtinCredentials:{anthropic:{apiKeyEnv:'SYNTHETIC_ANTHROPIC'}},customConnections:[]},{kind:'builtin',provider:'anthropic',model:'claude-sonnet-4-5'},{env:()=> 'synthetic-api-key',fetch:async(_url,init)=>{
   body=JSON.parse(String(init?.body)) as Record<string,unknown>;
   const events=[{type:'message_start',message:{id:'fixture',type:'message',role:'assistant',content:[],model:'claude-sonnet-4-5',stop_reason:null,stop_sequence:null,usage:{input_tokens:20,output_tokens:0}}},{type:'content_block_start',index:0,content_block:{type:'text',text:''}},{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Synthetic answer'}},{type:'content_block_stop',index:0},{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:3}},{type:'message_stop'}];
   return new Response(events.map(event=>`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
 }});
 const source=Object.assign(input('inspect'),{miraAttachments:[reference]});const frozen=structuredClone(source);
 const hydrated=await hydrateAttachments([source],selected.model,async()=>original,signal);
 const response=await(await selected.streamFn(selected.model,normalizeContext({messages:hydrated}),{maxTokens:100})).result();
 assert.equal(response.stopReason,'stop',response.errorMessage);assert.ok(body);
 const contents=(body['messages'] as Array<{content:Array<{type:string;source?:{type:string;media_type:string;data:string};text?:string}>}>)[0]!.content;
 const native=contents.find(part=>part.type==='image')!;assert.ok(native?.source);assert.equal(native.source.type,'base64');assert.equal(native.source.media_type,'image/png');
 const wire=Buffer.from(native.source.data,'base64');assert.equal(wire.readUInt32BE(16),2000);assert.equal(wire.readUInt32BE(20),2);
 assert.ok(native.source.data.length<=selected.model.inputLimits!.images!.resize!.maxBytes!);assert.match(JSON.stringify(contents),/original 9000x10, displayed at 2000x2/);
 assert.deepEqual(original,before);assert.deepEqual(source,frozen);assert.match(JSON.stringify(hydrated),new RegExp(reference.sha256));
 const {estimateRequestTokens}=await import('../../packages/runtime-pi/src/budget.ts');assert.ok(estimateRequestTokens([source],[],selected.model)>=estimateRequestTokens(hydrated));
 const restarted=await hydrateAttachments([structuredClone(source)],selected.model,async()=>Buffer.from(original),signal);assert.deepEqual(restarted,hydrated);
});

test('image decoder failure omits bytes honestly without changing refs or failing later requests',async()=>{
 const corrupt=Buffer.from('not a decodable image');const reference=referenceFor(corrupt);const source=Object.assign(input(),{miraAttachments:[reference]});
 const hydrated=await hydrateAttachments([source],{...model,input:['image']},async()=>corrupt,signal);
 assert.match(JSON.stringify(hydrated),/image bytes were NOT provided because safe image preparation failed/);assert.ok(!JSON.stringify(hydrated).includes('"type":"image"'));assert.match(JSON.stringify(hydrated),new RegExp(reference.sha256));
 const later=Object.assign(input('later valid image'),{miraAttachments:[ref()]});
 const repeated=await hydrateAttachments([source,later],{...model,input:['image']},async item=>item.id===reference.id?corrupt:bytes,signal);
 assert.ok(JSON.stringify(repeated[1]).includes(bytes.toString('base64')));
 const {estimateRequestTokens}=await import('../../packages/runtime-pi/src/budget.ts');assert.ok(estimateRequestTokens([source],[],{...model,input:['image']})>=estimateRequestTokens(hydrated));
});

test('model registry image count limits reserve existing images and keep whole newest groups',async()=>{
 const selected={...model,input:['image'] as ['image'],inputLimits:{images:{maxPerMessage:1,maxPerRequest:2}}};
 const existing=input();existing.content=[{type:'image',mimeType:'image/png',data:bytes.toString('base64')}];
 const old=Object.assign(input('old'),{miraAttachments:[ref()]});const newest=Object.assign(input('new'),{miraAttachments:[ref()]});let reads=0;
 const hydrated=await hydrateAttachments([existing,old,newest],selected,async()=>{reads++;return bytes;},signal);
 assert.equal(reads,1);assert.match(JSON.stringify(hydrated[1]),/image-count limits/);assert.ok(JSON.stringify(hydrated[2]).includes(bytes.toString('base64')));
 const group=Object.assign(input('group of two'),{miraAttachments:[ref(),ref()]});
 const skipped=await hydrateAttachments([group],selected,()=>{throw Error('over-count group must not resolve');},signal);assert.match(JSON.stringify(skipped),/image-count limits/);
 const mixed=Object.assign(structuredClone(existing),{miraAttachments:[ref()]});
 assert.match(JSON.stringify(await hydrateAttachments([mixed],selected,()=>{throw Error('existing image reserves per-message slot');},signal)),/image-count limits/);
});

test('post-resize byte growth is bounded in deterministic newest-first order',async()=>{
 const original=png(2001,1);const resized=await resizeImage(original,'image/png');assert.ok(resized);
 const outputBytes=Buffer.byteLength(resized.data,'base64');assert.ok(outputBytes>original.length,'fixture must expand during safe normalization');
 const remaining=outputBytes+original.length-1;
 const existing:ToolResultMessage={role:'toolResult',toolCallId:'image',toolName:'read',isError:false,timestamp:1,content:[{type:'image',mimeType:'image/png',data:Buffer.alloc(12*1024*1024-remaining).toString('base64')}]};
 const old=Object.assign(input('old'),{miraAttachments:[referenceFor(original)]});const newest=Object.assign(input('new'),{miraAttachments:[referenceFor(original)]});const order:string[]=[];
 const hydrated=await hydrateAttachments([existing,old,newest],{...model,input:['image']},async item=>{order.push(item.id);return original;},signal);
 assert.deepEqual(order,[newest.miraAttachments[0]!.id,old.miraAttachments[0]!.id]);assert.match(JSON.stringify(hydrated[1]),/safely prepared complete message group exceeds/);
 assert.ok(JSON.stringify(hydrated[2]).includes(resized.data));
 const total=hydrated.reduce((sum,message)=>sum+(Array.isArray(message.content)?message.content.reduce((n,part)=>n+(part.type==='image'?Buffer.byteLength(part.data,'base64'):0),0):0),0);assert.ok(total<=12*1024*1024);
});
