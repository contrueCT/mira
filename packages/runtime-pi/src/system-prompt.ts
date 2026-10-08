import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SystemMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const MIRA_PROMPT_SECTION = 'mira.system.v0.2';
export const MIRA_PROMPT_SHA256 = '3e0e1ea9a70f134d158ce77c6e242c909aedb5a871b299d2065dac51aec2d7e0';
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
  /** Read at initial bootstrap and after a successful compaction preparation. */
  loadMemory?: (signal: AbortSignal) => Promise<string>;
  now?: () => Date;
}
/** Raw-only rendering inputs make the sanctioned Memory replacement verifiable.
 * The skills suffix is already escaped by Pi and must not be rendered again. */
export interface MiraPromptSnapshot { values: MiraPromptValues; skills: string; }
export interface MiraMemoryCheckpoint {
  miraMemory: string;
  miraMemoryConfigured: boolean;
  miraPrompt?: MiraPromptSnapshot;
  systemMessage?: SystemMessage;
}
type MiraSystemMessage = SystemMessage & { miraMemory?: string; miraMemoryConfigured?: boolean; miraPrompt?: MiraPromptSnapshot };
type MiraCheckpoint = Extract<SessionEntry, { type: 'compaction' }> & Partial<MiraMemoryCheckpoint>;

export function validateMiraPromptSnapshot(value: unknown, system: SystemMessage | undefined): asserts value is MiraPromptSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Mira prompt snapshot');
  const snapshot = value as MiraPromptSnapshot;
  if (Object.keys(snapshot).length !== 2 || typeof snapshot.skills !== 'string' || !snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values) ||
      Object.keys(snapshot.values).length !== MIRA_PLACEHOLDERS.length || MIRA_PLACEHOLDERS.some(key => typeof snapshot.values[key] !== 'string'))
    throw new Error('Invalid Mira prompt snapshot');
  if (system?.sections?.[MIRA_PROMPT_SECTION] !== renderMiraPrompt(snapshot.values) + snapshot.skills) throw new Error('Mira prompt snapshot differs from system section');
}

function snapshots(entries: readonly SessionEntry[]): { memory: string | undefined; configured: boolean | undefined; prompt: MiraPromptSnapshot | undefined } {
  let memory: string | undefined;
  let configured: boolean | undefined;
  let prompt: MiraPromptSnapshot | undefined;
  for (const [index, entry] of entries.entries()) {
    if (entry.type === 'message' && entry.message.role === 'system') {
      const system = entry.message as MiraSystemMessage;
      if (system.miraMemory !== undefined || system.miraMemoryConfigured !== undefined) {
        if (index !== 0 || typeof system.miraMemory !== 'string' || typeof system.miraMemoryConfigured !== 'boolean' || (!system.miraMemoryConfigured && system.miraMemory !== '')) throw new Error('Invalid initial Memory snapshot');
        memory = system.miraMemory;
        configured = system.miraMemoryConfigured;
      }
      if (system.miraPrompt !== undefined) {
        validateMiraPromptSnapshot(system.miraPrompt, system);
        if (memory === undefined || system.miraPrompt.values.MEMORY_STATE !== memory) throw new Error('Mira prompt does not use current Memory snapshot');
        prompt = system.miraPrompt;
      } else if (system.sections && Object.hasOwn(system.sections, MIRA_PROMPT_SECTION)) {
        if (memory !== undefined) throw new Error('Missing Mira prompt snapshot');
        prompt = undefined;
      }
    } else if (entry.type === 'compaction') {
      const checkpoint = entry as MiraCheckpoint;
      if (checkpoint.systemMessage && (Object.hasOwn(checkpoint.systemMessage, 'miraMemory') || Object.hasOwn(checkpoint.systemMessage, 'miraPrompt') || Object.hasOwn(checkpoint.systemMessage, 'miraMemoryConfigured'))) throw new Error('Invalid checkpoint system message');
      if (checkpoint.miraMemory === undefined) {
        if (memory !== undefined || checkpoint.miraPrompt !== undefined || checkpoint.miraMemoryConfigured !== undefined) throw new Error('Missing checkpoint Memory snapshot');
        continue;
      }
      if (typeof checkpoint.miraMemory !== 'string' || memory === undefined || typeof checkpoint.miraMemoryConfigured !== 'boolean' || (configured && !checkpoint.miraMemoryConfigured) || (!checkpoint.miraMemoryConfigured && checkpoint.miraMemory !== '')) throw new Error('Invalid checkpoint Memory snapshot');
      const expectedPrompt = prompt ? { ...prompt, values: { ...prompt.values, MEMORY_STATE: checkpoint.miraMemory } } : undefined;
      if (!isDeepStrictEqual(checkpoint.miraPrompt, expectedPrompt)) throw new Error('Checkpoint prompt state differs from preceding context');
      if (checkpoint.miraPrompt) validateMiraPromptSnapshot(checkpoint.miraPrompt, checkpoint.systemMessage);
      memory = checkpoint.miraMemory;
      configured = checkpoint.miraMemoryConfigured;
      prompt = checkpoint.miraPrompt;
    }
  }
  return { memory, configured, prompt };
}

