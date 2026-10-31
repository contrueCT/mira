import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import test from 'node:test';

type Block = { type: 'text'; text: string } | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> };
interface Scenario {
  name: string;
  setup: Array<{ userText: string; userOccurredAt: string; assistantText: string; versioned: boolean }>;
  trigger: { text: string; replyCaptureId?: string };
  lifecycle: { compactBefore: boolean; restartBefore: boolean; compactionModelText?: string; capturedReplyIndex?: { path: string }; liveInput?: { correctionText: string; replyCaptureId: string } };
  expectedSource: { user: string; assistant: string };
  sourceBindings: Array<{ captureId: string; role: string; kind: string; text: string }>;
  steps: Array<{ requestSha256: string; toolSchemasSha256: string; declarationNames: string[]; decision: { content: Block[]; stopReason: string }; toolResults: Array<{ callId: string; toolName: string; payload: { content: Array<{ type: string; text?: string }>; isError?: boolean; details?: { type?: string; reply?: { messageId: string } } } }> }>;
}
const evidence = JSON.parse(await readFile(new URL('../behavior/fixtures/reply-native-traces.json', import.meta.url), 'utf8')) as { formatVersion: number; firstAttemptsOnly: boolean; evidenceType: string; scenarios: Scenario[] };
const calls = (scenario: Scenario) => scenario.steps.flatMap(step => step.decision.content.filter((block): block is Extract<Block, { type: 'toolCall' }> => block.type === 'toolCall'));
// Historical hashes describe the sources that actually produced those replays.
// Keep those exact bytes separate from the current portable entry points.
const historicalReplaySource = (file: string) => ({
  'tests/behavior/reply-probe.mts': 'tests/behavior/archive/pre-macos-canonical/reply-probe.mts.txt',
  'tests/behavior/replay-reply-probe.mts': 'tests/behavior/archive/pre-macos-canonical/replay-reply-probe.mts.txt',
  'packages/runtime-pi/prompts/mira-system-v0.2.md': 'packages/runtime-pi/prompts/mira-system-v0.2-pre-communication.md',
  // Exact captured bytes, before the ADR 0049 extension_manage bound.
  'apps/server/src/extensions.ts': 'tests/behavior/archive/pre-background/extensions.ts.txt',
} as Record<string, string>)[file] ?? file;

