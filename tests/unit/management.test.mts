import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createLocalHttp, type WebBackend, type ExtensionView, type RunDetailView, type ExtensionMutation } from '@mira/server';
import { assistantReply, memoryReceipt, runExecution } from '../../apps/server/src/management-projections.ts';
import type { HistoryContext, HistoryTool } from '@mira/life';
import { encodeEntry, messageEntry } from '../../packages/runtime-pi/src/records.ts';
import { assistant } from '../recovery/fixtures.mts';

const port = 4317; const origin = `http://127.0.0.1:${port}`;
const readHeaders = { host: `127.0.0.1:${port}`, 'x-mira-client': 'web' };
const writeHeaders = { ...readHeaders, origin, 'content-type': 'application/json' };
const secret = 'PRIVATE_MANAGEMENT_SENTINEL'; const now = '2026-10-13T00:00:00.000Z';
const id = randomUUID(); const revision = 'a'.repeat(64);
const extension: ExtensionView = { id: 'example', revision, enabled: true, status: 'active', activation: randomUUID(),
  tools: ['example_tool'], contextProviders: ['context'], generated: { digest: revision, revision: id, history: [{ id, digest: revision, config: secret } as never] }, error: secret,
  config: { token: secret }, path: secret, diagnostic: secret } as ExtensionView;
const run: RunDetailView = { id, occurredAt: now, status: 'completed', requestCount: 1,
  requests: [{ eventId: id, source: 'user', type: 'web.message', reason: 'User message', payload: secret } as never],
  assistant: { id, text: 'Visible reply', occurredAt: now, thinking: secret } as never,
  memory: { state: 'changed', commit: 'b'.repeat(40), payload: secret } as never,
  executions: [{ id, occurredAt: now, kind: 'tool', name: 'read', status: 'failed', error: secret, arguments: secret, outcome: secret } as never],
  nextCursor: null, nextRequestsCursor: 'members-next', compactionErrors: 'not-recorded', error: secret,
  payload: secret } as RunDetailView;
function backend(overrides: Partial<WebBackend> = {}): WebBackend {
  return { status: async () => ({ state: 'idle', mode: 'synthetic', model: null, error: null }), timeline: async () => ({ items: [], nextCursor: null }),
    submit: async input => ({ id: input.id, receipt: 'inserted' }),
    settings: async () => ({ revision, configuration: { builtinCredentials: {}, customConnections: [] }, selection: null }),
    saveSettings: async () => { throw Error(); }, discover: async () => ({ endpoint: '', models: [] }),
    memory: async () => ({ configured: true, content: 'Current readable MEMORY.md', revision, path: secret }),
    messageStatus: async requested => ({ id: requested, eventId: id, runId: id, state: 'completed', assistant: run.assistant, memory: run.memory, error: secret, trace: secret }),
    extensions: async () => ({ available: true, extensions: [extension], releases: [{ digest: revision, path: secret, config: secret }], error: secret }),
    changeExtension: async (_id, change) => ({ id, extensionId: 'example', action: change.action, status: 'applied', persistence: 'saved', runtime: extension, error: secret, config: secret }),
    runs: async () => ({ items: [run], nextCursor: 'next' }), run: async () => run, runRequests: async () => ({ items: run.requests, nextCursor: null }), ...overrides };
}

test('management HTTP projections discard secret-bearing extra fields and raw errors recursively', async t => {
  const app = createLocalHttp({ backend: backend(), port }); t.after(() => app.close());
  for (const url of ['/api/memory', '/api/messages/request-1/status', '/api/extensions', '/api/runs', `/api/runs/${id}`, `/api/runs/${id}/requests`]) {
    const response = await app.inject({ url, headers: readHeaders });
    assert.equal(response.statusCode, 200, response.body); assert.doesNotMatch(response.body, new RegExp(secret));
    assert.equal(response.headers['cache-control'], 'private, no-store');
  }
  const response = await app.inject({ method: 'POST', url: '/api/extensions/example', headers: writeHeaders, payload: { action: 'configure', expectedRevision: revision, config: { password: secret } } });
  assert.equal(response.statusCode, 200); assert.doesNotMatch(response.body, new RegExp(secret));
  const detail = (await app.inject({ url: `/api/runs/${id}`, headers: readHeaders })).json();
  assert.equal(detail.assistant.text, 'Visible reply'); assert.equal(detail.memory.commit, 'b'.repeat(40)); assert.equal(detail.compactionErrors, 'not-recorded'); assert.equal(detail.nextRequestsCursor, 'members-next');
});

