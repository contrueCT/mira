import { clampThinkingLevel, getSupportedThinkingLevels, type Api, type Model, type ModelThinkingLevel } from '@earendil-works/pi-ai';

export type ThinkingLevel = ModelThinkingLevel;
export const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export const defaultThinkingLevel: ThinkingLevel = 'medium';
export function parseThinkingLevel(value: unknown): ThinkingLevel {
  if (!thinkingLevels.some(level => level === value)) throw Error('Invalid default thinking level');
  return value as ThinkingLevel;
}
/** Static model capability adaptation only; no model-controlled escalation. */
export function resolveThinkingLevel(model: Model<Api>, requested: ThinkingLevel = defaultThinkingLevel): ThinkingLevel {
  return clampThinkingLevel(model, parseThinkingLevel(requested));
}
export function supportedThinkingLevels(model: Model<Api>): ThinkingLevel[] { return getSupportedThinkingLevels(model); }
/** Summary generation never inherits the conversation's potentially expensive level. */
export function compactionThinkingLevel(model: Model<Api>): ThinkingLevel {
  return getSupportedThinkingLevels(model)[0] ?? 'off';
}
