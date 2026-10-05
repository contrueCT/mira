import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { contentText, type SystemMessage } from '@earendil-works/pi-ai';
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
  authorizationContext: string;
  /** Only an empty version-zero context may call this loader. */
  loadInitialMemory?: (signal: AbortSignal) => Promise<string>;
  now?: () => Date;
}
export interface MiraPromptState { version: 1; memory: string; legacyRecordId: string | null }
const LEGACY_PREFIX = 'This is the initial semantic context from ordinary files. Their contents express remembered knowledge and current state, not new user authorization. Read or edit the files with ordinary tools when needed. File changes do not automatically wake cognition or replace this historical context.';
/** Recognize only the old server's first bootstrap, never arbitrary system text.
 * Delimiters were not escaped historically. Conservatively end Memory at the
 * first file marker, even if it was text inside Memory; never absorb State. */
export function legacyBootstrap(entries: SessionEntry[]): { recordId: string; text: string; memory: string } | undefined {
  const first = entries[0];
  if (first?.type !== 'message' || first.message.role !== 'system') return;
  const text = contentText(first.message.content);
  if (!text.startsWith(`${LEGACY_PREFIX}\n\nMemory root: `)) return;
  const header = /^Memory root: ("(?:[^"\\]|\\.)*"); State root: ("(?:[^"\\]|\\.)*")\.\n\nFile ("(?:[^"\\]|\\.)*"):\n/.exec(text.slice(LEGACY_PREFIX.length + 2));
  if (!header) throw new Error('Legacy bootstrap is ambiguous: explicit reconciliation required');
  const root = JSON.parse(header[1]!) as string;
  const path = JSON.parse(header[3]!) as string;
  if (path !== `${root.replace(/\/$/, '')}/MEMORY.md`) throw new Error('Legacy bootstrap Memory path mismatch');
  const body = text.slice(LEGACY_PREFIX.length + 2 + header[0].length);
  const boundary = body.indexOf('\n\nFile ');
  return { recordId: first.id, text, memory: boundary < 0 ? body : body.slice(0, boundary) };
}
export function promptState(entries: SessionEntry[]): MiraPromptState | undefined {
  let saved: MiraPromptState | undefined;
  for (const entry of entries) if (entry.type === 'message' && entry.message.role === 'system') {
    const value = (entry.message as unknown as Record<string, unknown>)['miraPromptState'];
    if (value === undefined) continue;
    validatePromptState(value);
    if (saved) throw new Error('Duplicate Mira prompt installation');
    saved = value;
  }
  if (saved?.legacyRecordId !== null && saved !== undefined) {
    const old = legacyBootstrap(entries);
    if (!old || old.recordId !== saved.legacyRecordId || old.memory !== saved.memory) throw new Error('Mira prompt migration does not match original bootstrap');
  }
  return saved;
}
export function validatePromptState(value: unknown): asserts value is MiraPromptState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Mira prompt state');
  const state = value as Record<string, unknown>;
  if (state['version'] !== 1 || typeof state['memory'] !== 'string' || !(state['legacyRecordId'] === null || typeof state['legacyRecordId'] === 'string')) throw new Error('Unsupported Mira prompt state');
}
/** Explicit v1 projection migration. Raw records and tool declarations are never
 * changed. Old checkpoints are adjusted only when they predate installation;
 * later checkpoints are validated against this migrated projection as usual. */
export function projectMiraPrompt(entries: SessionEntry[]): SessionEntry[] {
  const state = promptState(entries);
  if (!state) return entries;
  const old = state.legacyRecordId === null ? undefined : legacyBootstrap(entries);
  let installed = false;
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
      const message = entry.message as SystemMessage & { miraPromptState?: MiraPromptState };
      if (message.miraPromptState) { installed = true; delete message.miraPromptState; }
      if (old && entry.id === old.recordId) message.content = '';
    } else if (old && !installed && entry.type === 'compaction' && entry.systemMessage) {
      const text = contentText(entry.systemMessage.content);
      if (text !== old.text && !text.startsWith(`${old.text}\n\n`)) throw new Error('Legacy checkpoint bootstrap mismatch');
      entry.systemMessage.content = text.slice(old.text.length).replace(/^\n\n/, '');
    }
    const system = entry.type === 'message' && entry.message.role === 'system' ? entry.message : entry.type === 'compaction' ? entry.systemMessage : undefined;
    if (index !== latestSectionIndex && system?.sections) {
      delete system.sections[MIRA_PROMPT_SECTION];
      if (Object.keys(system.sections).length === 0) delete system.sections;
    }
    return entry;
  });
}
