/** Produces compact, synthetic-only evidence. Full provider requests stay outside source. */
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { getCurrentTools } from '@earendil-works/pi-ai';
import type { Context } from '@earendil-works/pi-ai';
import type { HistoryEntry, ToolIntent, ToolOutcome } from '@mira/life';
import { visible } from '../../apps/server/src/web-service.ts';
import type { RuntimeRecord } from '@mira/context';
import type { Decision } from './reply-probe.mts';

const roots = process.argv.slice(2);
if (!roots.length) throw Error('Supply completed /tmp/mira-reply-probe-* directories');
const scenarios = [];
for (const root of roots) {
  if (!root.startsWith('/tmp/mira-reply-probe-')) throw Error('Only synthetic probe directories are accepted');
  const result = JSON.parse(await readFile(path.join(root, 'result.json'), 'utf8')) as { scenario: string; decisions: Array<{ number: number; decision: Decision }>; entries: HistoryEntry[]; executions: Array<{ intent: ToolIntent; outcome: ToolOutcome | null }>; expectedSource: { user: string; assistant: string }; records: RuntimeRecord[]; declarationNames: string[]; limitation: string };
  const bindings = result.entries.flatMap(entry => { const item = visible(entry); return item && item.role !== 'notice' ? [{ captureId: entry.id, kind: entry.kind, role: item.role, text: item.text }] : []; });
  const steps = [];
  for (const { number, decision } of result.decisions) {
    const raw = await readFile(path.join(root, `request-${number}.json`), 'utf8');
    const request = JSON.parse(raw) as Pick<Context, 'messages'>;
    const toolIds = decision.content.flatMap(block => block.type === 'toolCall' ? [block.id] : []);
    const toolResults = result.executions.filter(execution => toolIds.includes(execution.intent.callId)).map(({ intent, outcome }) => ({ callId: intent.callId, toolName: intent.toolName, payload: outcome?.payload ?? null }));
    const tools = getCurrentTools(request.messages);
    steps.push({ requestSha256: createHash('sha256').update(raw).digest('hex'), toolSchemasSha256: createHash('sha256').update(JSON.stringify(tools)).digest('hex'), declarationNames: tools.map(tool => tool.name), decision, toolResults });
  }
  const events = result.entries.filter((entry): entry is Extract<HistoryEntry, { kind: 'event' }> => entry.kind === 'event');
  const live = result.scenario === 'live-input';
  const setupCount = events.length - (live ? 2 : 1);
  const pastAnswers = bindings.filter(binding => binding.kind === 'context' && binding.role === 'assistant').slice(0, setupCount);
  const setup = events.slice(0, setupCount).map((event, index) => {
    const payload = event.event.payload as { text: string; messageFormatVersion?: number };
    if (!pastAnswers[index]) throw Error('Missing captured historical assistant response');
    return { userText: payload.text, assistantText: pastAnswers[index]!.text, versioned: payload.messageFormatVersion === 1 };
  });
  const currentPayload = events[setupCount]!.event.payload as { text: string; reply?: { messageId: string } };
  const trigger = { text: currentPayload.text, ...(currentPayload.reply ? { replyCaptureId: currentPayload.reply.messageId } : {}) };
  const checkpoint = result.records.find(record => record.kind === 'checkpoint' && (record.payload as { type?: string }).type === 'compaction');
  const correction = live ? events.at(-1)!.event.payload as { text: string; reply: { messageId: string } } : undefined;
  const setupTool = live ? result.executions.find(execution => execution.intent.callId === 'setup-live-delay')!.intent : undefined;
  const lifecycle = { compactBefore: !!checkpoint, restartBefore: !!checkpoint, offlineRestartKind: checkpoint ? 'new PiDurableRuntime.recover against the same in-memory snapshot' : null,
    ...(checkpoint ? { compactionModelText: (checkpoint.payload as { summary: string }).summary.split('\n\n[Immutable reply source index;')[0], capturedReplyIndex: (checkpoint.payload as { miraReplyIndex?: unknown }).miraReplyIndex } : {}),
    ...(correction && setupTool ? { liveInput: { initialText: currentPayload.text, correctionText: correction.text, replyCaptureId: correction.reply.messageId, setupTool: { name: setupTool.toolName, arguments: setupTool.arguments } } } : {}) };
  scenarios.push({ name: result.scenario, setup, trigger, lifecycle, sourceBindings: bindings, steps, expectedSource: result.expectedSource, limitations: result.limitation });
}
const destination = path.resolve('tests/behavior/fixtures/reply-native-traces.json');
await mkdir(path.dirname(destination), { recursive: true });
await writeFile(destination, JSON.stringify({ formatVersion: 1, evidenceType: 'native-model behavioral simulation with real Pi runtime and tool handlers', evaluator: { fork: 'none', reasoningEffort: 'xhigh', model: 'Inherited platform native model; not the configured Mira provider' }, firstAttemptsOnly: true, scenarios }, null, 2) + '\n');
console.log(destination);
