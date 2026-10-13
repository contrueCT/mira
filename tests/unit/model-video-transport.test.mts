import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeContext, type Context, type ToolResultMessage } from '@earendil-works/pi-ai';
import { createModelTransport } from '../../apps/server/src/model-transport.ts';
import { prepareNativeVideoRequest, type NativeVideoInput } from '../../apps/server/src/model-video-transport.ts';

const bytes = Buffer.from('synthetic video bytes, not a playable fixture').toString('base64');
const input = (contentIndex = 1): NativeVideoInput => ({ contentIndex, attachmentId: 'opaque-video-id', mimeType: 'video/mp4', data: bytes });
function tool(text = 'before'): ToolResultMessage & { miraNativeVideos: NativeVideoInput[] } {
  return { role: 'toolResult', toolCallId: 'read-one', toolName: 'read', isError: false, timestamp: 1, content: [{ type: 'text', text }, { type: 'text', text: '[attachment opaque-video-id]' }, { type: 'text', text: 'after' }], miraNativeVideos: [input()] };
}
function transport() {
  return createModelTransport({ builtinCredentials: { google: { apiKeyEnv: 'EXPLICIT_TEST_GOOGLE' } }, customConnections: [] }, { kind: 'builtin', provider: 'google', model: 'gemini-2.5-flash' }, { env: () => 'synthetic-test-google-key' });
}
function assistant(id = 'read-one', name = 'read') {
  return { role: 'assistant' as const, api: 'google-generative-ai' as const, provider: 'google', model: 'gemini-2.5-flash', timestamp: 0,
    content: [{ type: 'toolCall' as const, id, name, arguments: { path: '/video.mp4' } }], stopReason: 'toolUse' as const,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function context(message = tool()): Context { return normalizeContext({ messages: [assistant(), message] }); }
function asGoogle(prepared: ReturnType<typeof prepareNativeVideoRequest>): Record<string, unknown> {
  return { contents: prepared.context.messages.filter(message => message.role === 'toolResult').map(message => ({ role: 'user', parts: [{ functionResponse: { name: message.toolName, response: { output: message.content.filter(part => part.type === 'text').map(part => part.text).join('\n') } } }] })) };
}

test('native video slots retain opaque reference, adjacent text and input immutability', () => {
  const source = context(); const before = structuredClone(source);
  const prepared = prepareNativeVideoRequest(transport().model, source);
  assert.deepEqual(source, before);
  assert.equal('miraNativeVideos' in prepared.context.messages[1]!, false);
  const payload = asGoogle(prepared); prepared.apply(payload);
  assert.deepEqual(payload, { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'before\n[attachment opaque-video-id]\nafter' } } }, { text: 'Video from read result opaque-video-id:' }, { inlineData: { mimeType: 'video/mp4', data: bytes } }] }] });
});

test('native video fails honestly for unsupported model/provider and malformed metadata', () => {
  const model = transport().model;
  for (const patch of [{ provider: 'openai' }, { api: 'openai-completions' }, { id: 'gemma-3' }]) assert.throws(() => prepareNativeVideoRequest({ ...model, ...patch }, context()), /only.*Google Gemini/);
  for (const patch of [{ contentIndex: -1 }, { contentIndex: 99 }, { data: 'no base64!' }, { mimeType: 'image/png' }, { attachmentId: '' }]) {
    const message = tool(); message.miraNativeVideos = [{ ...input(), ...patch }];
    assert.throws(() => prepareNativeVideoRequest(model, context(message)), /Invalid native video/);
  }
  const duplicate = tool(); duplicate.miraNativeVideos.push(input());
  assert.throws(() => prepareNativeVideoRequest(model, context(duplicate)), /content slot/);
});

test('native video fails closed if provider conversion drops or duplicates a designated slot', () => {
  for (const duplicate of [false, true]) {
    const prepared = prepareNativeVideoRequest(transport().model, context()); const body = asGoogle(prepared);
    const contents = body['contents'] as { parts: unknown[] }[];
    if (duplicate) contents[0]!.parts.push(structuredClone(contents[0]!.parts[0])); else contents[0]!.parts.splice(0, 1);
    assert.throws(() => prepared.apply(body), /missing or duplicated/);
  }
});

