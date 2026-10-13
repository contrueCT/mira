import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import { ExtensionHost, ExtensionRevisionConflictError, type RegisteredContextProvider } from '@mira/extension-host';
import { extensionManagementTools, extensionTools } from '@mira/server';
import { PiDurableRuntime, MIRA_PROMPT_SECTION, type ContextProviderSample } from '@mira/runtime-pi';
import { assistant, input, MemoryWriter, model, overrideWriter, streamOf } from '../recovery/fixtures.mts';

const sdkUrl = import.meta.resolve('@mira/extension-sdk');
const signal = () => new AbortController().signal;
const prompt = { environmentContext: 'Base environment', authorizationContext: 'User conversation only', now: () => new Date('2026-10-13T11:00:00Z') };
const sample: ContextProviderSample = { extensionId: 'fixture', activation: '12345678-1234-1234-1234-123456789012', providerId: 'status', status: 'ok', text: 'OBSERVATION' };
async function fixture<T>(t: { after: (fn: () => Promise<void>) => void }, source: string, id = 'fixture') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mira-context-provider-'));
  const file = path.join(root, 'extension.mjs');
  await writeFile(file, `import { defineExtension } from ${JSON.stringify(sdkUrl)};\n${source}`);
  const module = await import(pathToFileURL(file).href) as { state: T };
  let events = 0;
  const host = new ExtensionHost({ entries: [{ id, path: file }], receive: async () => { events++; return 'inserted'; } });
  t.after(async () => { await host.close(); await rm(root, { recursive: true, force: true }); });
  await host.start();
  return { host, state: module.state, events: () => events };
}
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await delay(5);
  assert.ok(check());
}

test('SDK providers are sourced by the host, sampled only on demand and removed on disable', async t => {
  const { host, state, events } = await fixture<{ calls: number }>(t, `
    export const state = { calls: 0 };
    export default defineExtension({ name: 'cannot-spoof-source', apply(ctx) {
      ctx.registerContextProvider({ id: 'status', async provide({signal}) { signal.throwIfAborted(); state.calls++; return { text: 'Current observation', extensionId: 'forged', activation: 'forged' }; } });
    } });`);
  const prepared = await host.prepareCapabilities();
  assert.equal(state.calls, 0); assert.equal(events(), 0); assert.deepEqual(prepared.tools, []);
  assert.deepEqual(host.inspect()[0]!.contextProviders, ['status']);
  const result = await host.sampleContextProviders(prepared.contextProviders, signal());
  assert.deepEqual(result, [{ extensionId: 'fixture', activation: host.inspect()[0]!.activation, providerId: 'status', status: 'ok', text: 'Current observation' }]);
  assert.equal(state.calls, 1); assert.equal(events(), 0);
  await host.requestChange('fixture', { action: 'disable' });
  assert.deepEqual((await host.prepareCapabilities()).contextProviders, []);
  assert.deepEqual(host.inspect()[0]!.contextProviders, []);
  assert.equal((await host.sampleContextProviders(prepared.contextProviders, signal()))[0]!.status, 'stale');
  assert.equal(state.calls, 1);
});

test('duplicate local provider IDs fail activation and unwind prior registrations', async t => {
  const { host } = await fixture(t, `export const state = {}; export default defineExtension({ name: 'duplicate', apply(ctx) {
    ctx.registerContextProvider({id:'same', async provide(){return {text:'first'};}});
    ctx.registerContextProvider({id:'same', async provide(){return {text:'second'};}});
  } });`);
  assert.equal(host.inspect()[0]!.status, 'failed');
  assert.match(host.inspect()[0]!.diagnostic!, /Duplicate context provider/);
  assert.deepEqual((await host.prepareCapabilities()).contextProviders, []);
});

test('provider IDs are namespaced by configured extension identity', async t => {
  const { host: first } = await fixture(t, `export const state = {}; export default defineExtension({ name: 'same', apply(ctx) { ctx.registerContextProvider({id:'same', async provide(){return {text:'a'};}}); } });`, 'first');
  const firstPath = first.inspect()[0]!.path;
  const host = new ExtensionHost({ entries: [{ id: 'a', path: firstPath }, { id: 'b', path: firstPath }], receive: async () => 'inserted' });
  t.after(() => host.close()); await host.start();
  assert.deepEqual((await host.sampleContextProviders((await host.prepareCapabilities()).contextProviders, signal())).map(item => [item.extensionId, item.providerId]), [['a', 'same'], ['b', 'same']]);
});