test('management routes preserve local-origin protection, strict methods, bounded schema, and write-only mutation contract', async t => {
  let mutations = 0; const received: ExtensionMutation[] = [];
  const app = createLocalHttp({ backend: backend({ changeExtension: async (_id, change) => { mutations++; received.push(change); return { id, extensionId: 'example', action: change.action, status: 'applied', persistence: 'saved', runtime: extension, error: null }; } }), port });
  t.after(() => app.close());
  for (const url of ['/api/memory', '/api/messages/request/status', '/api/extensions', '/api/runs', `/api/runs/${id}`, `/api/runs/${id}/requests`]) {
    assert.equal((await app.inject({ url, headers: { ...readHeaders, origin: 'https://evil.example' } })).statusCode, 403);
    assert.equal((await app.inject({ url, headers: { host: readHeaders.host } })).statusCode, 403);
  }
  for (const payload of [
    { action: 'enable' }, { action: 'enable', expectedRevision: revision, config: null },
    { action: 'configure', expectedRevision: revision }, { action: 'update', expectedRevision: revision, digest: '../elsewhere' },
    { action: 'rollback', expectedRevision: revision, revision: 'wrong' }, { action: 'remove', expectedRevision: revision },
    { action: 'configure', expectedRevision: revision, config: null, extra: true },
  ]) assert.equal((await app.inject({ method: 'POST', url: '/api/extensions/example', headers: writeHeaders, payload })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: '/api/extensions/example', headers: readHeaders, payload: { action: 'enable', expectedRevision: revision } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/extensions/example', headers: writeHeaders, payload: { action: 'configure', expectedRevision: revision, config: { token: 'x'.repeat(70_000) } } })).statusCode, 413);
  assert.equal((await app.inject({ url: '/api/runs/not-a-uuid', headers: readHeaders })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/memory?file=SECRET', headers: readHeaders })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/%6demory', headers: readHeaders })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PUT', url: '/api/memory', headers: writeHeaders, payload: {} })).statusCode, 405);
  assert.equal(mutations, 0);
  const response = await app.inject({ method: 'POST', url: '/api/extensions/example', headers: writeHeaders, payload: { action: 'configure', expectedRevision: revision, config: null } });
  assert.equal(response.statusCode, 200); assert.deepEqual(received, [{ action: 'configure', expectedRevision: revision, config: null }]);
});

test('management unavailable, not-found, and raw exceptions remain explicit and protected', async t => {
  const app = createLocalHttp({ backend: backend({ run: async () => null, memory: async () => { throw Error(secret); } }), port }); t.after(() => app.close());
  assert.equal((await app.inject({ url: `/api/runs/${id}`, headers: readHeaders })).statusCode, 404);
  const result = await app.inject({ url: '/api/memory', headers: readHeaders }); assert.equal(result.statusCode, 500); assert.doesNotMatch(result.body, new RegExp(secret));
});

test('durable projections retain known, unknown and no-change distinctions without tool payloads or reasoning', () => {
  const record = encodeEntry(messageEntry({ ...assistant('Visible answer'), content: [{ type: 'thinking', thinking: secret }, { type: 'text', text: 'Visible answer' }, { type: 'toolCall', id: 'private-call', name: 'read', arguments: { secret } }] }, null));
  const context: HistoryContext = { id: record.id, kind: 'context', miraId: 'test', occurredAt: record.occurredAt, version: 1, record };
  assert.equal(assistantReply(context)?.text, 'Visible answer'); assert.equal(runExecution(context)?.kind, 'model');
  assert.doesNotMatch(JSON.stringify(runExecution(context)), new RegExp(secret));
  const tool: HistoryTool = { id, kind: 'tool', miraId: 'test', occurredAt: now, contextVersion: 1,
    intent: { callId: 'private-call', assistantRecordId: record.id, toolName: 'read', requestedArguments: { secret }, arguments: { secret }, occurredAt: now }, outcome: null };
  assert.equal(runExecution(tool)?.status, 'unknown');
  tool.outcome = { callId: 'private-call', occurredAt: now, payload: { role: 'toolResult', isError: false, content: [{ type: 'text', text: secret }] } };
  assert.equal(runExecution(tool)?.status, 'succeeded'); assert.doesNotMatch(JSON.stringify(runExecution(tool)), new RegExp(secret));
  assert.deepEqual(memoryReceipt(null), { state: 'unavailable', commit: null });
  assert.deepEqual(memoryReceipt({ preparedAt: now, receipt: null }), { state: 'pending', commit: null });
  assert.deepEqual(memoryReceipt({ preparedAt: now, receipt: { commit: null } }), { state: 'unchanged', commit: null });
  assert.deepEqual(memoryReceipt({ preparedAt: now, receipt: { commit: 'c'.repeat(40) } }), { state: 'changed', commit: 'c'.repeat(40) });
});


test('run HTTP discards obsolete mixed-child refresh metadata and raw child payloads', async t => {
  const app = createLocalHttp({ backend: backend({ run: async () => ({ ...run, refreshCursor: 'scoped-frozen-page', childDetailsUnavailable: true, executions: [{ ...run.executions[0]!, supplemental: true }] }) }), port });
  t.after(() => app.close());
  const response = await app.inject({ url: `/api/runs/${id}`, headers: readHeaders });
  assert.equal(response.statusCode, 200);
  const detail = response.json();
  assert.equal(detail.executions[0].supplemental, undefined);
  assert.equal(detail.refreshCursor, undefined);
  assert.equal(detail.childDetailsUnavailable, undefined);
  assert.doesNotMatch(response.body, new RegExp(secret));
});

test('extension settings HTTP is protected, bounded, write-only and reprojects credential fields', async t => {
  let writes = 0;
  const settings = { revision, fields: [{ key:'appId',label:'App ID',type:'text' as const,value:'example' },
    {key:'secret',label:'Secret',type:'secret' as const,configured:true,value:secret}], actions:[{id:'connect',label:'Connect',execute:secret}],
    status:{state:'disconnected' as const,details:[{label:'Public',value:'safe',raw:secret}],raw:secret},operation:null,raw:secret };
  const app=createLocalHttp({port,backend:backend({extensionSettings:async()=>settings,
    saveExtensionSettings:async(_id,input)=>{writes++;assert.equal(input.secrets['secret'],secret);},
    startExtensionSettingsAction:async()=>settings,cancelExtensionSettingsAction:async()=>{},
  })}); t.after(()=>app.close());
  const url='/api/extensions/example/settings';
  const response=await app.inject({url,headers:readHeaders}); assert.equal(response.statusCode,200); assert.doesNotMatch(response.body,new RegExp(secret));
  assert.equal((await app.inject({url})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url,headers:{...writeHeaders,origin:'https://evil.example'},payload:{expectedRevision:revision,values:{},secrets:{secret}}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url,headers:writeHeaders,payload:{expectedRevision:revision,values:{},secrets:{secret}}})).statusCode,200); assert.equal(writes,1);
  assert.equal((await app.inject({method:'POST',url,headers:writeHeaders,payload:{expectedRevision:revision,values:{},secrets:{secret:''}}})).statusCode,400);
  const action=await app.inject({method:'POST',url:url+'/actions',headers:writeHeaders,payload:{expectedRevision:revision,action:'connect'}});
  assert.equal(action.statusCode,200);assert.doesNotMatch(action.body,new RegExp(secret));
  assert.equal((await app.inject({method:'PUT',url,headers:writeHeaders,payload:{}})).statusCode,405);
});
