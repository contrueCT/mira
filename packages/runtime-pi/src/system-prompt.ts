import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { SystemMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const MIRA_PROMPT_SECTION = 'mira.system.v0.2';
export const MIRA_PROMPT_SHA256 = 'ea1d1286ec4de9c875b3a1ce6455fcc8a4b9b0a5f5d202ddd5044793dfc205ee';
const bytes = readFileSync(new URL('../prompts/mira-system-v0.2.md', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== MIRA_PROMPT_SHA256) throw new Error('Mira system template hash mismatch');
export const MIRA_SYSTEM_TEMPLATE = bytes.toString('utf8');
export const MIRA_PLACEHOLDERS = ['MEMORY_ROOT', 'MEMORY_STATE', 'CURRENT_TIME', 'EXTENSIONS_ROOT', 'OTHER_ENVIRONMENT_CONTEXT', 'DYNAMIC_TOOL_AND_EXTENSION_GUIDANCE', 'CURRENT_AUTHORIZATION_CONTEXT'] as const;
export type MiraPromptValues = Record<typeof MIRA_PLACEHOLDERS[number], string>;
/** One pass only: runtime data cannot create XML-like boundaries or another substitution. */
export function renderMiraPrompt(values: MiraPromptValues, template = MIRA_SYSTEM_TEMPLATE): string {
  for (const key of MIRA_PLACEHOLDERS) if (typeof values[key] !== 'string') throw new Error(`Missing Mira prompt value: ${key}`);
  const seen = new Set<string>();
  const rendered = template.replace(/\{\{([^{}]*)\}\}/g, (_match, key: string) => {
    if (!(MIRA_PLACEHOLDERS as readonly string[]).includes(key)) throw new Error(`Unknown Mira prompt placeholder: ${key}`);
    seen.add(key);
    return values[key as keyof MiraPromptValues].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  if (MIRA_PLACEHOLDERS.some(key => !seen.has(key))) throw new Error('Missing Mira template placeholder');
  return rendered;
}
export interface MiraPromptOptions {
  memoryRoot?: string;
  extensionsRoot?: string;
  environmentContext: string;
  /** Factual conversation/standing-instruction context for the main model, not a computed permit. */
  authorizationContext: string;
  /** Only an empty version-zero context may call this loader. */
  loadInitialMemory?: (signal: AbortSignal) => Promise<string>;
  now?: () => Date;
}
/** The initial durable system record owns the frozen Memory snapshot. */
export function initialMemory(entries: SessionEntry[]): string | undefined {
  let memory: string | undefined;
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== 'message' || entry.message.role !== 'system') continue;
    const value = (entry.message as SystemMessage & { miraMemory?: string }).miraMemory;
    if (value === undefined) continue;
    if (index !== 0 || typeof value !== 'string') throw new Error('Invalid initial Memory snapshot');
    memory = value;
  }
  return memory;
}
/** Keep the current named prompt section once in the disposable provider view. */
export function projectMiraPrompt(entries: SessionEntry[]): SessionEntry[] {
  initialMemory(entries);
  // Keep only the latest replacement in provider-facing history, including for
  // transports that support mid-conversation system messages. Preserve every
  // declaration delta and every original persisted prompt revision.
  let latestSectionIndex = -1;
  for (const [index, entry] of entries.entries()) {
    const message = entry.type === 'message' && entry.message.role === 'system' ? entry.message : entry.type === 'compaction' ? entry.systemMessage : undefined;
    if (message?.sections && Object.hasOwn(message.sections, MIRA_PROMPT_SECTION)) latestSectionIndex = index;
  }
  return entries.map((source, index) => {
    const entry = structuredClone(source);
    if (entry.type === 'message' && entry.message.role === 'system') {
      const message = entry.message as SystemMessage & { miraMemory?: string };
      delete message.miraMemory;
    }
    const system = entry.type === 'message' && entry.message.role === 'system' ? entry.message : entry.type === 'compaction' ? entry.systemMessage : undefined;
    if (index !== latestSectionIndex && system?.sections) {
      delete system.sections[MIRA_PROMPT_SECTION];
      if (Object.keys(system.sections).length === 0) delete system.sections;
    }
    return entry;
  });
}
