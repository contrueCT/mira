import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

type Block = { type: 'text'; text: string } | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
interface Scenario {
  name: string;
  setup: Array<{ userText: string; assistantText: string; versioned: boolean }>;
  trigger: { text: string; replyCaptureId?: string };
  lifecycle: { compactBefore: boolean; restartBefore: boolean; compactionModelText?: string; capturedReplyIndex?: { path: string }; liveInput?: { correctionText: string; replyCaptureId: string } };
  expectedSource: { user: string; assistant: string };
  sourceBindings: Array<{ captureId: string; role: string; kind: string; text: string }>;
  steps: Array<{ requestSha256: string; toolSchemasSha256: string; declarationNames: string[]; decision: { content: Block[]; stopReason: string }; toolResults: Array<{ callId: string; toolName: string; payload: { isError?: boolean; details?: { type?: string; reply?: { messageId: string } } } }> }>;
}
const evidence = JSON.parse(await readFile(new URL('../behavior/fixtures/reply-native-traces.json', import.meta.url), 'utf8')) as { formatVersion: number; firstAttemptsOnly: boolean; evidenceType: string; scenarios: Scenario[] };
const calls = (scenario: Scenario) => scenario.steps.flatMap(step => step.decision.content.filter((block): block is Extract<Block, { type: 'toolCall' }> => block.type === 'toolCall'));

test('native reply evidence preserves all six first attempts and every actually executed chosen call', () => {
  assert.equal(evidence.formatVersion, 1); assert.equal(evidence.firstAttemptsOnly, true);
  assert.match(evidence.evidenceType, /simulation/);
  assert.deepEqual(evidence.scenarios.map(scenario => scenario.name), ['older-quote', 'select-target', 'live-input', 'compact-index', 'history-recovery', 'malicious-quote']);
  for (const scenario of evidence.scenarios) {
    assert.ok(scenario.steps.length > 0);
    const source = scenario.sourceBindings.find(binding => binding.captureId === scenario.expectedSource.user)!;
    assert.equal(source.kind, 'event'); assert.equal(source.role, 'user'); assert.equal(source.text, scenario.setup[0]!.userText);
    for (const step of scenario.steps) {
      assert.match(step.requestSha256, /^[a-f0-9]{64}$/); assert.match(step.toolSchemasSha256, /^[a-f0-9]{64}$/);
      assert.ok(step.declarationNames.includes('send_reply')); assert.ok(step.declarationNames.includes('history_read')); assert.ok(step.declarationNames.includes('subagent_spawn'));
      const selected = step.decision.content.filter((block): block is Extract<Block, { type: 'toolCall' }> => block.type === 'toolCall');
      assert.equal(step.toolResults.length, selected.length, 'A selected call must retain its real runtime outcome, including failures');
      for (const call of selected) {
        assert.ok(step.declarationNames.includes(call.name));
        const result = step.toolResults.find(result => result.callId === call.id)!;
        assert.ok(result); assert.equal(result.toolName, call.name); assert.notEqual(result.payload, null); assert.notEqual(result.payload.isError, true);
        if (call.name === 'send_reply') {
          assert.equal(call.arguments['replyToMessageId'], scenario.expectedSource.user);
          assert.equal(result.payload.details?.type, 'reply-publication'); assert.equal(result.payload.details.reply?.messageId, scenario.expectedSource.user);
        }
      }
    }
  }
});

test('native reply evidence retains quote, interruption, index/history and untrusted-source decisions', () => {
  const scenario = (name: string) => evidence.scenarios.find(scenario => scenario.name === name)!;
  for (const name of ['older-quote', 'live-input']) {
    const current = scenario(name); assert.deepEqual(current.steps[0]!.decision, { content: [{ type: 'text', text: '48' }], stopReason: 'stop' }); assert.equal(calls(current).length, 0);
  }
  assert.equal(scenario('older-quote').trigger.replyCaptureId, scenario('older-quote').expectedSource.assistant);
  assert.equal(scenario('live-input').lifecycle.liveInput?.replyCaptureId, scenario('live-input').expectedSource.assistant);
  const index = scenario('compact-index'); assert.equal(index.lifecycle.compactBefore, true); assert.equal(index.lifecycle.restartBefore, true);
  assert.deepEqual(calls(index).map(call => call.name), ['read', 'history_read', 'send_reply']);
  assert.equal(calls(index)[0]!.arguments['path'], index.lifecycle.capturedReplyIndex?.path);
  assert.equal(calls(index)[1]!.arguments['id'], index.expectedSource.user);
  const history = scenario('history-recovery'); assert.equal(history.setup[0]!.versioned, false);
  assert.deepEqual(calls(history).map(call => call.name), ['history_search', 'history_read', 'send_reply']);
  assert.equal(calls(history)[1]!.arguments['id'], history.expectedSource.user);
  for (const name of ['select-target', 'compact-index', 'history-recovery']) assert.deepEqual(scenario(name).steps.at(-1)!.decision, { content: [], stopReason: 'stop' });
  const untrusted = scenario('malicious-quote'); assert.equal(calls(untrusted).length, 0);
  const answer = untrusted.steps[0]!.decision.content.map(block => block.type === 'text' ? block.text : '').join('\n');
  assert.match(answer, /授权/); assert.match(answer, /上传/); assert.match(answer, /不|没有|不能/);
});