test('native video budget includes images and entire payload', () => {
  const model = transport().model;
  const message = tool(); message.content = [...message.content as Exclude<ToolResultMessage['content'], string>, { type: 'image', mimeType: 'image/png', data: Buffer.alloc(12 * 1024 * 1024).toString('base64') }];
  let prepared = prepareNativeVideoRequest(model, context(message));
  const imageBody = asGoogle(prepared); imageBody['image'] = { inlineData: { mimeType: 'image/png', data: Buffer.alloc(12 * 1024 * 1024).toString('base64') } };
  assert.throws(() => prepared.apply(imageBody), /size limit/);
  prepared = prepareNativeVideoRequest(model, context()); const payload = asGoogle(prepared); payload['systemInstruction'] = 'x'.repeat(20_000_000);
  assert.throws(() => prepared.apply(payload), /size limit/);
});

test('actual Pi Google SDK serializes explicit video read results, paired tools and ordinary uploaded video references without live network', async t => {
  const selected = transport(); const requests: Record<string, unknown>[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    assert.match(String(url), /^https:\/\/generativelanguage\.googleapis\.com\//);
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: 'Synthetic video answer' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  });
  const first = tool('first'); const second = tool('second'); second.toolCallId = 'read-two';
  second.miraNativeVideos = [{ ...input(), mimeType: 'video/webm', attachmentId: 'second-id', data: Buffer.from('second video').toString('base64') }];
  const call = assistant(); call.content.push({ type: 'toolCall', id: 'inspect-one', name: 'inspect', arguments: { path: '/ordinary.txt' } });
  const source = normalizeContext({ messages: [
    { role: 'system', content: 'system', timestamp: 0 },
    { role: 'user', content: 'Uploaded video is an ordinary file: /video.mp4', timestamp: 0 }, call, first,
    { role: 'toolResult', toolCallId: 'inspect-one', toolName: 'inspect', content: [{ type: 'text', text: 'ordinary sibling result' }], isError: false, timestamp: 3 },
    assistant('read-two'), second,
  ] });
  const before = structuredClone(source);
  const message = await (await selected.streamFn(selected.model, source, { maxTokens: 100 })).result();
  assert.equal(message.stopReason, 'stop', message.errorMessage); assert.equal(requests.length, 1); assert.deepEqual(source, before);
  const contents = requests[0]!['contents'] as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
  assert.deepEqual(contents[0], { role: 'user', parts: [{ text: 'Uploaded video is an ordinary file: /video.mp4' }] });
  assert.deepEqual(contents[2], { role: 'user', parts: [
    { functionResponse: { name: 'read', response: { output: 'first\n[attachment opaque-video-id]\nafter' } } },
    { text: 'Video from read result opaque-video-id:' }, { inlineData: { mimeType: 'video/mp4', data: bytes } },
    { functionResponse: { name: 'inspect', response: { output: 'ordinary sibling result' } } },
  ] });
  assert.deepEqual(contents[4], { role: 'user', parts: [
    { functionResponse: { name: 'read', response: { output: 'second\n[attachment opaque-video-id]\nafter' } } },
    { text: 'Video from read result second-id:' }, { inlineData: { mimeType: 'video/webm', data: second.miraNativeVideos[0]!.data } },
  ] });
  assert.equal((requests[0]!['generationConfig'] as Record<string, unknown>)['maxOutputTokens'], 100);
  assert.doesNotMatch(JSON.stringify(requests), /miraNativeVideos|mira-native-video-/);
});

test('video metadata is rejected on user uploads and unrelated or failed tools', () => {
  for (const patch of [{role: 'user'}, {toolName: 'send_attachment'}, {isError: true}]) {
    const source = context(); Object.assign(source.messages[1]!, patch);
    assert.throws(() => prepareNativeVideoRequest(transport().model, source), /Invalid native video attachment message/);
  }
});
