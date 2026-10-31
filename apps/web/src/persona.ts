import { ApiError, clientFetch } from './api.ts';

/** Browser DTOs for /api/persona (ADR 0046). The server re-validates everything. */
export const personaRings = ['lavender', 'sky', 'sage', 'sand', 'rose', 'iris'] as const;
export type PersonaRing = typeof personaRings[number];
export const ringColors: Record<PersonaRing, string> = { lavender: '#bfc2d3', sky: '#c9dcf5', sage: '#cfe3d6', sand: '#f0dcc4', rose: '#e9cfd8', iris: '#d9d0ec' };
export const ringLabels: Record<PersonaRing, string> = { lavender: '薰衣草', sky: '天空', sage: '鼠尾草', sand: '沙色', rose: '玫瑰', iris: '鸢尾' };
export type PersonaLanguage = 'auto' | 'zh' | 'en' | 'ja' | 'ko';
export const languageLabels: Record<PersonaLanguage, string> = { auto: '跟随对话', zh: '中文', en: 'English', ja: '日本語', ko: '한국어' };
export interface PersonaExample { user: string; reply: string }
export interface Persona {
  name: string; ring: PersonaRing; avatar: string | null; userCallName: string; language: PersonaLanguage;
  identity: string; personality: string; speakingStyle: string; boundaries: string; examples: PersonaExample[]; extra: string; presetId?: string;
}
export interface PersonaLimits { name: number; userCallName: number; identity: number; personality: number; speakingStyle: number; boundaries: number; examples: number; exampleText: number; extra: number; total: number; avatarBytes: number }
export interface PersonaState { revision: string; version: number; updatedAt: string | null; persona: Persona | null; applied: { revision: string; at: string } | null; changed?: boolean; limits?: PersonaLimits }
export interface PersonaPreset { id: string; label: string; persona: Persona | null }
export interface PersonaHistoryItem { revision: string; version: number; savedAt: string; name: string | null; persona: Persona | null }
export interface Identity { name: string; ring: PersonaRing; avatar: string | null }
export const defaultIdentity: Identity = { name: 'Mira', ring: 'lavender', avatar: null };
/** Header/chat identity from /api/status, falling back to the built-in Mira. */
export function statusIdentity(status: { identity?: { name: string; ring: string; avatar: string | null } } | null): Identity {
  const value = status?.identity;
  if (!value || typeof value.name !== 'string' || !value.name.trim()) return defaultIdentity;
  const ring = (personaRings as readonly string[]).includes(value.ring) ? value.ring as PersonaRing : 'lavender';
  const avatar = typeof value.avatar === 'string' && /^[a-f0-9]{64}$/.test(value.avatar) ? value.avatar : null;
  return { name: value.name, ring, avatar };
}
export const defaultLimits: PersonaLimits = { name: 24, userCallName: 24, identity: 600, personality: 600, speakingStyle: 600, boundaries: 400, examples: 3, exampleText: 200, extra: 1000, total: 4000, avatarBytes: 2 * 1_048_576 };

