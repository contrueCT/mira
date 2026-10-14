import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { createModelTransport } from '@mira/server';
import { TOOL_OUTPUT_TEXT_BYTES } from '../../packages/runtime-pi/src/tool-output.ts';
import { assistant, effectTool, input, runtime, scripted, streamOf, toolCalls, MemoryWriter } from '../recovery/fixtures.mts';
import { fullOutput, outputPath, outputSpool } from '../recovery/tool-output-fixtures.mts';

function response(api: string): Response {
  const item = { id: 'msg-budget', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Read bounded evidence.', annotations: [] }] };
  const events = api === 'google-generative-ai'
    ? [{ candidates: [{ content: { role: 'model', parts: [{ text: 'Read bounded evidence.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 } }]
    : api === 'openai-responses' ? [
      { type: 'response.created', response: { id: 'resp-budget', status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'resp-budget', status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } },
    ] : [{ id: 'resp-budget', choices: [{ index: 0, delta: { role: 'assistant', content: 'Read bounded evidence.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
function wireText(api: string, body: Record<string, any>): string {
  if (api === 'openai-completions') return body['messages'].find((item: any) => item.role === 'tool').content;
  if (api === 'openai-responses') return body['input'].find((item: any) => item.type === 'function_call_output').output;
  return body['contents'].flatMap((item: any) => item.parts).find((part: any) => part.functionResponse).functionResponse.response.output;
}

for (const api of ['openai-completions', 'openai-responses', 'google-generative-ai'] as const) {
  for (const mode of ['empty', 'short', 'single', ...(api === 'google-generative-ai' ? ['native-mixed'] : [])]) {
    test(`actual ${api} wire bounds ${mode} text separators before and after recovery`, async t => {
      const root = await mkdtemp('/tmp/mira-tool-output-wire-');
      try {
        const writer = new MemoryWriter(), bytes = Buffer.from('synthetic video bytes');
        const references = Array.from({ length: 2 }, (_, index) => ({ id: randomUUID(), name: `clip-${index}.mp4`, mimeType: 'video/mp4', size: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'), path: `/private/clip-${index}.mp4` }));
        const content: ToolResultMessage['content'] = mode === 'single' ? [{ type: 'text', text: 'a'.repeat(30_000) }]
          : Array.from({ length: 25_000 }, () => ({ type: 'text', text: mode === 'empty' ? '' : 'a' }));
        const opaque = { type: 'text' as const, text: 'opaque-before', textSignature: 'preserved-signature', opaque: { receipt: 42 } };
        const image = { type: 'image' as const, data: Buffer.from('synthetic-image').toString('base64'), mimeType: 'image/png' };
        if (mode === 'native-mixed') content.splice(0, 0, opaque, image);
        const returned = { content, details: mode === 'native-mixed' ? { version: 1, type: 'attachment-read', attachments: references } : { original: true } };
        let effects = 0, wireCalls = 0, resolves = 0, requests = 0;
        const fetch: typeof globalThis.fetch = async (_url, init) => {
          wireCalls++;
          const body = JSON.parse(String(init?.body)), text = wireText(api, body);
          assert.equal(Buffer.byteLength(text), TOOL_OUTPUT_TEXT_BYTES, 'actual SDK text includes every separator, notice and hydration annotation');
          assert.match(text, /Full original result/);
          if (mode === 'native-mixed') {
            const parts = body.contents.flatMap((item: any) => item.parts);
            const videos = parts.filter((part: any) => part.inlineData?.mimeType === 'video/mp4');
            assert.equal(videos.length, 2);
            for (const video of videos) assert.equal(video.inlineData.data, bytes.toString('base64'));
            assert.ok(parts.some((part: any) => part.inlineData?.mimeType === 'image/png'));
            for (const reference of references) assert.ok(text.includes(reference.id));
          }
          return response(api);
        };
        if (api === 'google-generative-ai') t.mock.method(globalThis, 'fetch', fetch);
        const transport = api === 'google-generative-ai'
          ? createModelTransport({ builtinCredentials: { google: { apiKeyEnv: 'EXPLICIT_SYNTHETIC_KEY' } }, customConnections: [] }, { kind: 'builtin', provider: 'google', model: 'gemini-2.5-flash' }, { env: () => 'synthetic-key' })
          : createModelTransport({ builtinCredentials: {}, customConnections: [{ id: 'wire', baseUrl: 'https://synthetic.invalid/v1', api, apiKeyEnv: 'EXPLICIT_SYNTHETIC_KEY', models: [{ id: 'wire-model', contextWindow: 200_000, maxTokens: 512, reasoning: false, input: ['text', 'image'] }] }] }, { kind: 'custom', connection: 'wire', model: 'wire-model' }, { env: () => 'synthetic-key', fetch });
        const name = mode === 'native-mixed' ? 'read' : 'effect';
        const options = { model: transport.model, autoCompaction: { enabled: false }, writeOverflowInput: outputSpool(path.join(root, 'spool')),
          resolveAttachment: async () => { resolves++; return bytes; },
          tools: [{ ...effectTool(async () => { effects++; return returned; }), name }] };
        const state = await runtime(writer, async (model, context, streamOptions) => {
          requests++;
          if (requests === 1) return streamOf({ ...toolCalls('wire-result'), api: model.api, provider: model.provider, model: model.id,
            content: [{ type: 'toolCall', id: 'wire-result', name, arguments: {} }] });
          const output = context.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
          assert.ok(output.content.length < 10, 'plain text runs are repacked before hydration');
          if (mode === 'native-mixed') {
            assert.deepEqual(output.content[0], opaque); assert.deepEqual(output.content[1], image);
            const videos = (output as typeof output & { miraNativeVideos: Array<{ contentIndex: number; attachmentId: string }> }).miraNativeVideos;
            for (const video of videos) { const slot = output.content[video.contentIndex]; assert.ok(slot?.type === 'text'); assert.ok(slot.text.includes(video.attachmentId)); }
          }
          return transport.streamFn(model, context, streamOptions);
        }, options).run(input());
        assert.equal(effects, 1); assert.equal(wireCalls, 1); assert.equal(resolves, mode === 'native-mixed' ? 2 : 0);
        const output = state.messages.find(message => message.role === 'toolResult'); assert.ok(output?.role === 'toolResult');
        const canonical = await fullOutput(output); assert.deepEqual(canonical.content, content); assert.deepEqual(canonical.details, returned.details);
        assert.deepEqual(canonical, writer.state.executions[0]?.outcome?.payload); assert.ok(!('miraNativeVideos' in canonical));
        const target = outputPath(output), file = await readFile(target, 'utf8'), before = structuredClone(writer.state);
        await rm(target);
        assert.deepEqual((await runtime(writer, undefined, options).recover()).messages, state.messages);
        assert.equal(await readFile(target, 'utf8'), file); assert.deepEqual(writer.state, before);
        await runtime(writer, transport.streamFn, options).run(input('Review the existing evidence.'));
        assert.equal(wireCalls, 2); assert.equal(effects, 1);
        if (mode === 'empty') {
          const compacting = runtime(writer, scripted([assistant('Recent answer'), assistant(`Older evidence remains at ${target}`)]), options);
          await compacting.run(input('Recent question'));
          const compacted = await compacting.compact({ keepRecentTokens: 256, reserveTokens: 512 });
          assert.ok(!compacted.messages.some(message => message.role === 'toolResult'));
          await rm(target); await runtime(writer, undefined, options).recover();
          assert.equal(await readFile(target, 'utf8'), file); assert.equal(effects, 1);
        }
      } finally { await rm(root, { recursive: true, force: true }); }
    });
  }
}
