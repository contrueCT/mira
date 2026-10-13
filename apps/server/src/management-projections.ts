import type { HistoryContext, HistoryEntry, HistoryRunPage } from '@mira/life';
import type { ExtensionHost, ExtensionStatus } from '@mira/extension-host';
import { decodeRecords } from '@mira/runtime-pi';
import type { AssistantReplyView, ExtensionView, MemoryReceiptView, RunExecutionView } from './management.ts';

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