/** Latest committed snapshot, never a fresh filesystem read during recovery. */
export function currentMemory(entries: readonly SessionEntry[]): string | undefined { return snapshots(entries).memory; }
export function memoryConfigured(entries: readonly SessionEntry[]): boolean | undefined { return snapshots(entries).configured; }
export function currentPrompt(entries: readonly SessionEntry[]): MiraPromptSnapshot | undefined {
  const prompt = snapshots(entries).prompt;
  return prompt ? structuredClone(prompt) : undefined;
}

/** Preserve every system field and frozen renderer input except Memory itself. */
export function refreshMiraMemory(systemMessage: SystemMessage | undefined, entries: readonly SessionEntry[], memory: string, configured = memoryConfigured(entries)): MiraMemoryCheckpoint {
  if (typeof memory !== 'string') throw new Error('Invalid checkpoint Memory snapshot');
  const prior = snapshots(entries);
  if (prior.memory === undefined) throw new Error('Missing initial Memory snapshot');
  if (typeof configured !== 'boolean' || (prior.configured && !configured) || (!configured && memory !== '')) throw new Error('Invalid checkpoint Memory snapshot');
  const system = systemMessage ? structuredClone(systemMessage) : undefined;
  const prompt = prior.prompt ? { ...prior.prompt, values: { ...prior.prompt.values, MEMORY_STATE: memory } } : undefined;
  if (prompt) {
    if (!system?.sections || system.sections[MIRA_PROMPT_SECTION] !== renderMiraPrompt(prior.prompt!.values) + prior.prompt!.skills)
      throw new Error('Checkpoint system state differs from preceding prompt');
    system.sections[MIRA_PROMPT_SECTION] = renderMiraPrompt(prompt.values) + prompt.skills;
  } else if (system?.sections && Object.hasOwn(system.sections, MIRA_PROMPT_SECTION)) {
    throw new Error('Missing Mira prompt snapshot');
  }
  return { miraMemory: memory, miraMemoryConfigured: configured, ...(prompt ? { miraPrompt: structuredClone(prompt) } : {}), ...(system ? { systemMessage: system } : {}) };
}
/** Keep the current named prompt section once in the disposable provider view. */
export function projectMiraPrompt(entries: SessionEntry[]): SessionEntry[] {
  snapshots(entries);
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
      const message = entry.message as MiraSystemMessage;
      delete message.miraMemory;
      delete message.miraMemoryConfigured;
      delete message.miraPrompt;
    }
    if (entry.type === 'compaction') {
      delete (entry as MiraCheckpoint).miraMemory;
      delete (entry as MiraCheckpoint).miraMemoryConfigured;
      delete (entry as MiraCheckpoint).miraPrompt;
    }
    const system = entry.type === 'message' && entry.message.role === 'system' ? entry.message : entry.type === 'compaction' ? entry.systemMessage : undefined;
    if (index !== latestSectionIndex && system?.sections) {
      delete system.sections[MIRA_PROMPT_SECTION];
      if (Object.keys(system.sections).length === 0) delete system.sections;
    }
    return entry;
  });
}