for (const id of ['', 'with.dot', '0bad', 'x'.repeat(65), 'bad\n']) test(`invalid provider ID ${JSON.stringify(id)} fails registration`, async t => {
  const { host } = await fixture(t, `export const state = {}; export default defineExtension({ name: 'invalid', apply(ctx) { ctx.registerContextProvider({id:${JSON.stringify(id)},async provide(){return null;}}); } });`);
  assert.equal(host.inspect()[0]!.status, 'failed'); assert.deepEqual((await host.prepareCapabilities()).contextProviders, []);
});

test('failures, empty and oversized observations are explicit and cannot reuse prior success or leak exceptions', async t => {
  const { host, state } = await fixture<{ mode: number }>(t, `export const state = { mode: 0 }; export default defineExtension({ name: 'modes', apply(ctx) {
    ctx.registerContextProvider({id:'status', async provide(){
      if(state.mode===0) return {text:'old success'};
      if(state.mode===1) throw Error('PRIVATE_ERROR_SENTINEL');
      if(state.mode===2) return null;
      if(state.mode===3) return {text:5};
      if(state.mode===4) return {text:'中文'.repeat(4000)};
      if(state.mode===5) return {get text(){throw Error('PRIVATE_ACCESSOR');}};
      return {text:''};
    }});
  } });`);
  const providers = (await host.prepareCapabilities()).contextProviders;
  const statuses = [];
  for (state.mode = 0; state.mode <= 6; state.mode++) {
    const results = await host.sampleContextProviders(providers, signal()); statuses.push(results[0]!.status);
    if (state.mode) assert.doesNotMatch(JSON.stringify(results), /old success|PRIVATE_/);
    assert.equal(host.inspect()[0]!.diagnostic !== null, [1, 3, 4, 5].includes(state.mode));
    assert.doesNotMatch(JSON.stringify(host.inspect()), /PRIVATE_/);
  }
  assert.deepEqual(statuses, ['ok', 'failed', 'empty', 'failed', 'too-large', 'failed', 'empty']);
});

test('aggregate serialized UTF-8 budget is bounded without silent truncation; duplicates never sample', async t => {
  const { host, state } = await fixture<{ calls: number }>(t, `export const state={calls:0}; export default defineExtension({name:'budget', apply(ctx){
    for(let i=0;i<10;i++) ctx.registerContextProvider({id:'p'+i,async provide(){state.calls++;return {text:'\\u0000'.repeat(2000)};}});
  }});`);
  const providers = (await host.prepareCapabilities()).contextProviders;
  await assert.rejects(host.sampleContextProviders([providers[0]!, providers[0]!], signal()), /Duplicate/); assert.equal(state.calls, 0);
  const results = await host.sampleContextProviders(providers, signal());
  assert.equal(state.calls, 10); assert.ok(Buffer.byteLength(JSON.stringify(results)) <= 65_536);
  assert.ok(results.some(result => result.status === 'budget-exceeded'));
  assert.match(host.inspect()[0]!.diagnostic!, /sampling failed or exceeded/);
  for (const result of results) if (result.status === 'ok') assert.equal(result.text, '\u0000'.repeat(2000));
});

test('provider count limit unwinds the failed activation', async t => {
  const { host } = await fixture(t, `export const state={}; export default defineExtension({name:'count',apply(ctx){for(let i=0;i<33;i++)ctx.registerContextProvider({id:'p'+i,async provide(){return null;}});}});`);
  assert.equal(host.inspect()[0]!.status, 'failed'); assert.match(host.inspect()[0]!.diagnostic!, /32 providers/);
  assert.deepEqual((await host.prepareCapabilities()).contextProviders, []);
});

