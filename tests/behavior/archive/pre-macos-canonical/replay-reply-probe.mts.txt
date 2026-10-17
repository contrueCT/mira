/** Deterministic replay of recorded native choices through the actual probe CLI.
 * Not a new native evaluation. Only uniquely verified source UUIDs and the
 * actual reconstructed index pathname are rebound; no result is supplied. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentTools, type Context } from '@earendil-works/pi-ai';
import type { HistoryEntry, ToolIntent, ToolOutcome } from '@mira/life';
import type { ReplyReference } from '@mira/cognition';
import { visible } from '../../apps/server/src/web-service.ts';
import { bindContextId, requireContextId, uniqueUserContextSource, verifyUserContextRecord, type UserContextSource } from './reply-context-binding.mts';
import type { Decision } from './reply-probe.mts';
import type { NativeTrace } from '../recovery/reply-native-fixture.mts';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const captureBytes = await readFile(new URL('./fixtures/reply-native-traces.json', import.meta.url));
const capture = JSON.parse(captureBytes.toString()) as { scenarios: NativeTrace[] };
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> => { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); return value as Record<string, unknown>; };
const textOf = (value: unknown): string => {
  const content = object(value)['content']; if (typeof content === 'string') return content;
  assert.ok(Array.isArray(content)); return content.map(object).filter(block => block['type'] === 'text').map(block => { assert.equal(typeof block['text'], 'string'); return block['text']; }).join('\n');
};
const prefix = process.argv[2];
assert.ok(prefix?.startsWith('/tmp/mira-reply-probe-') && path.isAbsolute(prefix), 'Supply a fresh /tmp/mira-reply-probe-* prefix');
const home = await mkdtemp('/tmp/mira-reply-recorded-choice-home-');
const summaries = [];
for (const trace of capture.scenarios) {
  const root = `${prefix}-${trace.name}`;
  await assert.rejects(access(root), { code: 'ENOENT' });
  const child = spawn(process.execPath, [path.join(sourceDirectory, 'tests/behavior/reply-probe.mts'), root, trace.name], { cwd: sourceDirectory,
    env: { PATH: process.env['PATH'], HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home,
      NODE_OPTIONS: `--import=${path.join(sourceDirectory, 'tests/deny-model-network.mts')}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', ended = false;
  child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
  const exited = new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('exit', code => { ended = true; resolve(code ?? -1); }); });
  const publicIds = new Map<string, string>(), contextIds = new Map<string, string>();
  const contextSources = new Map<string, { before: UserContextSource; after: UserContextSource }>();
  const emitted: Decision[] = [], requestHashes: string[] = [];
  const bindPublic = (actualId: string, kind: string, role: string, text: string) => {
    const definitions = trace.sourceBindings.filter(item => item.kind === kind && item.role === role && item.text === text);
    assert.equal(definitions.length, 1, 'Source must uniquely match kind/role/full text');
    bindContextId(publicIds, definitions[0]!.captureId, actualId);
  };
  const publicId = (captureId: string) => { const id = publicIds.get(captureId); assert.ok(id, `Unknown public source ${captureId}`); return id; };
  const bindReferences = (value: unknown) => {
    assert.ok(Array.isArray(value));
    for (const ref of value.map(object)) { assert.equal(ref['role'], 'user'); assert.equal(typeof ref['messageId'], 'string'); assert.equal(typeof ref['text'], 'string'); bindPublic(ref['messageId'] as string, 'event', 'user', ref['text'] as string); }
  };
  let indexPath: string | undefined;
  const deadline = Date.now() + 60_000;
  try {
    for (const [offset, step] of trace.steps.entries()) {
      const number = offset + 1, filename = path.join(root, `request-${number}.json`);
      while (true) {
        try { await access(filename); break; } catch { assert.equal(ended, false, output); assert.ok(Date.now() < deadline, 'Probe did not produce its next actual request'); await new Promise(resolve => setTimeout(resolve, 20)); }
      }
      const raw = await readFile(filename, 'utf8'); requestHashes.push(sha(raw));
      const request = JSON.parse(raw) as Pick<Context, 'messages'>;
      const tools = getCurrentTools(request.messages);
      assert.deepEqual(tools.map(tool => tool.name), step.declarationNames);
      assert.equal(sha(JSON.stringify(tools)), step.toolSchemasSha256, 'Full ordered tool schema parity');
      for (const message of request.messages) {
        const rawMessage = object(message);
        if (rawMessage['miraReplySources']) bindReferences(rawMessage['miraReplySources']);
      }
      for (const previous of trace.steps[offset - 1]?.toolResults ?? []) {
        const actual = request.messages.findLast(message => message.role === 'toolResult' && message.toolCallId === previous.callId);
        assert.ok(actual && actual.role === 'toolResult'); assert.equal(actual.toolName, previous.toolName); assert.equal(actual.isError, false);
        if (previous.toolName === 'read') {
          assert.ok(indexPath); assert.equal(textOf(actual), await readFile(indexPath, 'utf8'));
          const before = object(JSON.parse(textOf(previous.payload))), after = object(JSON.parse(textOf(actual)));
          assert.equal(after['type'], before['type']); assert.equal(after['version'], before['version']); assert.equal(after['notice'], before['notice']); assert.equal(after['previous'], null);
          assert.ok(Array.isArray(before['sources']) && Array.isArray(after['sources'])); assert.equal(after['sources'].length, before['sources'].length);
          for (const actualSource of after['sources'].map(object)) bindReferences(actualSource['messages']);
          for (const [index, value] of before['sources'].entries()) {
            const original = value as UserContextSource;
            const mapped = uniqueUserContextSource(before['sources'], after['sources'], original.historyId, original.messages.map(ref => ({ ...ref, messageId: publicId(ref.messageId) })));
            assert.deepEqual(mapped, after['sources'][index], 'Semantic match also preserves exact source order');
            bindContextId(contextIds, original.historyId, mapped.historyId); contextSources.set(original.historyId, { before: original, after: mapped });
          }
        } else if (previous.toolName === 'history_search') {
          const before = object(JSON.parse(textOf(previous.payload))), after = object(JSON.parse(textOf(actual)));
          assert.equal(after['query'], before['query']); assert.equal(after['mode'], before['mode']); assert.equal(after['hasMore'], before['hasMore']);
          assert.ok(Array.isArray(before['hits']) && Array.isArray(after['hits']));
          for (const value of after['hits']) {
            const hit = object(value); assert.equal(hit['kind'], 'event'); assert.equal(typeof hit['id'], 'string'); assert.equal(typeof hit['snippet'], 'string');
            const definitions = trace.sourceBindings.filter(binding => binding.kind === 'event' && binding.role === 'user' && (hit['snippet'] as string).includes(binding.text));
            assert.equal(definitions.length, 1, 'Search hit must contain exactly one complete known source text');
            bindPublic(hit['id'] as string, 'event', 'user', definitions[0]!.text);
          }
          assert.deepEqual(after['hits'].map(value => object(value)['id']).sort(), before['hits'].map(value => publicId(object(value)['id'] as string)).sort());
        }
      }
      const decision = structuredClone(step.decision);
      for (const block of decision.content) if (block.type === 'toolCall') {
        assert.ok(['read', 'history_search', 'history_read', 'send_reply'].includes(block.name));
        if (block.name === 'read') {
          assert.equal(block.arguments['path'], trace.lifecycle.capturedReplyIndex?.path);
          const candidates = request.messages.flatMap(message => [...textOf(message).matchAll(/Use ordinary read with ("(?:[^"\\]|\\.)*") \(\d+ UTF-8 bytes\)/gu)].map(match => JSON.parse(match[1]!) as string));
          assert.equal(candidates.length, 1); indexPath = candidates[0]!; assert.ok(indexPath.startsWith(`${root}/spool/`));
          block.arguments['path'] = indexPath;
        } else if (block.name === 'history_read' || block.name === 'send_reply') {
          const key = block.name === 'history_read' ? 'id' : 'replyToMessageId'; const id = block.arguments[key]; assert.equal(typeof id, 'string');
          block.arguments[key] = block.name === 'history_read' && contextIds.has(id as string) ? requireContextId(contextIds, id as string) : publicId(id as string);
        }
      }
      emitted.push(decision);
      await writeFile(path.join(root, `decision-${number}.json`), JSON.stringify(decision, null, 2) + '\n', { flag: 'wx' });
    }
    while (!ended) { assert.ok(Date.now() < deadline, 'Probe did not exit after recorded choices'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const exitCode = await exited; await writeFile(path.join(root, 'process-output.log'), output, { flag: 'wx' }); assert.equal(exitCode, 0, output);
    const resultBytes = await readFile(path.join(root, 'result.json'));
    const result = JSON.parse(resultBytes.toString()) as { status: string; decisions: Array<{ decision: Decision }>; entries: HistoryEntry[]; executions: Array<{ intent: ToolIntent; outcome: ToolOutcome | null }> };
    assert.equal(result.status, 'completed'); assert.deepEqual(result.decisions.map(item => item.decision), emitted);
    for (const [oldId, actualId] of publicIds) {
      const definition = trace.sourceBindings.find(item => item.captureId === oldId)!;
      const matches = result.entries.filter(entry => { const item = visible(entry); return entry.kind === definition.kind && item?.role === definition.role && item.text === definition.text; });
      assert.equal(matches.length, 1); assert.equal(matches[0]!.id, actualId, 'Mapped public source is the actual immutable original');
    }
    for (const [oldId, actualId] of contextIds) {
      const sources = contextSources.get(oldId)!; const record = result.entries.filter(entry => entry.id === actualId); assert.equal(record.length, 1);
      const setup = trace.setup.filter(seed => seed.versioned && seed.userText === sources.before.messages[0]!.text); assert.equal(setup.length, 1);
      verifyUserContextRecord(record[0]!, sources.after, setup[0]!.userOccurredAt);
    }
    const calls = emitted.flatMap(decision => decision.content.flatMap(block => block.type === 'toolCall' ? [block] : []));
    const executions = result.executions.filter(execution => execution.intent.callId !== 'setup-live-delay');
    assert.deepEqual(executions.map(execution => execution.intent.callId), calls.map(call => call.id));
    for (const [index, execution] of executions.entries()) {
      const call = calls[index]!; assert.equal(execution.intent.toolName, call.name); assert.deepEqual(execution.intent.arguments, call.arguments);
      const outcome = object(execution.outcome?.payload); assert.equal(outcome['isError'], false);
      if (call.name === 'history_read') {
        const returned = JSON.parse(textOf(outcome)) as HistoryEntry;
        assert.deepEqual(result.entries.find(entry => entry.id === returned.id), returned, 'Actual history tool returned its unchanged immutable source record');
      }
      if (call.name === 'send_reply') { const details = object(outcome['details']); assert.equal(details['text'], call.arguments['text']); assert.equal(object(details['reply'])['messageId'], call.arguments['replyToMessageId']); }
    }
    await assert.rejects(access(path.join(root, 'failure.json')), { code: 'ENOENT' }); await assert.rejects(access(path.join(root, 'blocked-effect.json')), { code: 'ENOENT' });
    summaries.push({ name: trace.name, evidenceType: 'deterministic recorded-native-choice replay; not a new native evaluation', directory: root, exitCode,
      decisions: emitted.length, selectedTools: calls.map(call => call.name), resultSha256: sha(resultBytes), processOutputSha256: sha(output), requestHashes,
      publicSourceBindings: Object.fromEntries(publicIds), contextSourceBindings: Object.fromEntries(contextIds), ...(indexPath ? { indexPath } : {}) });
    console.log(JSON.stringify({ replayed: trace.name, exitCode, decisions: emitted.length }));
  } catch (error) { if (!ended) child.kill('SIGTERM'); await exited; throw error; }
}
const summary = { formatVersion: 1, evidenceType: 'deterministic recorded-native-choice replay through full actual Pi probe CLI, including teardown',
  nativeFixtureSha256: sha(captureBytes), fixedProbeSha256: sha(await readFile(new URL('./reply-probe.mts', import.meta.url))), driverSha256: sha(await readFile(fileURLToPath(import.meta.url))), scenarios: summaries };
await writeFile(`${prefix}-summary.json`, JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(`${prefix}-summary.json`);
