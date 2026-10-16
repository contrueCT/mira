import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { prepareWakeTurn, renderWakeBatch, type WakeRun } from '@mira/life';
import { writeWakeInput } from '@mira/workspace';
import { PiDurableRuntime } from '@mira/runtime-pi';
import { AttachmentStore } from '../../apps/server/src/attachments.ts';
import { input, assistant, streamOf, MemoryWriter, model, seed } from '../recovery/fixtures.mts';

async function readAll(file: string): Promise<string> {
  const read = createReadTool(process.cwd()); const chunks:string[]=[]; let offset=1;
  for(;;) {
    const result = await read.execute(`read-${offset}`,{path:file,offset,limit:25});
    const text = result.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
    const continuation = text.match(/\n\n\[\d+ more lines in file\. Use offset=(\d+) to continue\.\]$/);
    chunks.push(continuation ? text.slice(0,continuation.index) : text);
    if(!continuation) break;
    offset=Number(continuation[1]); assert.ok(offset<20000);
  }
  return chunks.join('\n');
}
interface IndexNode { version: number; type: string; previous: {path:string;bytes:number}|null; sources: Array<{historyId:string;overflowInput?:{path:string;bytes:number};attachments?:unknown[]}> }
function indexPointer(entry: unknown): {path:string;bytes:number} { return (entry as {miraAttachmentIndex:{path:string;bytes:number}}).miraAttachmentIndex; }

test('oversized merged attachment History retains its existing spool through repeated compaction and ordinary read', async () => {
  // Deliberately outside the sanitized test HOME: production spool rules apply.
  const root = await realpath(await mkdtemp('/tmp/mira-compacted-big-refs-'));
  try {
    const store = await AttachmentStore.open(path.join(root, ...Array(20).fill('nested'), 'attachments'), []);
    const staged = await Promise.all(Array.from({length:10}, (_, i) => store.stage('名'.repeat(250)+`${i}.pdf`, Buffer.from('%PDF-1.4\nsynthetic'))));
    const refs = await store.resolve(staged.map(item => item.id));
    const run: WakeRun = {id:randomUUID(),claimedAt:'2026-10-13T00:00:00.000Z',status:'running',inputRecordId:null,finalRecordId:null,
      requests:Array.from({length:101}, (_, i) => ({eventId:randomUUID(),event:{id:`web-${i}`,type:'web.message',source:'user',occurredAt:'2026-10-13T00:00:00.000Z',payload:{text:'PDF files',attachments:refs.map(item=>({...item}))}},wake:{id:`wake-${i}`,reason:'User message from the local web interface'}}))};
    const turn = await prepareWakeTurn(run, (runId,content) => writeWakeInput({rootDirectory:path.join(root,'spool'),sourceDirectory:process.cwd(),runId,content}), 100);
    assert.ok(turn.overflowInput); assert.equal(turn.overflowInput.bytes, Buffer.byteLength(renderWakeBatch(run)));
    const writer = new MemoryWriter();
    await seed(writer,[Object.assign(input(turn.input),{miraAttachments:turn.attachments,miraAttachmentsInInput:true,miraOverflowInput:turn.overflowInput}),assistant('old'),input('tail')]);
    const original = writer.state.records[0]!;
    assert.ok(Buffer.byteLength(JSON.stringify(original)) > 1024*1024, 'original History record exceeds history_read maximum');
    const checkpoints: string[] = [];
    const writeOverflowInput = (runId:string,content:string) => writeWakeInput({rootDirectory:path.join(root,'spool'),sourceDirectory:process.cwd(),runId,content});
    for(let i=0;i<3;i++) {
      const runtime = new PiDurableRuntime({writer,writeOverflowInput,model:{...model,contextWindow:65536},autoCompaction:{enabled:false},streamFn:()=>streamOf(assistant('Summary omits all attachment metadata and file paths.'))});
      if(i) await runtime.run(input(`new material ${i}`));
      const compacted = await runtime.compact({keepRecentTokens:1});
      const checkpoint = compacted.entries.findLast(entry=>entry.type==='compaction')!;
      assert.equal(checkpoint.type,'compaction'); assert.ok(checkpoint.summary.length<1600);
      assert.ok(checkpoint.summary.includes(indexPointer(checkpoint).path));
      checkpoints.push(checkpoint.id);
    }
    const recovered = await new PiDurableRuntime({writer,model,streamFn:()=>streamOf(assistant())}).recover();
    const checkpoint = recovered.entries.find(entry=>entry.id===checkpoints.at(-1))!;
    let node = JSON.parse(await readAll(indexPointer(checkpoint).path)) as IndexNode;
    let traversed=1;
    while(node.previous) { node=JSON.parse(await readAll(node.previous.path)) as IndexNode; traversed++; }
    assert.equal(traversed,3);
    const pointer=node.sources.find(source=>source.historyId===original.id)?.overflowInput; assert.ok(pointer);
    const file=pointer.path; assert.equal(file,turn.overflowInput.path);
    const content=await readAll(file); assert.equal(Buffer.byteLength(content),pointer.bytes);
    assert.equal(content,renderWakeBatch(run));
    const recoveredPayloads=content.split('Payload (JSON):\n').slice(1).map(chunk=>JSON.parse(chunk.split('\n\n[user |')[0]!));
    assert.equal(recoveredPayloads.length,101);
    for(const payload of recoveredPayloads) assert.deepEqual(payload.attachments,refs);
  } finally { await rm(root,{recursive:true,force:true}); }
});