test('only in-flight sampling leases old resources; reload never redirects unsampled siblings', async t => {
  const { host, state } = await fixture<{ generation: number; calls: number[]; cleaned: number[]; release: (() => void) | null }>(t, `
    export const state={generation:0,calls:[],cleaned:[],release:null}; export default defineExtension({name:'leased',apply(ctx){
      const generation=++state.generation;
      ctx.registerContextProvider({id:'slow',async provide(){state.calls.push(generation); await new Promise(resolve=>{state.release=resolve;});return {text:'generation '+generation};}});
      ctx.registerContextProvider({id:'sibling',async provide(){state.calls.push(generation);return {text:'sibling '+generation};}});
      ctx.onCleanup(()=>{state.cleaned.push(generation);});
    }});`);
  const providers = (await host.prepareCapabilities()).contextProviders;
  const sampling = host.sampleContextProviders(providers, signal());
  await until(() => state.release !== null);
  const reloading = host.requestChange('fixture', { action: 'reload' });
  await until(() => host.inspect()[0]!.status === 'unloading');
  assert.deepEqual(state.cleaned, []); state.release!();
  const samples = await sampling;
  assert.equal(samples[0]!.text, 'generation 1'); assert.equal(samples[1]!.status, 'stale');
  assert.equal((await reloading).status, 'applied'); assert.deepEqual(state.cleaned, [1]); assert.deepEqual(state.calls, [1]);
  const fresh = (await host.prepareCapabilities()).contextProviders.find(provider => provider.providerId === 'sibling')!;
  assert.notEqual(fresh.activation, providers[1]!.activation); assert.equal((await fresh.sample(signal())).text, 'sibling 2');
});

test('cancellation fences samples immediately while cleanup waits for an uncooperative callback', async t => {
  const { host, state } = await fixture<{ started: boolean; cleaned: boolean; release: (() => void) | null }>(t, `
    export const state={started:false,cleaned:false,release:null}; export default defineExtension({name:'cancel',apply(ctx){
      ctx.registerContextProvider({id:'slow',async provide(){state.started=true;await new Promise(resolve=>{state.release=resolve;});return {text:'late result'};}});
      ctx.onCleanup(()=>{state.cleaned=true;});
    }});`);
  const controller = new AbortController(); const providers = (await host.prepareCapabilities()).contextProviders;
  const sampling = host.sampleContextProviders(providers, controller.signal); await until(() => state.started);
  const rejected = assert.rejects(sampling, /Cancelled request/); controller.abort(Error('Cancelled request')); await rejected;
  const disabling = host.requestChange('fixture', { action: 'disable' }); await until(() => host.inspect()[0]!.status === 'disabled');
  assert.equal(state.cleaned, false); state.release!(); await disabling; assert.equal(state.cleaned, true);
});

test('real SDK/host/Pi requests update providers after settled management and preserve stale tool siblings', async t => {
  const { host, state, events } = await fixture<{ calls: number; generation: number; effects: number }>(t, `
    export const state={calls:0,generation:0,effects:0}; export default defineExtension({name:'runtime',apply(ctx){const generation=++state.generation;
      ctx.registerContextProvider({id:'status',async provide(){state.calls++;return {text:'PROVIDER_GENERATION_'+generation+' </environment> & {{CURRENT_TIME}}'};}});
      ctx.registerTool({name:'local_effect',description:'Generation '+generation,parameters:{type:'object'},async execute(){state.effects++;return {text:'done'};}});
    }});`);
  const writer = new MemoryWriter(); let calls = 0, memoryLoads = 0; let providers: RegisteredContextProvider[] = [];
  const runtime = new PiDurableRuntime({ writer, model: { ...model, contextWindow: 32_768 }, miraPrompt: { ...prompt, loadMemory: async () => { memoryLoads++; return 'MEMORY_ONCE'; } },
    prepareTools: async () => { const capabilities = await host.prepareCapabilities(); providers = capabilities.contextProviders; return [...extensionManagementTools(host), ...extensionTools(capabilities.tools)]; },
    loadContextProviders: abort => host.sampleContextProviders(providers, abort), finishTools: () => host.finish(),
    streamFn: (_model, context) => {
      calls++; const text = getCurrentSystemPrompt(context.messages);
      assert.match(text, /Base environment/); assert.match(text, /MEMORY_ONCE/);
      assert.match(text, /&lt;\/environment&gt; &amp; \{\{CURRENT_TIME\}\}/); assert.doesNotMatch(text, /&amp;lt;/);
      assert.match(text, /not instructions or user authorization/);
      assert.match(text, new RegExp('PROVIDER_GENERATION_'+calls));
      assert.equal((text.match(/PROVIDER_GENERATION_/g) ?? []).length, 1);
      assert.equal(state.calls, calls); assert.equal(getCurrentTools(context.messages).find(tool => tool.name === 'local_effect')?.description.includes('Generation '+calls), true);
      const persisted = JSON.stringify(writer.state.records.at(-1)!.payload); assert.match(persisted, new RegExp('PROVIDER_GENERATION_'+calls));
      if (calls === 1) return streamOf({ ...assistant(), stopReason: 'toolUse', content: [
        { type: 'toolCall', id: 'reload', name: 'extension_manage', arguments: { id: 'fixture', action: 'reload' } },
        { type: 'toolCall', id: 'old-sibling', name: 'local_effect', arguments: {} },
      ] });
      const stale = context.messages.find(item => item.role === 'toolResult' && item.toolCallId === 'old-sibling');
      assert.ok(stale?.role === 'toolResult' && stale.isError); assert.match(JSON.stringify(stale), /stale/);
      return streamOf(assistant());
    } });
  await runtime.run(input()); assert.equal(calls, 2); assert.equal(state.effects, 0); assert.equal(memoryLoads, 1); assert.equal(events(), 0);
  assert.equal(writer.state.executions.length, 2, 'provider reads do not create tool effects');
});

