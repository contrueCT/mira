import type { SubagentRecord, SubagentActivityEvent, HistoryContext, HistoryEntry, HistoryRunPage } from '@mira/life';
import type { ExtensionHost, ExtensionStatus } from '@mira/extension-host';
import { decodeRecords } from '@mira/runtime-pi';
import type { AssistantReplyView, ExtensionView, MemoryReceiptView, RunExecutionView, ChildActivityView, ChildDetailView } from './management.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function memoryReceipt(memory: HistoryRunPage['memory']): MemoryReceiptView {
  if (!memory) return { state: 'unavailable', commit: null };
  if (!memory.receipt) return { state: 'pending', commit: null };
  return { state: memory.receipt.commit === null ? 'unchanged' : 'changed', commit: memory.receipt.commit };
}
export function assistantReply(entry: HistoryEntry | null): AssistantReplyView | null {
  if (entry?.kind !== 'context') return null;
  const [record] = decodeRecords([entry.record], entry.record.parentId);
  if (record?.type !== 'message' || record.message.role !== 'assistant') return null;
  return { id: entry.id, text: record.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), occurredAt: entry.occurredAt };
}
export function extensionView(entry: ExtensionStatus, host: ExtensionHost): ExtensionView {
  const latestFailure = host.changeStatus().findLast(receipt => receipt.extensionId === entry.id)?.status === 'failed';
  return { id: entry.id, revision: host.managementRevision(entry.id), enabled: entry.enabled, status: entry.status,
    activation: entry.activation, tools: [...entry.tools], contextProviders: [...entry.contextProviders],
    generated: entry.generated ? { digest: entry.generated.digest, revision: entry.generated.revision,
      history: entry.generated.history.map(revision => ({ id: revision.id, digest: revision.digest })) } : null,
    error: entry.diagnostic === null && !latestFailure ? null : 'Extension reported a problem. Raw diagnostics are hidden to protect configuration and secrets.' };
}
export function runExecution(entry: HistoryEntry): RunExecutionView | null {
  const base = { id: entry.id, occurredAt: entry.occurredAt };
  if (entry.kind === 'tool') {
    const outcome = entry.outcome?.payload;
    const known = object(outcome) && outcome['role'] === 'toolResult' && typeof outcome['isError'] === 'boolean';
    return { ...base, kind: 'tool', name: entry.intent.toolName,
      status: !known ? 'unknown' : outcome['isError'] ? 'failed' : 'succeeded',
      error: known && outcome['isError'] ? 'The persisted tool result reports an error. Raw arguments and results are hidden.' : null };
  }
  if (entry.kind !== 'context') return null;
  return contextExecution(entry, base);
}
function contextExecution(entry: HistoryContext, base: { id: string; occurredAt: string }): RunExecutionView | null {
  const [record] = decodeRecords([entry.record], entry.record.parentId);
  if (record?.type === 'compaction') return { ...base, kind: 'compaction', name: null, status: 'completed', error: null };
  if (record?.type === 'custom_message') return { ...base, kind: 'recovery', name: null, status: 'recorded',
    error: 'A persisted recovery observation records an unknown or not-started tool operation. Raw details are hidden.' };
  if (record?.type !== 'message' || record.message.role !== 'assistant') return null;
  const message = record.message;
  return { ...base, kind: 'model', name: `${message.provider}/${message.model}`, status: message.stopReason,
    error: message.stopReason === 'error' || message.stopReason === 'aborted' ? 'The persisted model response reports an interruption. Raw errors are hidden.' : null };
}

/** Defense in depth for common credential literals in explicitly public text.
 * This is not a general classifier for arbitrary private natural language. */
export function publicChildText(text: string): string {
  return text
    .replace(/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, '[credential redacted]')
    .replace(/\b(Bearer)\s+[A-Za-z0-9._~+\/-]{12,}=*/gi, '$1 [redacted]')
    .replace(/\b(api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?[^\s"',;]+/gi, '$1=[redacted]');
}
/** Public child events are explicit runtime/worker projections. Never decode
 * hidden model blocks, original assignments, tool arguments or spool paths. */
export function childActivity(event: SubagentActivityEvent): ChildActivityView {
  return { sequence: event.sequence, occurredAt: event.occurredAt, source: event.source, kind: event.kind,
    phase: event.phase, name: event.name, status: event.status, text: event.text === null ? null : publicChildText(event.text) };
}
export function childDetail(child: SubagentRecord, runId: string): ChildDetailView {
  const current = child.turns.find(turn => turn.status === 'running') ?? child.turns.find(turn => turn.status === 'queued') ?? child.turns.at(-1);
  const recent = new Set(child.turns.slice(-8).map(turn => turn.id));
  const shown = child.turns.filter(turn => recent.has(turn.id) || turn.status === 'running');
  return { id: child.id, runId, title: publicChildText(child.spec.title ?? '子任务'), createdAt: child.createdAt,
    status: current?.status ?? 'unknown', current: current?.activity.current ? childActivity(current.activity.current) : null,
    updatedAt: current?.activity.updatedAt ?? null,
    turns: shown.map(turn => ({ id: turn.id, sequence: turn.sequence, status: turn.status,
      createdAt: turn.createdAt, startedAt: turn.startedAt, finishedAt: turn.finishedAt,
      activities: turn.activity.events.map(childActivity), droppedActivities: turn.activity.dropped,
      result: turn.result ? { text: publicChildText(turn.result.text), truncated: turn.result.truncated } : null })),
    olderTurns: Math.max(0, child.turnCount - shown.length) };
}
