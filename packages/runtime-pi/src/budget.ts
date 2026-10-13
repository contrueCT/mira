import { attachmentRequestPlans } from './attachments.ts';
import type { AgentMessage, AgentTool } from '@earendil-works/pi-agent-core';
import { toToolDeclaration, type Api, type Model } from '@earendil-works/pi-ai';
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
/** Pi's public heuristic, plus protocol overhead and the actual current tool
 * schemas. It is an estimate, not a tokenizer or a provider usage guarantee.
 * Declarations already present in system deltas may be counted twice, safely. */
export function estimateRequestTokens(messages: AgentMessage[], tools: AgentTool[] = [], model?: Model<Api>): number {
  const plans = model ? attachmentRequestPlans(convertToLlm(messages), model) : messages.map(message => ({message,media:[]}));
  return plans.reduce((total, plan) => total + estimateTokens(plan.message) + 8 + plan.media.reduce((sum,item)=>sum+(item.kind==='image'?4096:16384),0), 0)
    + Math.ceil(JSON.stringify(tools.map(tool => toToolDeclaration(tool))).length / 4) + 32;
}