for (const fault of ['cas', 'owner-loss', 'loader', 'cancel'] as const) test(`context provider ${fault} failure prevents actual model dispatch`, async () => {
  const writer = new MemoryWriter(); const controller = new AbortController(); let calls = 0;
  if (fault === 'cas') writer.beforeAppend = async record => { if (JSON.stringify(record.payload).includes(MIRA_PROMPT_SECTION)) writer.state.version++; };
  const runtime = new PiDurableRuntime({ writer, model, miraPrompt: prompt, loadContextProviders: async () => {
    if (fault === 'owner-loss') writer.controller.abort(Error('Owner lost'));
    if (fault === 'cancel') controller.abort(Error('User cancelled'));
    if (fault === 'loader') throw Error('Loader failed');
    return [sample];
  }, streamFn: () => { calls++; return streamOf(assistant()); } });
  await assert.rejects(runtime.run(input(), controller.signal), fault === 'cas' ? /version conflict/ : fault === 'owner-loss' ? /Owner lost/ : fault === 'cancel' ? /User cancelled/ : /Loader failed/);
  assert.equal(calls, 0);
});

test('provider output is pinned before persist, recovered exactly, retained through compaction and replaced next request', async () => {
  const writer = new MemoryWriter(); let loads = 0, memoryLoads = 0; let text = 'FROZEN_OBSERVATION';
  const options = { writer, model: { ...model, contextWindow: 32_768 }, autoCompaction: { enabled: false }, miraPrompt: { ...prompt, loadMemory: async () => { memoryLoads++; return 'FROZEN_MEMORY'; } },
    loadContextProviders: async () => { loads++; return [{ ...sample, text }]; }, streamFn: () => streamOf(assistant('Long response '.repeat(200))) };
  writer.beforeAppend = async record => { if (JSON.stringify(record.payload).includes(MIRA_PROMPT_SECTION)) text = 'NEXT_OBSERVATION'; };
  await new PiDurableRuntime({ ...options, streamFn: (_model, context) => { assert.match(getCurrentSystemPrompt(context.messages), /FROZEN_OBSERVATION/); assert.doesNotMatch(getCurrentSystemPrompt(context.messages), /NEXT_OBSERVATION/); return options.streamFn(); } }).run(input('Long discussion '.repeat(300)));
  delete writer.beforeAppend;
  const recovered = await new PiDurableRuntime(options).recover(); assert.match(getCurrentSystemPrompt(recovered.messages), /FROZEN_OBSERVATION/); assert.equal(loads, 1);
  const compacted = await new PiDurableRuntime(options).compact({ keepRecentTokens: 1 });
  assert.equal(loads, 1); assert.equal(memoryLoads, 2); assert.match(getCurrentSystemPrompt(compacted.messages), /FROZEN_OBSERVATION/);
  await new PiDurableRuntime({ ...options, streamFn: (_model, context) => { assert.match(getCurrentSystemPrompt(context.messages), /NEXT_OBSERVATION/); assert.doesNotMatch(getCurrentSystemPrompt(context.messages), /FROZEN_OBSERVATION/); return streamOf(assistant()); } }).run(input('Continue'));
  assert.equal(loads, 2); assert.equal(memoryLoads, 2);
  const frozenPrefix = structuredClone(writer.state.records);
  await new PiDurableRuntime({ ...options, loadContextProviders: async () => [] }).run(input('Provider removed'));
  assert.doesNotMatch(getCurrentSystemPrompt((await new PiDurableRuntime(options).recover()).messages), /OBSERVATION|Extension context observations/);
  assert.deepEqual(writer.state.records.slice(0, frozenPrefix.length), frozenPrefix);
});

