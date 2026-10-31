import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

/** User-configured persona (ADR 0046). One global profile for the main Mira;
 * task workers never load it. The rendered profile is a frozen prompt value. */
export const personaRings = ['lavender', 'sky', 'sage', 'sand', 'rose', 'iris'] as const;
export type PersonaRing = typeof personaRings[number];
export const personaLanguages = ['auto', 'zh', 'en', 'ja', 'ko'] as const;
export type PersonaLanguage = typeof personaLanguages[number];
export interface PersonaExample { user: string; reply: string }
export interface Persona {
  name: string;
  ring: PersonaRing;
  avatar: string | null;
  userCallName: string;
  language: PersonaLanguage;
  identity: string;
  personality: string;
  speakingStyle: string;
  boundaries: string;
  examples: PersonaExample[];
  extra: string;
  presetId?: string;
}
export const personaLimits = {
  name: 24, userCallName: 24, identity: 600, personality: 600, speakingStyle: 600, boundaries: 400,
  examples: 3, exampleText: 200, extra: 1000, total: 4000, history: 20,
  avatarBytes: 2 * 1_048_576,
} as const;
export const PERSONA_FILE_MAX_BYTES = 1_048_576;

export class PersonaError extends Error {
  readonly code: 'invalid' | 'conflict' | 'unavailable' | 'not_found';
  constructor(code: PersonaError['code']) {
    super({ invalid: 'Invalid persona', conflict: 'Persona changed; reload before saving', unavailable: 'Persona settings are unavailable; check the protected local file', not_found: 'Persona revision or avatar not found' }[code]);
    this.name = 'PersonaError'; this.code = code;
  }
}
const invalid = (): never => { throw new PersonaError('invalid'); };
const unavailable = (): never => { throw new PersonaError('unavailable'); };
function errno(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === code; }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
/** NFC, no control characters except newline, at most one blank line in a row, trimmed. */
export function cleanPersonaText(value: unknown, limit: number, multiline: boolean): string {
  if (typeof value !== 'string' || !value.isWellFormed()) return invalid();
  let text = value.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\t/g, ' ');
  text = multiline ? text.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '') : text.replace(/[\u0000-\u001f\u007f]/g, ' ');
  text = text.replace(/\n{3,}/g, '\n\n').replace(/[ \u00a0]+\n/g, '\n').trim();
  if ([...text].length > limit) return invalid();
  return text;
}
const avatarId = /^[a-f0-9]{64}$/;
const presetIds = /^[a-z][a-z0-9-]{0,39}$/;
export function parsePersona(value: unknown): Persona | null {
  if (value === null) return null;
  const input = record(value);
  const keys = ['name', 'ring', 'avatar', 'userCallName', 'language', 'identity', 'personality', 'speakingStyle', 'boundaries', 'examples', 'extra', 'presetId'];
  if (Object.keys(input).some(key => !keys.includes(key))) invalid();
  const name = cleanPersonaText(input['name'], personaLimits.name, false);
  if (!name) invalid();
  const ring = input['ring'] ?? 'lavender';
  if (!(personaRings as readonly unknown[]).includes(ring)) invalid();
  const avatar = input['avatar'] ?? null;
  if (avatar !== null && (typeof avatar !== 'string' || !avatarId.test(avatar))) invalid();
  const language = input['language'] ?? 'auto';
  if (!(personaLanguages as readonly unknown[]).includes(language)) invalid();
  const examplesInput = input['examples'] ?? [];
  if (!Array.isArray(examplesInput) || examplesInput.length > personaLimits.examples) invalid();
  const examples = (examplesInput as unknown[]).map(item => {
    const example = record(item);
    if (Object.keys(example).some(key => key !== 'user' && key !== 'reply')) invalid();
    return { user: cleanPersonaText(example['user'], personaLimits.exampleText, false), reply: cleanPersonaText(example['reply'], personaLimits.exampleText, true) };
  }).filter(example => example.user || example.reply);
  if (examples.some(example => !example.user || !example.reply)) invalid();
  const presetId = input['presetId'];
  if (presetId !== undefined && (typeof presetId !== 'string' || !presetIds.test(presetId))) invalid();
  const persona: Persona = {
    name, ring: ring as PersonaRing, avatar: avatar as string | null,
    userCallName: cleanPersonaText(input['userCallName'] ?? '', personaLimits.userCallName, false),
    language: language as PersonaLanguage,
    identity: cleanPersonaText(input['identity'] ?? '', personaLimits.identity, true),
    personality: cleanPersonaText(input['personality'] ?? '', personaLimits.personality, true),
    speakingStyle: cleanPersonaText(input['speakingStyle'] ?? '', personaLimits.speakingStyle, true),
    boundaries: cleanPersonaText(input['boundaries'] ?? '', personaLimits.boundaries, true),
    examples, extra: cleanPersonaText(input['extra'] ?? '', personaLimits.extra, true),
    ...(presetId === undefined ? {} : { presetId: presetId as string }),
  };
  if ([...renderPersona(persona)].length > personaLimits.total) invalid();
  return persona;
}
const languageNames: Record<PersonaLanguage, string> = { auto: 'follow the conversation', zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
/** The exact {{PERSONA}} value: English labels, the user's own words. */
export function renderPersona(persona: Persona): string {
  const lines = [`Name: ${persona.name}`];
  if (persona.userCallName) lines.push(`How to address the user: ${persona.userCallName}`);
  lines.push(`Primary language: ${languageNames[persona.language]}`);
  const field = (label: string, text: string) => { if (text) lines.push(text.includes('\n') ? `${label}:\n${text}` : `${label}: ${text}`); };
  field('Identity and background', persona.identity);
  field('Personality and attitude', persona.personality);
  field('Speaking style', persona.speakingStyle);
  field('Boundaries (things you do not do or play)', persona.boundaries);
  if (persona.examples.length) {
    lines.push('Example exchanges (voice only, not facts):');
    for (const example of persona.examples) lines.push(`User: ${example.user}`, `${persona.name}: ${example.reply}`);
  }
  field('Additional notes', persona.extra);
  return lines.join('\n');
}
/** A configured profile, or undefined for the runtime's built-in default text. */
export function personaPromptValue(persona: Persona | null): string | undefined {
  return persona ? renderPersona(persona) : undefined;
}

export interface PersonaHistoryItem { revision: string; version: number; savedAt: string; persona: Persona | null }
interface StoredPersona { formatVersion: 1; version: number; updatedAt: string | null; current: Persona | null; history: PersonaHistoryItem[] }
export interface PersonaView { revision: string; version: number; updatedAt: string | null; persona: Persona | null }
const emptyStored = (): StoredPersona => ({ formatVersion: 1, version: 0, updatedAt: null, current: null, history: [] });
const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const missingRevision = digest('mira-persona:missing');
/** Each saved state's own identity, independent of history/formatting. */
const stateRevision = (version: number, persona: Persona | null): string => digest(JSON.stringify({ version, persona }));
function parseStored(value: unknown): StoredPersona {
  const input = record(value);
  if (input['formatVersion'] !== 1 || !Number.isSafeInteger(input['version']) || (input['version'] as number) < 0
    || (input['updatedAt'] !== null && typeof input['updatedAt'] !== 'string') || !Array.isArray(input['history'])) return invalid();
  const history = (input['history'] as unknown[]).map(item => {
    const entry = record(item);
    if (typeof entry['revision'] !== 'string' || !Number.isSafeInteger(entry['version']) || typeof entry['savedAt'] !== 'string') return invalid();
    return { revision: entry['revision'], version: entry['version'] as number, savedAt: entry['savedAt'], persona: parsePersona(entry['persona']) };
  });
  return { formatVersion: 1, version: input['version'] as number, updatedAt: input['updatedAt'] as string | null, current: parsePersona(input['current']), history: history.slice(0, personaLimits.history) };
}

/** Image formats accepted for the avatar, by content signature rather than name. */
export function avatarMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
const extensions = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;

const pending = new Map<string, Promise<unknown>>();
/** persona.json plus content-addressed avatar files, both private to MIRA_HOME. */
export class PersonaStore {
  readonly file: string;
  readonly avatars: string;
  constructor(miraHome: string) {
    if (!path.isAbsolute(miraHome)) unavailable();
    this.file = path.join(path.resolve(miraHome), 'persona.json');
    this.avatars = path.join(path.resolve(miraHome), 'persona-avatars');
  }
  /** MIRA_HOME itself may be shared-readable; it must be a real directory owned by this user. */
  async #homeDirectory(directory: string, create: boolean): Promise<boolean> {
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if (!errno(error, 'ENOENT')) throw error;
      if (!create) return false;
      await mkdir(directory, { recursive: true, mode: 0o700 }); info = await lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (typeof process.getuid === 'function' && info.uid !== process.getuid())) unavailable();
    return true;
  }
  async #privateDirectory(directory: string, create: boolean): Promise<boolean> {
    let info;
    try { info = await lstat(directory); }
    catch (error) {
      if (!errno(error, 'ENOENT')) throw error;
      if (!create) return false;
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if (!errno(error, 'EEXIST')) throw error; }
      info = await lstat(directory);
    }
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) unavailable();
    return true;
  }
  async #readFile(file: string, limit: number): Promise<Buffer | null> {
    let handle;
    try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if (errno(error, 'ENOENT')) return null; throw error; }
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > limit || (info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) unavailable();
      const buffer = Buffer.alloc(limit + 1); let length = 0;
      while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length); if (!bytesRead) break; length += bytesRead; }
      if (length > limit) unavailable();
      return buffer.subarray(0, length);
    } finally { await handle.close(); }
  }
  async #writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
    const candidate = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
    let temporary: string | undefined;
    try {
      const handle = await open(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      temporary = candidate;
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(candidate, file); temporary = undefined;
      const directory = await open(path.dirname(file), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { if (temporary) await unlink(temporary).catch(() => undefined); }
  }
  async #snapshot(): Promise<{ data: StoredPersona; revision: string }> {
    try {
      if (!await this.#homeDirectory(path.dirname(this.file), false)) return { data: emptyStored(), revision: missingRevision };
      const bytes = await this.#readFile(this.file, PERSONA_FILE_MAX_BYTES);
      if (bytes === null) return { data: emptyStored(), revision: missingRevision };
      const data = parseStored(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown);
      return { data, revision: stateRevision(data.version, data.current) };
    } catch { return unavailable(); }
  }
  async get(): Promise<PersonaView> {
    const { data, revision } = await this.#snapshot();
    return { revision, version: data.version, updatedAt: data.updatedAt, persona: data.current ? structuredClone(data.current) : null };
  }
  async history(): Promise<PersonaHistoryItem[]> { return structuredClone((await this.#snapshot()).data.history); }
  #serial<T>(work: () => Promise<T>): Promise<T> {
    const previous = pending.get(this.file) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(work);
    pending.set(this.file, operation);
    return operation.finally(() => { if (pending.get(this.file) === operation) pending.delete(this.file); });
  }
  /** Compare-and-set on the public revision; history keeps the latest 20 saves. */
  async save(expectedRevision: string, value: unknown, now = new Date()): Promise<PersonaView & { changed: boolean }> {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) invalid();
    const persona = parsePersona(value);
    return this.#serial(async () => {
      const current = await this.#snapshot();
      if (current.revision !== expectedRevision) throw new PersonaError('conflict');
      if (persona?.avatar && !await this.#avatarExists(persona.avatar)) throw new PersonaError('invalid');
      if (JSON.stringify(current.data.current) === JSON.stringify(persona)) {
        return { revision: current.revision, version: current.data.version, updatedAt: current.data.updatedAt, persona: structuredClone(persona), changed: false };
      }
      const version = current.data.version + 1; const revision = stateRevision(version, persona); const savedAt = now.toISOString();
      const data: StoredPersona = { formatVersion: 1, version, updatedAt: savedAt, current: persona,
        history: [{ revision, version, savedAt, persona }, ...current.data.history].slice(0, personaLimits.history) };
      const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
      if (bytes.length > PERSONA_FILE_MAX_BYTES) invalid();
      try {
        await this.#homeDirectory(path.dirname(this.file), true);
        if ((await this.#snapshot()).revision !== expectedRevision) throw new PersonaError('conflict');
        await this.#writeAtomic(this.file, bytes);
      } catch (error) { if (error instanceof PersonaError) throw error; return unavailable(); }
      await this.#pruneAvatars(data).catch(() => undefined);
      return { revision, version, updatedAt: savedAt, persona: structuredClone(persona), changed: true };
    });
  }
  /** Restoring creates a new version with the old content; it never rewrites history. */
  async restore(revision: string, expectedRevision: string, now = new Date()): Promise<PersonaView & { changed: boolean }> {
    const entry = (await this.#snapshot()).data.history.find(item => item.revision === revision);
    if (!entry) throw new PersonaError('not_found');
    if (entry.persona?.avatar && !await this.#avatarExists(entry.persona.avatar)) entry.persona.avatar = null;
    return this.save(expectedRevision, entry.persona, now);
  }
  async #avatarFile(id: string): Promise<{ file: string; mime: keyof typeof extensions } | null> {
    if (!avatarId.test(id)) return null;
    if (!await this.#privateDirectory(this.avatars, false)) return null;
    for (const [mime, extension] of Object.entries(extensions) as Array<[keyof typeof extensions, string]>) {
      const file = path.join(this.avatars, `${id}.${extension}`);
      try { const info = await lstat(file); if (info.isFile() && !info.isSymbolicLink()) return { file, mime }; }
      catch (error) { if (!errno(error, 'ENOENT')) throw error; }
    }
    return null;
  }
  async #avatarExists(id: string): Promise<boolean> { return (await this.#avatarFile(id)) !== null; }
  /** Stores a validated image by content hash. Unreferenced uploads are pruned on later saves. */
  async putAvatar(bytes: Uint8Array): Promise<{ id: string; mimeType: string; bytes: number }> {
    if (!bytes.byteLength || bytes.byteLength > personaLimits.avatarBytes) throw new PersonaError('invalid');
    const mime = avatarMime(bytes); if (!mime) throw new PersonaError('invalid');
    const id = digest(bytes);
    try {
      await this.#homeDirectory(path.dirname(this.file), true);
      await this.#privateDirectory(this.avatars, true);
      if (!await this.#avatarExists(id)) await this.#writeAtomic(path.join(this.avatars, `${id}.${extensions[mime]}`), bytes);
    } catch (error) { if (error instanceof PersonaError) throw error; return unavailable(); }
    return { id, mimeType: mime, bytes: bytes.byteLength };
  }
  async readAvatar(id: string): Promise<{ mimeType: string; bytes: Buffer }> {
    let found;
    try { found = await this.#avatarFile(id); } catch { return unavailable(); }
    if (!found) throw new PersonaError('not_found');
    let bytes;
    try { bytes = await this.#readFile(found.file, personaLimits.avatarBytes); } catch { return unavailable(); }
    if (!bytes || avatarMime(bytes) !== found.mime || digest(bytes) !== id) throw new PersonaError('not_found');
    return { mimeType: found.mime, bytes };
  }
  async #pruneAvatars(data: StoredPersona): Promise<void> {
    if (!await this.#privateDirectory(this.avatars, false)) return;
    const keep = new Set([data.current?.avatar, ...data.history.map(item => item.persona?.avatar)].filter((id): id is string => !!id));
    const cutoff = Date.now() - 60 * 60_000;
    for (const name of await readdir(this.avatars)) {
      const match = /^([a-f0-9]{64})\.(png|jpg|webp)$/.exec(name);
      if (!match || keep.has(match[1]!)) continue;
      const file = path.join(this.avatars, name);
      // A just-uploaded draft avatar may not be saved yet; keep it for an hour.
      if ((await stat(file)).mtimeMs < cutoff) await unlink(file).catch(() => undefined);
    }
  }
}
