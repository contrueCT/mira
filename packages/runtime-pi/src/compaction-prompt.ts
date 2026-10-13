import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { buildSessionProjection, type SessionBeforeCompactEvent } from '@earendil-works/pi-coding-agent';
import { messageAttachments } from './attachments.ts';
import { jsonValue } from './records.ts';
import type { RecoveryOperation } from './observations.ts';

export const MIRA_COMPACTION_PROMPT_SHA256 = '6cb4c13e30d22270df01de8d1e02e597856c70bf8c930e5976b5d2fdec299cdb';
export const MIRA_COMPACTION_PROMPT = readFileSync(new URL('../prompts/mira-compaction-v0.1.md', import.meta.url), 'utf8');
if (createHash('sha256').update(MIRA_COMPACTION_PROMPT).digest('hex') !== MIRA_COMPACTION_PROMPT_SHA256) throw new Error('Mira compaction prompt hash mismatch');
export const MIRA_COMPACTION_MODES = {
  initial: '根据本次待压缩范围生成摘要，不假定存在更早的摘要或经历。保留原文仅作理解边界的参考。',
  update: '把旧摘要与新纳入压缩的内容合成一份当前摘要，按新证据修订和删减；不在旧摘要后不断追加小结。',
  split_turn: '本次范围在同一轮中途结束。准确保留这一轮的触发要求、已完成步骤、尚未知的结果及与保留尾部相接的指代；不要补出结尾或提前回答。若存在旧摘要，同时按递归规则处理。',
} as const;
export interface CompactionReferences { personaContext: string | null; memorySnapshot: string | null; }
/** Preserve evidence/roles, never provider-private signatures, usage or hidden
 * reasoning. Images remain explicit unavailable references, not invented prose. */
function sourceMessage(message: AgentMessage, historyId: string) {
  const value = message as unknown as Record<string, unknown>;
  const content = Array.isArray(value['content']) ? value['content'].flatMap((block: Record<string, unknown>): Record<string, unknown>[] => {
    if (block['type'] === 'thinking') return [];
    if (block['type'] === 'image') return [{ type: 'image', mimeType: block['mimeType'], omitted: true }];
    if (block['type'] === 'text') return [{ type: 'text', text: block['text'] }];
    if (block['type'] === 'toolCall') return [{ type: 'toolCall', id: block['id'], name: block['name'], arguments: block['arguments'] }];
    throw new Error('Unsupported content in compaction reference');
  }) : value['content'];
  return jsonValue({ history_id: historyId, role: message.role, timestamp: message.timestamp, content,
    ...(messageAttachments(message).length ? { attachment_source_history_id: historyId, attachment_count: messageAttachments(message).length, media_bytes_omitted: true } : {}),
    ...(message.role === 'toolResult' ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {}),
    ...(message.role === 'custom' ? { customType: message.customType } : {}) });
}
/** SDK owns the cut. Align the public preparation against its public projection
 * solely to attach existing History IDs; never derive another cut or invent IDs. */
export function compactionInput(event: SessionBeforeCompactEvent, references: CompactionReferences, summaryTokenBudget: number, operations: RecoveryOperation[]) {
  const projection = buildSessionProjection(event.branchEntries).entries;
  const cut = projection.findIndex(entry => entry.sourceEntry.id === event.preparation.firstKeptEntryId);
  if (cut < 0) throw new Error('Compaction boundary not found in SDK projection');
  const contributions = (start: number, end: number) => projection.slice(start, end).flatMap(entry => entry.sourceEntry.type === 'compaction' ? [] :
    entry.messages.filter(message => message.role !== 'system').map(message => ({ message, id: entry.sourceEntry.id })));
  const source = contributions(0, cut);
  const expected = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
  if (!isDeepStrictEqual(source.map(item => item.message), expected)) throw new Error('Compaction source differs from SDK preparation');
  const tail = contributions(cut, projection.length);
  const mode: keyof typeof MIRA_COMPACTION_MODES = event.preparation.isSplitTurn ? 'split_turn' : event.preparation.previousSummary === undefined ? 'initial' : 'update';
  return {
    mode,
    persona_context: references.personaContext,
    memory_snapshot: references.memorySnapshot,
    previous_summary: event.preparation.previousSummary ?? null,
    source_messages: source.map(item => sourceMessage(item.message, item.id)),
    retained_tail: { purpose: 'reference_only_not_summarized', messages: tail.map(item => sourceMessage(item.message, item.id)) },
    boundary: { first_kept_history_id: event.preparation.firstKeptEntryId, source_history_ids: [...new Set(source.map(item => item.id))], retained_history_ids: [...new Set(tail.map(item => item.id))] },
    summary_token_budget: summaryTokenBudget,
    recovery_operations: structuredClone(operations),
  };
}
