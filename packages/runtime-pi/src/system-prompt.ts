import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { SystemMessage } from '@earendil-works/pi-ai';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';

export const MIRA_PROMPT_SECTION = 'mira.system.v0.2';
export const MIRA_PROMPT_SHA256 = '2a8d0637517e722c3d2e6e539d3c69aa71f09ab886f0b788ade97ce2ecf70208';
const bytes = readFileSync(new URL('../prompts/mira-system-v0.3.md', import.meta.url));
if (createHash('sha256').update(bytes).digest('hex') !== MIRA_PROMPT_SHA256) throw new Error('Mira system template hash mismatch');
export const MIRA_SYSTEM_TEMPLATE = bytes.toString('utf8');
// The only pre-identity snapshot revision shipped before delegation guidance.
// Keep its immutable bytes so recovery validates history, never today's template.
const PRE_DELEGATION_SHA256 = '3e0e1ea9a70f134d158ce77c6e242c909aedb5a871b299d2065dac51aec2d7e0';
const priorBytes = readFileSync(new URL('../prompts/mira-system-v0.2-pre-delegation.md', import.meta.url));
if (createHash('sha256').update(priorBytes).digest('hex') !== PRE_DELEGATION_SHA256) throw new Error('Prior Mira system template hash mismatch');
const PRE_COMMUNICATION_SHA256 = 'a3ea5a98735089138296892ee0c30f47439c044b44a6e9bde0409724cbf22fe1';
const preCommunicationBytes = readFileSync(new URL('../prompts/mira-system-v0.2-pre-communication.md', import.meta.url));
if (createHash('sha256').update(preCommunicationBytes).digest('hex') !== PRE_COMMUNICATION_SHA256) throw new Error('Prior Mira system template hash mismatch');
// The last published v0.2 revision, before the user-configured persona section.
const PRE_PERSONA_SHA256 = '5e520269ae889045e06dd158b4c2c47ada2cb94fa4f28577e3bcb0f688292892';
const prePersonaBytes = readFileSync(new URL('../prompts/mira-system-v0.2.md', import.meta.url));
if (createHash('sha256').update(prePersonaBytes).digest('hex') !== PRE_PERSONA_SHA256) throw new Error('Prior Mira system template hash mismatch');

/** v0.2 revisions use exactly these keys; v0.3 adds PERSONA. */
export const MIRA_LEGACY_PLACEHOLDERS = ['MEMORY_ROOT', 'MEMORY_STATE', 'CURRENT_TIME', 'EXTENSIONS_ROOT', 'OTHER_ENVIRONMENT_CONTEXT', 'DYNAMIC_TOOL_AND_EXTENSION_GUIDANCE', 'CURRENT_AUTHORIZATION_CONTEXT'] as const;
export const MIRA_PLACEHOLDERS = [...MIRA_LEGACY_PLACEHOLDERS, 'PERSONA'] as const;
type LegacyKey = typeof MIRA_LEGACY_PLACEHOLDERS[number];
/** PERSONA is present exactly for templates that declare it (v0.3 and later). */
export type MiraPromptValues = Record<LegacyKey, string> & { PERSONA?: string };
/** Rendered into the persona slot when the user has not configured one. */
export const MIRA_DEFAULT_PERSONA = 'No custom profile is configured. Present yourself as Mira, exactly as described above.';
const templates = new Map<string, { text: string; keys: readonly string[] }>([
  [PRE_DELEGATION_SHA256, { text: priorBytes.toString('utf8'), keys: MIRA_LEGACY_PLACEHOLDERS }],
  [PRE_COMMUNICATION_SHA256, { text: preCommunicationBytes.toString('utf8'), keys: MIRA_LEGACY_PLACEHOLDERS }],
  [PRE_PERSONA_SHA256, { text: prePersonaBytes.toString('utf8'), keys: MIRA_LEGACY_PLACEHOLDERS }],
  [MIRA_PROMPT_SHA256, { text: MIRA_SYSTEM_TEMPLATE, keys: MIRA_PLACEHOLDERS }],
]);

/** One pass only: runtime data cannot create XML-like boundaries or another substitution.
 * The required key set follows the supplied values: legacy values must render a
 * template without PERSONA, and persona-bearing values a template that uses it. */
export function renderMiraPrompt(values: MiraPromptValues, template = MIRA_SYSTEM_TEMPLATE): string {
  const required: readonly string[] = Object.hasOwn(values, 'PERSONA') ? MIRA_PLACEHOLDERS : MIRA_LEGACY_PLACEHOLDERS;
  for (const key of required) if (typeof (values as Record<string, unknown>)[key] !== 'string') throw new Error(`Missing Mira prompt value: ${key}`);
  const seen = new Set<string>();
  const rendered = template.replace(/\{\{([^{}]*)\}\}/g, (_match, key: string) => {
    if (!(MIRA_PLACEHOLDERS as readonly string[]).includes(key)) throw new Error(`Unknown Mira prompt placeholder: ${key}`);
    const value = (values as Record<string, unknown>)[key];
    if (typeof value !== 'string') throw new Error(`Missing Mira prompt value: ${key}`);
    seen.add(key);
    return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  if (required.some(key => !seen.has(key))) throw new Error('Missing Mira template placeholder');
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
  /** Rendered user persona profile, frozen by the host for this runtime (one Wake). */
  persona?: string;
  /** Pending explicit Memory reset (ADR 0047): the first natural request of
   * this runtime compacts once, re-reading Memory into the frozen snapshot,
   * then awaits this callback. Left pending when there is no older history. */
  refreshMemory?: () => Promise<void>;
  now?: () => Date;
}
/** Raw-only rendering inputs make the sanctioned Memory replacement verifiable.
 * The skills suffix is already escaped by Pi and must not be rendered again. */
export interface MiraPromptSnapshot { values: MiraPromptValues; skills: string; templateSha256?: string; }
/** Missing identity denotes exactly the published pre-delegation revision. */
export function renderMiraPromptSnapshot(snapshot: MiraPromptSnapshot): string {
  const template = templates.get(snapshot.templateSha256 ?? PRE_DELEGATION_SHA256);
  if (!template) throw new Error('Unknown Mira prompt template identity');
  const keys = Object.keys(snapshot.values);
  if (keys.length !== template.keys.length || template.keys.some(key => !keys.includes(key))) throw new Error('Invalid Mira prompt snapshot');
  return renderMiraPrompt(snapshot.values, template.text) + snapshot.skills;
}
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
  if (Object.keys(snapshot).some(key => !['values', 'skills', 'templateSha256'].includes(key)) ||
      (Object.hasOwn(snapshot, 'templateSha256') && typeof snapshot.templateSha256 !== 'string') || typeof snapshot.skills !== 'string' || !snapshot.values || typeof snapshot.values !== 'object' || Array.isArray(snapshot.values) ||
      Object.values(snapshot.values).some(value => typeof value !== 'string'))
    throw new Error('Invalid Mira prompt snapshot');
  if (system?.sections?.[MIRA_PROMPT_SECTION] !== renderMiraPromptSnapshot(snapshot)) throw new Error('Mira prompt snapshot differs from system section');
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
    if (!system?.sections || system.sections[MIRA_PROMPT_SECTION] !== renderMiraPromptSnapshot(prior.prompt!))
      throw new Error('Checkpoint system state differs from preceding prompt');
    system.sections[MIRA_PROMPT_SECTION] = renderMiraPromptSnapshot(prompt);
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
