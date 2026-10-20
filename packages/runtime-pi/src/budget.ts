import { attachmentRequestPlans } from './attachments.ts';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { getCurrentSystemMessage, toToolDeclaration, type Api, type AssistantMessage, type Model } from '@earendil-works/pi-ai';
import { estimateTokens, convertToLlm } from '@earendil-works/pi-coding-agent';

export interface AutoCompactionOptions {
  enabled?: boolean;
  /** Fraction of the available input budget at which to compact. Default 0.8. */
  threshold?: number;
  /** Reserved and enforced maximum output tokens, bounded by model.maxTokens. */
  reserveTokens?: number;
  keepRecentTokens?: number;
}
export interface ContextBudget { enabled: boolean; threshold: number; reserveTokens: number; keepRecentTokens: number; inputTokens: number; }
export function contextBudget(model: Model<Api>, options: AutoCompactionOptions = {}): ContextBudget {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 2 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1) throw new Error('Invalid model context limits');
  const reserveTokens = options.reserveTokens ?? Math.min(model.maxTokens, Math.max(512, Math.floor(model.contextWindow * 0.1)), model.contextWindow - 1);
  const keepRecentTokens = options.keepRecentTokens ?? Math.min(20_000, Math.floor(model.contextWindow * 0.2));
  const threshold = options.threshold ?? 0.8;
  if (!Number.isSafeInteger(reserveTokens) || reserveTokens < 1 || reserveTokens > model.maxTokens || reserveTokens >= model.contextWindow ||
      !Number.isSafeInteger(keepRecentTokens) || keepRecentTokens < 1 || keepRecentTokens >= model.contextWindow - reserveTokens ||
      !Number.isFinite(threshold) || threshold <= 0 || threshold > 1 || (options.enabled !== undefined && typeof options.enabled !== 'boolean')) throw new Error('Invalid automatic compaction budget');
  return { enabled: options.enabled ?? true, threshold, reserveTokens, keepRecentTokens, inputTokens: model.contextWindow - reserveTokens };
}
// Han, kana, Hangul, CJK punctuation/symbols and fullwidth forms. Common
// tokenizers spend roughly 0.6–1.5 tokens per such character, not 0.25.
const cjk = /[\u2E80-\u2FDF\u3000-\u30FF\u3100-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF]|[\u{20000}-\u{3134F}]/gu;
/** Extra tokens for CJK characters beyond Pi's chars/4 (counts 1 token each). */
export const CJK_TOKENS_PER_CHARACTER = 1;
export function cjkCharacters(text: string): number { return text.match(cjk)?.length ?? 0; }
function cjkSurcharge(value: unknown): number {
  const count = cjkCharacters(typeof value === 'string' ? value : JSON.stringify(value) ?? '');
  return Math.ceil(count * (CJK_TOKENS_PER_CHARACTER - 0.25));
}
/** Pi's chars/4 message heuristic with a conservative CJK correction. */
export function estimateMessageTokens(message: AgentMessage): number {
  return estimateTokens(message) + cjkSurcharge(message);
}
/** Pi's public heuristic with a conservative CJK correction, plus protocol
 * overhead and the actual current tool schemas. It is an estimate, not a
 * tokenizer or a provider usage guarantee. Declarations already present in
 * system deltas may be counted twice, safely. */
export function estimateRequestTokens(messages: AgentMessage[], tools: AgentTool[] = [], model?: Model<Api>): number {
  const plans = model ? attachmentRequestPlans(convertToLlm(messages), model) : messages.map(message => ({message,media:[]}));
  const declarations = JSON.stringify(tools.map(tool => toToolDeclaration(tool)));
  return plans.reduce((total, plan) => total + estimateMessageTokens(plan.message as AgentMessage) + 8 + plan.media.reduce((sum,item)=>sum+(item.kind==='image'?4096:16384),0), 0)
    + Math.ceil(declarations.length / 4) + cjkSurcharge(declarations) + 32;
}
/** Provider-reported tokens of a successful response from this exact model.
 * Error/aborted turns and other models are not a valid baseline. */
function usageTokens(message: AgentMessage, model: Model<Api>): number | undefined {
  if (message.role !== 'assistant') return undefined;
  const value = message as AssistantMessage;
  if (value.stopReason === 'error' || value.stopReason === 'aborted' || value.provider !== model.provider || value.model !== model.id) return undefined;
  const usage = value.usage;
  if (!usage) return undefined;
  const parts = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  if (!parts.every(part => Number.isSafeInteger(part) && part >= 0)) return undefined;
  const sum = parts.reduce((total, part) => total + part, 0);
  const total = Number.isSafeInteger(usage.totalTokens) && usage.totalTokens > sum ? usage.totalTokens : sum;
  return total > 0 ? total : undefined;
}
export interface ContextPressure {
  /** Value compared with the budget: the larger of the two measurements. */
  tokens: number;
  /** CJK-aware heuristic for the full request. */
  estimatedTokens: number;
  /** Provider usage of the latest valid response plus estimated growth since. */
  anchoredTokens: number | null;
  /** Index of the anchoring assistant message in `messages`, if any. */
  anchorIndex: number | null;
}
/** Codex/dsh style pressure: the latest provider usage from this model is the
 * baseline (it already counts the real system prompt, tools, history and the
 * reply that becomes input next), plus an estimate of messages appended since
 * and any growth of the merged system prompt. A compaction checkpoint starts a
 * new projection, so no earlier usage survives it. The heuristic remains a
 * floor: never report less than the CJK-aware estimate. */
export function contextPressure(messages: AgentMessage[], tools: AgentTool[] = [], model?: Model<Api>): ContextPressure {
  const estimatedTokens = estimateRequestTokens(messages, tools, model);
  if (!model) return { tokens: estimatedTokens, estimatedTokens, anchoredTokens: null, anchorIndex: null };
  let anchorIndex = -1; let anchor: number | undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === 'compactionSummary') break;
    anchor = usageTokens(message, model);
    if (anchor !== undefined) { anchorIndex = index; break; }
  }
  if (anchor === undefined) return { tokens: estimatedTokens, estimatedTokens, anchoredTokens: null, anchorIndex: null };
  const trailing = messages.slice(anchorIndex + 1);
  const added = trailing.filter(message => message.role !== 'system');
  const systemAt = (list: AgentMessage[]) => { const system = getCurrentSystemMessage(list as never); return system ? estimateMessageTokens(system as AgentMessage) : 0; };
  const systemGrowth = trailing.some(message => message.role === 'system') ? Math.max(0, systemAt(messages) - systemAt(messages.slice(0, anchorIndex + 1))) : 0;
  const addedTokens = added.length ? estimateRequestTokens(added, [], model) - 32 : 0;
  const anchoredTokens = anchor + Math.max(0, addedTokens) + systemGrowth;
  return { tokens: Math.max(estimatedTokens, anchoredTokens), estimatedTokens, anchoredTokens, anchorIndex };
}