test('large Memory checkpoint envelopes never obstruct previous ordinary-file attachment index nodes', async () => {
  const root=await realpath(await mkdtemp('/tmp/mira-large-memory-index-'));
  try {
    const writer=new MemoryWriter();
    const writeOverflowInput=(runId:string,content:string)=>writeWakeInput({rootDirectory:root,sourceDirectory:process.cwd(),runId,content});
    const reference={id:randomUUID(),name:'example.pdf',mimeType:'application/pdf',size:20,sha256:'a'.repeat(64),path:'/immutable/example.pdf'};
    const options={writer,writeOverflowInput,model:{...model,contextWindow:1000000},autoCompaction:{enabled:false},streamFn:()=>streamOf(assistant('Summary omits every pointer.')),miraPrompt:{memoryRoot:'/private/memory',loadMemory:async()=> 'ordinary large memory\n'.repeat(30000),authorizationContext:'Only user requests authorize action.',environmentContext:'Synthetic offline test environment.'}};
    await new PiDurableRuntime(options).run(Object.assign(input('old attachment'),{miraAttachments:[reference]}));
    await new PiDurableRuntime(options).run(input('first tail'));
    const first=await new PiDurableRuntime(options).compact({keepRecentTokens:1});
    const firstCheckpoint=first.entries.findLast(entry=>entry.type==='compaction')!;
    const firstRecord=writer.state.records.find(record=>record.id===firstCheckpoint.id)!;
    assert.ok(Buffer.byteLength(JSON.stringify(firstRecord))>1024*1024);
    await new PiDurableRuntime(options).run(input('new material'));
    const second=await new PiDurableRuntime(options).compact({keepRecentTokens:1});
    const secondCheckpoint=second.entries.findLast(entry=>entry.type==='compaction')!;
    assert.equal(secondCheckpoint.type,'compaction'); assert.ok(secondCheckpoint.summary.length<1000);
    const node=JSON.parse(await readAll(indexPointer(secondCheckpoint).path)) as IndexNode;
    assert.deepEqual(node.previous,indexPointer(firstCheckpoint));
    const earlier=JSON.parse(await readAll(node.previous!.path)) as IndexNode;
    assert.equal(earlier.previous,null); assert.deepEqual(earlier.sources[0]!.attachments,[reference]);
    assert.doesNotMatch(JSON.stringify(node),/ordinary large memory|example.pdf/);
    await assert.rejects(writeOverflowInput(`attachment-index:${firstCheckpoint.id}`,'changed index content'),/differ|existing|match|immutable/i);
    await rm(node.previous!.path);
    await assert.rejects(createReadTool(process.cwd()).execute('missing-index',{path:node.previous!.path}),/ENOENT/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('attachment compaction without an ordinary-file writer fails explicitly before the summary call', async () => {
  const writer=new MemoryWriter(); let calls=0;
  await seed(writer,[Object.assign(input('file'),{miraAttachments:[{id:randomUUID(),name:'file.pdf',mimeType:'application/pdf',size:1,sha256:'a'.repeat(64),path:'/immutable/file'}]}),assistant(),input('tail')]);
  await assert.rejects(new PiDurableRuntime({writer,model:{...model,contextWindow:65536},streamFn:()=>{calls++;return streamOf(assistant());}}).compact({keepRecentTokens:1}),/requires the existing ordinary-file spool writer/);
  assert.equal(calls,0);
});

for(const fault of ['write','cancel','ownership','cas','bytes'] as const) test(`attachment index ${fault} failure cannot publish a checkpoint`, async () => {
  const root=await realpath(await mkdtemp('/tmp/mira-index-fence-'));
  try {
    const writer=new MemoryWriter();const cancellation=new AbortController();
    await seed(writer,[Object.assign(input('file'),{miraAttachments:[{id:randomUUID(),name:'file.pdf',mimeType:'application/pdf',size:1,sha256:'a'.repeat(64),path:'/immutable/file'}]}),assistant(),input('tail')]);
    const writeOverflowInput=async(runId:string,content:string)=>{
      if(fault==='write')throw Error('synthetic index write failure');
      const pointer=await writeWakeInput({rootDirectory:root,sourceDirectory:process.cwd(),runId,content});
      if(fault==='cancel')cancellation.abort(Error('synthetic index cancellation'));
      if(fault==='ownership')writer.controller.abort(Error('synthetic ownership loss'));
      if(fault==='cas')await seed(writer,[input('concurrent material')]);
      return fault==='bytes'?{...pointer,bytes:pointer.bytes+1}:pointer;
    };
    await assert.rejects(new PiDurableRuntime({writer,writeOverflowInput,model:{...model,contextWindow:65536},autoCompaction:{enabled:false},streamFn:()=>streamOf(assistant('summary'))}).compact({keepRecentTokens:1,signal:cancellation.signal}));
    assert.equal(writer.state.records.filter(record=>record.kind==='checkpoint').length,0);
  } finally {await rm(root,{recursive:true,force:true});}
});