test('uncertain committed provider prompt is recovered without duplicated system update', async () => {
  const writer = new MemoryWriter(); let calls = 0, loads = 0;
  const options = { model, miraPrompt: prompt, loadContextProviders: async () => { loads++; return [sample]; }, streamFn: () => { calls++; return streamOf(assistant()); } };
  const crashed = overrideWriter(writer, { append: async (...args) => { const version = await writer.append(...args); if (JSON.stringify(args[1].payload).includes(MIRA_PROMPT_SECTION)) throw Error('Lost commit reply'); return version; } });
  await assert.rejects(new PiDurableRuntime({ ...options, writer: crashed }).run(input()), /Lost commit reply/); assert.equal(calls, 0);
  const before = writer.state.records.filter(record => JSON.stringify(record.payload).includes(MIRA_PROMPT_SECTION));
  await new PiDurableRuntime({ ...options, writer }).run(); assert.equal(calls, 1); assert.equal(loads, 2);
  assert.deepEqual(writer.state.records.filter(record => JSON.stringify(record.payload).includes(MIRA_PROMPT_SECTION)), before);
});

test('runtime validates sourced snapshot count, identity, uniqueness and budgets before provider requests', async () => {
  assert.throws(() => new PiDurableRuntime({ writer: new MemoryWriter(), model, streamFn: () => streamOf(assistant()), loadContextProviders: async () => [] }), /require the Mira prompt/);
  for (const samples of [[sample, sample], [{ ...sample, activation: 'forged' }], [{ ...sample, status: 'failed', text: 'must not reuse' }], [{ ...sample, text: 'x'.repeat(20_000) }], Array.from({ length: 33 }, () => sample)] as ContextProviderSample[][]) {
    let calls = 0;
    await assert.rejects(new PiDurableRuntime({ writer: new MemoryWriter(), model, miraPrompt: prompt, loadContextProviders: async () => samples, streamFn: () => { calls++; return streamOf(assistant()); } }).run(input()), /context provider|Context provider/);
    assert.equal(calls, 0);
  }
});

test('management revisions reject stale queued writes and repeated reloads without exposing private config', async t => {
  const { host } = await fixture(t, `export const state={};export default defineExtension({name:'revision',apply(ctx){ctx.registerContextProvider({id:'p',async provide(){return null;}});}});`);
  const revision = host.managementRevision('fixture'); assert.match(revision, /^[a-f0-9]{64}$/);
  const first = host.requestChange('fixture', { action: 'reload' }, { expectedRevision: revision });
  const second = host.requestChange('fixture', { action: 'configure', config: { private: 'secret' } }, { expectedRevision: revision });
  const rejected = assert.rejects(second, ExtensionRevisionConflictError);
  assert.equal((await first).status, 'applied'); await rejected;
  assert.notEqual(host.managementRevision('fixture'), revision); assert.equal(host.changeStatus().length, 1);
  assert.equal(host.inspect()[0]!.config, null);
});


test('failed disabled reload also invalidates a management revision without an activation change', async t => {
  const { host } = await fixture(t, `export const state={};export default defineExtension({name:'disabled',apply(){}});`);
  await host.requestChange('fixture', { action: 'disable' });
  const before = host.managementRevision('fixture'); const activation = host.inspect()[0]!.activation;
  const receipt = await host.requestChange('fixture', { action: 'reload' }, { expectedRevision: before });
  assert.equal(receipt.status, 'failed'); assert.equal(host.inspect()[0]!.activation, activation);
  assert.notEqual(host.managementRevision('fixture'), before);
  await assert.rejects(host.requestChange('fixture', { action: 'enable' }, { expectedRevision: before }), ExtensionRevisionConflictError);
  assert.equal(host.inspect()[0]!.enabled, false);
});
