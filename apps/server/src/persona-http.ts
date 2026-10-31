import type { FastifyInstance } from 'fastify';
import { WebHttpError } from './http.ts';
import { parsePersona, personaLimits, personaRings, personaLanguages, renderPersona, PersonaError, type Persona, type PersonaHistoryItem, type PersonaView } from './persona.ts';
import { personaPresets } from './persona-presets.ts';

export interface PersonaApplied { revision: string; at: string }
export interface PersonaBackend {
  persona(): Promise<PersonaView & { applied: PersonaApplied | null }>;
  savePersona(revision: string, persona: unknown): Promise<PersonaView & { applied: PersonaApplied | null; changed: boolean }>;
  personaHistory(): Promise<PersonaHistoryItem[]>;
  restorePersona(revision: string, expectedRevision: string): Promise<PersonaView & { applied: PersonaApplied | null; changed: boolean }>;
  uploadPersonaAvatar(bytes: Uint8Array): Promise<{ id: string; mimeType: string; bytes: number }>;
  readPersonaAvatar(id: string): Promise<{ mimeType: string; bytes: Uint8Array }>;
}
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const noQuery = object({});
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const short = (max: number) => ({ type: 'string', maxLength: max * 4 });
const personaSchema = { anyOf: [{ type: 'null' }, object({
  name: short(personaLimits.name), ring: { enum: [...personaRings] }, avatar: { anyOf: [{ type: 'null' }, digest] },
  userCallName: short(personaLimits.userCallName), language: { enum: [...personaLanguages] },
  identity: short(personaLimits.identity), personality: short(personaLimits.personality), speakingStyle: short(personaLimits.speakingStyle),
  boundaries: short(personaLimits.boundaries), extra: short(personaLimits.extra), presetId: { type: 'string', maxLength: 40 },
  examples: { type: 'array', maxItems: personaLimits.examples, items: object({ user: short(personaLimits.exampleText), reply: short(personaLimits.exampleText) }, ['user', 'reply']) },
}, ['name'])] };
/** Re-project every value so adapter fields never reach the browser. */
export const personaView = (persona: Persona | null): Persona | null => persona ? {
  name: persona.name, ring: persona.ring, avatar: persona.avatar, userCallName: persona.userCallName, language: persona.language,
  identity: persona.identity, personality: persona.personality, speakingStyle: persona.speakingStyle, boundaries: persona.boundaries,
  examples: persona.examples.map(example => ({ user: example.user, reply: example.reply })), extra: persona.extra,
  ...(persona.presetId === undefined ? {} : { presetId: persona.presetId }),
} : null;
const stateView = (state: PersonaView & { applied: PersonaApplied | null; changed?: boolean }) => ({
  revision: state.revision, version: state.version, updatedAt: state.updatedAt, persona: personaView(state.persona),
  applied: state.applied ? { revision: state.applied.revision, at: state.applied.at } : null,
  ...(state.changed === undefined ? {} : { changed: state.changed }),
});
export const personaPublicLimits = { name: personaLimits.name, userCallName: personaLimits.userCallName, identity: personaLimits.identity,
  personality: personaLimits.personality, speakingStyle: personaLimits.speakingStyle, boundaries: personaLimits.boundaries,
  examples: personaLimits.examples, exampleText: personaLimits.exampleText, extra: personaLimits.extra, total: personaLimits.total, avatarBytes: personaLimits.avatarBytes };

export function registerPersonaHttp(app: FastifyInstance, backend: Partial<PersonaBackend>): void {
  const personaBackend = (): PersonaBackend => {
    if (!backend.persona || !backend.savePersona || !backend.personaHistory || !backend.restorePersona || !backend.uploadPersonaAvatar || !backend.readPersonaAvatar) throw new WebHttpError('unavailable');
    return backend as PersonaBackend;
  };
  app.get('/api/persona', { schema: { querystring: noQuery } }, async () => ({ ...stateView(await personaBackend().persona()), limits: personaPublicLimits }));
  app.put<{ Body: { revision: string; persona: unknown } }>('/api/persona', { bodyLimit: 65_536, schema: { querystring: noQuery, body: object({ revision: digest, persona: personaSchema }, ['revision', 'persona']) } },
    async request => stateView(await personaBackend().savePersona(request.body.revision, request.body.persona)));
  app.get('/api/persona/presets', { schema: { querystring: noQuery } }, async () => ({ presets: personaPresets.map(preset => ({ id: preset.id, label: preset.label, persona: personaView(preset.persona) })) }));
  /** Only the <persona_profile> block; never the full system prompt. */
  app.post<{ Body: { persona: unknown } }>('/api/persona/preview', { bodyLimit: 65_536, schema: { querystring: noQuery, body: object({ persona: personaSchema }, ['persona']) } }, async request => {
    const persona = parsePersona(request.body.persona);
    const text = persona ? renderPersona(persona) : null;
    return { text, chars: text === null ? 0 : [...text].length, limit: personaLimits.total };
  });
  app.get('/api/persona/history', { schema: { querystring: noQuery } }, async () => ({ items: (await personaBackend().personaHistory()).map(item => ({
    revision: item.revision, version: item.version, savedAt: item.savedAt, name: item.persona?.name ?? null, persona: personaView(item.persona) })) }));
  app.post<{ Body: { revision: string; expectedRevision: string } }>('/api/persona/restore', { schema: { querystring: noQuery, body: object({ revision: digest, expectedRevision: digest }, ['revision', 'expectedRevision']) } },
    async request => stateView(await personaBackend().restorePersona(request.body.revision, request.body.expectedRevision)));
  app.post<{ Body: Buffer }>('/api/persona/avatar', { bodyLimit: personaLimits.avatarBytes, schema: { querystring: noQuery } }, async (request, reply) => {
    if (!Buffer.isBuffer(request.body)) throw new PersonaError('invalid');
    const result = await personaBackend().uploadPersonaAvatar(request.body);
    return reply.code(201).send({ id: result.id, mimeType: result.mimeType, bytes: result.bytes });
  });
  app.get<{ Params: { id: string } }>('/api/persona/avatar/:id', { schema: { querystring: noQuery, params: object({ id: digest }, ['id']) } }, async (request, reply) => {
    const result = await personaBackend().readPersonaAvatar(request.params.id);
    return reply.type(result.mimeType).header('content-disposition', 'inline').send(Buffer.from(result.bytes));
  });
}