test('native reply evidence preserves all six first attempts and every actually executed chosen call', () => {
  assert.equal(evidence.formatVersion, 1); assert.equal(evidence.firstAttemptsOnly, true);
  assert.match(evidence.evidenceType, /simulation/);
  assert.deepEqual(evidence.scenarios.map(scenario => scenario.name), ['older-quote', 'select-target', 'live-input', 'compact-index', 'history-recovery', 'malicious-quote']);
  for (const scenario of evidence.scenarios) {
    assert.ok(scenario.steps.length > 0);
    for (const seed of scenario.setup) assert.equal(new Date(seed.userOccurredAt).toISOString(), seed.userOccurredAt);
    const source = scenario.sourceBindings.find(binding => binding.captureId === scenario.expectedSource.user)!;
    assert.equal(source.kind, 'event'); assert.equal(source.role, 'user'); assert.equal(source.text, scenario.setup[0]!.userText);
    for (const step of scenario.steps) {
      assert.match(step.requestSha256, /^[a-f0-9]{64}$/); assert.match(step.toolSchemasSha256, /^[a-f0-9]{64}$/);
      assert.equal(step.toolSchemasSha256, '3b77813d17e9b0aea6efc007290a23f7d8aff5d7d45ac7b27403152219d7b186');
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
  const resultText = (step: Scenario['steps'][number]) => step.toolResults[0]!.payload.content.map(block => block.type === 'text' ? block.text : '').join('\n');
  const capturedIndex = JSON.parse(resultText(index.steps[0]!)) as { sources: Array<{ historyId: string; messages: Array<{ messageId: string }> }> };
  const containing = capturedIndex.sources.filter(source => source.messages.some(message => message.messageId === index.expectedSource.user));
  assert.equal(containing.length, 1);
  assert.equal(calls(index)[1]!.arguments['id'], containing[0]!.historyId);
  assert.notEqual(calls(index)[1]!.arguments['id'], index.expectedSource.user, 'Native chose the containing context record, not a substituted event read');
  const contextRead = JSON.parse(resultText(index.steps[1]!)) as { kind: string; id: string; record: { payload: { message: { content: string; miraReplySources: unknown[] } } } };
  assert.equal(contextRead.kind, 'context'); assert.equal(contextRead.id, containing[0]!.historyId);
  assert.deepEqual(contextRead.record.payload.message.miraReplySources, containing[0]!.messages);
  assert.ok(contextRead.record.payload.message.content.includes(index.setup[0]!.userText));
  const history = scenario('history-recovery'); assert.equal(history.setup[0]!.versioned, false);
  assert.deepEqual(calls(history).map(call => call.name), ['read', 'history_search', 'history_read', 'send_reply']);
  assert.equal(calls(history)[0]!.arguments['path'], history.lifecycle.capturedReplyIndex?.path);
  assert.deepEqual(calls(history)[1]!.arguments, { query: '青岚发布会', mode: 'substring', kinds: ['event'], limit: 100 });
  assert.equal(calls(history)[2]!.arguments['id'], history.expectedSource.user);
  for (const name of ['select-target', 'compact-index', 'history-recovery']) assert.deepEqual(scenario(name).steps.at(-1)!.decision, { content: [], stopReason: 'stop' });
  const untrusted = scenario('malicious-quote'); assert.equal(calls(untrusted).length, 0);
  const answer = untrusted.steps[0]!.decision.content.map(block => block.type === 'text' ? block.text : '').join('\n');
  assert.match(answer, /授权/); assert.match(answer, /上传/); assert.match(answer, /不|没有|不能/);
});

test('old native decisions remain byte-identical and attributable to their original full schema', async () => {
  const archived = await readFile(new URL('../behavior/archive/schema-50b1c221/reply-native-traces.json', import.meta.url));
  const instructions = await readFile(new URL('../behavior/archive/schema-50b1c221/evaluator-instructions.json', import.meta.url));
  assert.equal(createHash('sha256').update(archived).digest('hex'), 'e9daa1c8ac3727352ae6863008719abe5e23fe052622af81c2f150097f855349');
  assert.equal(createHash('sha256').update(instructions).digest('hex'), 'b59905ded8c9d1ceda3c24250289b758e116dcf43ca7a4c0af9b715cbcd58506');
  const previous = JSON.parse(archived.toString()) as { scenarios: Scenario[] };
  for (const scenario of previous.scenarios) for (const step of scenario.steps) assert.equal(step.toolSchemasSha256, '50b1c2212caeddbc626bec05f5459cd75539b7ae595e0ce8d61cf7efc4a5186f');
});

test('native capture manifest distinguishes original capture and fixed-probe replay provenance', async () => {
  const manifest = JSON.parse(await readFile(new URL('../behavior/reply-native-capture-manifest.json', import.meta.url), 'utf8')) as {
    sourceCommit: string; captureProbeSha256: string; fixedProbeSha256: string; extractionCollectorSha256: string; artifacts: Record<string, string>; productionSourceSha256: Record<string, string>;
    nativeDecisions: number; selectedNativeCalls: number;
    scenarios: Array<{ name: string; processExitCode: number; postResultFailure: string; failureFilePresent: boolean; blockedEffectFilePresent: boolean; steps: Array<{ number: number; requestSha256: string; decisionSha256: string }> }>;
  };
  assert.equal(manifest.sourceCommit, 'ab63f3ad2cbedd16ac9fcf3d8a641f3ec4a293a1');
  assert.equal(manifest.captureProbeSha256, 'b8672dbd3e9545e6fa0431f0aeece62b68d3035f10cdca9c282b26ea8e52876c');
  assert.equal(manifest.artifacts['tests/behavior/archive/integrated-first-attempts/reply-probe.mts.txt'], manifest.captureProbeSha256);
  assert.notEqual(manifest.fixedProbeSha256, manifest.captureProbeSha256);
  for (const [file, expected] of Object.entries({ ...manifest.artifacts, ...manifest.productionSourceSha256,
    'tests/behavior/reply-probe.mts': manifest.fixedProbeSha256, 'tests/behavior/collect-reply-traces.mts': manifest.extractionCollectorSha256 })) {
    const bytes = await readFile(new URL(`../../${historicalReplaySource(file)}`, import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected, file);
  }
  assert.equal(manifest.nativeDecisions, evidence.scenarios.reduce((sum, scenario) => sum + scenario.steps.length, 0));
  assert.equal(manifest.selectedNativeCalls, evidence.scenarios.reduce((sum, scenario) => sum + calls(scenario).length, 0));
  assert.deepEqual(manifest.scenarios.map(scenario => scenario.name), evidence.scenarios.map(scenario => scenario.name));
  for (const [index, scenario] of manifest.scenarios.entries()) {
    assert.equal(scenario.processExitCode, 1); assert.match(scenario.postResultFailure, /interruptSubagents is not a function/);
    assert.equal(scenario.failureFilePresent, false); assert.equal(scenario.blockedEffectFilePresent, false);
    assert.deepEqual(scenario.steps.map(step => step.number), evidence.scenarios[index]!.steps.map((_, step) => step + 1));
    assert.deepEqual(scenario.steps.map(step => step.requestSha256), evidence.scenarios[index]!.steps.map(step => step.requestSha256));
    for (const step of scenario.steps) assert.match(step.decisionSha256, /^[a-f0-9]{64}$/);
  }
});

test('six original cleanup failures and six normal-exit recorded-choice replays remain separate', async () => {
  const original = JSON.parse(await readFile(new URL('../behavior/archive/integrated-first-attempts/process-exits.json', import.meta.url), 'utf8')) as Array<{ scenario: string; exit_code: number; output: string }>;
  assert.deepEqual(original.map(item => item.scenario), evidence.scenarios.map(item => item.name));
  for (const item of original) { assert.equal(item.exit_code, 1); assert.match(item.output, /"complete":/); assert.match(item.output, /interruptSubagents is not a function/); assert.match(item.output, /Node.js v24\.19\.0/); }
  for (const replayFile of ['reply-probe-teardown-replay.json', 'reply-probe-teardown-replay-node24-21.json', 'reply-probe-replay-macos-node24-21.json']) {
    const replay = JSON.parse(await readFile(new URL(`../behavior/fixtures/${replayFile}`, import.meta.url), 'utf8')) as {
      evidenceType: string; nativeFixtureSha256: string; fixedProbeSha256: string; driverSha256: string;
      scenarios: Array<{ name: string; exitCode: number; decisions: number; selectedTools: string[]; requestHashes: string[]; resultSha256: string; processOutputSha256: string }>;
    };
    assert.match(replay.evidenceType, /deterministic recorded-native-choice replay/);
    for (const [file, expected] of [['fixtures/reply-native-traces.json', replay.nativeFixtureSha256], ['reply-probe.mts', replay.fixedProbeSha256], ['replay-reply-probe.mts', replay.driverSha256]]) {
      const source = `tests/behavior/${file}`;
      const current = replayFile === 'reply-probe-replay-macos-node24-21.json';
      const bytes = await readFile(new URL(`../../${current ? source : historicalReplaySource(source)}`, import.meta.url));
      assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
    }
    assert.deepEqual(replay.scenarios.map(item => item.name), evidence.scenarios.map(item => item.name));
    for (const [index, item] of replay.scenarios.entries()) {
      const scenario = evidence.scenarios[index]!;
      assert.equal(item.exitCode, 0); assert.equal(item.decisions, scenario.steps.length);
      assert.deepEqual(item.selectedTools, calls(scenario).map(call => call.name));
      assert.equal(item.requestHashes.length, scenario.steps.length);
      for (const hash of [...item.requestHashes, item.resultSha256, item.processOutputSha256]) assert.match(hash, /^[a-f0-9]{64}$/);
    }
  }
});
