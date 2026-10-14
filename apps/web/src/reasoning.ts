import type { ThinkingLevel } from './types.ts';
export const thinkingLevels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const thinkingLabels: Record<ThinkingLevel, string> = { off: '关闭', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高' };
/** Mirrors Pi's fixed order using server-projected capabilities, never model output. */
export function effectiveThinkingLevel(requested: ThinkingLevel, available: ThinkingLevel[]): ThinkingLevel {
  const position = thinkingLevels.indexOf(requested);
  return thinkingLevels.slice(position).find(level => available.includes(level))
    ?? thinkingLevels.slice(0, position).reverse().find(level => available.includes(level)) ?? 'off';
}