export const blankPersona = (): Persona => ({ name: 'Mira', ring: 'lavender', avatar: null, userCallName: '', language: 'auto', identity: '', personality: '', speakingStyle: '', boundaries: '', examples: [], extra: '' });
export const draftFrom = (persona: Persona | null): Persona => persona ? structuredClone(persona) : blankPersona();
const chars = (text: string) => [...text].length;
const cleaned = (text: string) => text.replace(/\r\n?/g, '\n').trim();
/** What the save request carries: trimmed text, complete example pairs only. */
export function normalizedDraft(draft: Persona): Persona {
  const { presetId, ...rest } = draft;
  return { ...rest, name: cleaned(draft.name), userCallName: cleaned(draft.userCallName), identity: cleaned(draft.identity), personality: cleaned(draft.personality),
    speakingStyle: cleaned(draft.speakingStyle), boundaries: cleaned(draft.boundaries), extra: cleaned(draft.extra),
    examples: draft.examples.map(example => ({ user: cleaned(example.user), reply: cleaned(example.reply) })).filter(example => example.user || example.reply),
    ...(presetId ? { presetId } : {}) };
}
/** A draft with nothing beyond the built-in Mira is saved as "no persona". */
export function isDefaultDraft(draft: Persona): boolean {
  const value = normalizedDraft(draft);
  return value.name === 'Mira' && value.ring === 'lavender' && value.avatar === null && value.language === 'auto' && !value.userCallName && !value.identity
    && !value.personality && !value.speakingStyle && !value.boundaries && !value.extra && !value.examples.length;
}
export function personaPayload(draft: Persona): Persona | null { return isDefaultDraft(draft) ? null : normalizedDraft(draft); }
export function samePersona(a: Persona | null, b: Persona | null): boolean {
  const comparable = (value: Persona | null) => { if (!value) return null; const { presetId: _preset, ...rest } = normalizedDraft(value); return rest; };
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}
const languageNames: Record<PersonaLanguage, string> = { auto: 'follow the conversation', zh: 'Chinese', en: 'English', ja: 'Japanese', ko: 'Korean' };
/** Mirrors the server's profile rendering so the footer can count the 4,000 budget offline. */
export function renderedLength(draft: Persona): number {
  const value = normalizedDraft(draft);
  const lines = [`Name: ${value.name}`];
  if (value.userCallName) lines.push(`How to address the user: ${value.userCallName}`);
  lines.push(`Primary language: ${languageNames[value.language]}`);
  const field = (label: string, text: string) => { if (text) lines.push(text.includes('\n') ? `${label}:\n${text}` : `${label}: ${text}`); };
  field('Identity and background', value.identity); field('Personality and attitude', value.personality); field('Speaking style', value.speakingStyle);
  field('Boundaries (things you do not do or play)', value.boundaries);
  if (value.examples.length) { lines.push('Example exchanges (voice only, not facts):'); for (const example of value.examples) lines.push(`User: ${example.user}`, `${value.name}: ${example.reply}`); }
  field('Additional notes', value.extra);
  return chars(lines.join('\n'));
}
/** First client-side problem in the draft, in the interface language. */
export function draftProblem(draft: Persona, limits: PersonaLimits = defaultLimits): string | null {
  const value = normalizedDraft(draft);
  if (!value.name) return '请填写名字';
  const over: Array<[string, string, number]> = [['名字', value.name, limits.name], ['称呼', value.userCallName, limits.userCallName], ['身份与背景', value.identity, limits.identity],
    ['性格与态度', value.personality, limits.personality], ['说话方式', value.speakingStyle, limits.speakingStyle], ['边界', value.boundaries, limits.boundaries], ['补充说明', value.extra, limits.extra]];
  for (const [label, text, limit] of over) if (chars(text) > limit) return `${label}超过 ${limit} 字`;
  if (value.examples.length > limits.examples) return `示例对话最多 ${limits.examples} 组`;
  if (value.examples.some(example => !example.user || !example.reply)) return '每组示例对话需要同时填写两句';
  if (value.examples.some(example => chars(example.user) > limits.exampleText || chars(example.reply) > limits.exampleText)) return `每句示例不超过 ${limits.exampleText} 字`;
  if (renderedLength(value) > limits.total) return `人设总长度超过 ${limits.total.toLocaleString()} 字`;
  return null;
}
/** The optional follow-up sent through the ordinary Memory request envelope. */
export function conflictMemoryRequest(name: string): string {
  return `我刚把你的人设改成了「${name}」。请检查 Memory 里关于你自己的名字、性格和说话方式的记录，与新人设冲突的就更新或删掉；关于我的事实不要动。`;
}
export const avatarTypes = ['image/png', 'image/jpeg', 'image/webp'] as const;
export function avatarFileProblem(file: { type: string; size: number }, limit = defaultLimits.avatarBytes): string | null {
  if (!(avatarTypes as readonly string[]).includes(file.type)) return '头像只支持 PNG、JPEG 或 WebP 图片';
  if (file.size === 0) return '不能上传空文件';
  if (file.size > limit) return `头像图片不能超过 ${Math.round(limit / 1_048_576)} MB`;
  return null;
}
async function checked(response: Response, fallback: string): Promise<Response> {
  if (response.ok) return response;
  let message = fallback;
  try { const body = await response.json() as { error?: unknown }; if (typeof body.error === 'string') message = body.error; } catch { /* bounded fallback */ }
  throw new ApiError(message, response.status);
}
export async function uploadAvatar(file: Blob, signal: AbortSignal): Promise<{ id: string; mimeType: string; bytes: number }> {
  const response = await checked(await clientFetch('/api/persona/avatar', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, signal }), `头像上传未完成`);
  return await response.json() as { id: string; mimeType: string; bytes: number };
}
/** Protected fetch to a bounded raster Blob; never a protected URL in <img src>. */
export async function avatarBlob(id: string, signal: AbortSignal, limit = defaultLimits.avatarBytes): Promise<Blob> {
  if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('头像标识无效');
  const response = await checked(await clientFetch(`/api/persona/avatar/${id}`, { signal }), '头像读取未完成');
  const type = response.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (!(avatarTypes as readonly string[]).includes(type)) { await response.body?.cancel(); throw new Error('头像格式不受支持'); }
  const blob = await response.blob();
  if (blob.size > limit) throw new Error('头像超过大小上限');
  return new Blob([blob], { type });
}
