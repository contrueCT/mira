import type { FastifyInstance } from 'fastify';
import { WebHttpError } from './http.ts';

/** The HTTP view of a reset coordinator; see life-host.ts and ADR 0047. */
export interface ResetHttpBackend {
  previewReset(scope: 'memory' | 'life'): Promise<{
    scope: 'memory' | 'life'; lifeId: string; persona: { name: string; custom: boolean };
    impact: { memoryFiles: number; memoryBytes: number; compactions: number; messages: number; pendingWakes: number; pendingDeliveries: number };
    busy: { running: boolean; subagents: number }; token: string; expiresAt: string; archivePath: string | null;
  }>;
  reset(input: { scope: 'memory' | 'life'; token: string; stopRunning: boolean; resetPersona: boolean }): Promise<{ resetId: string }>;
  resetStatus(id: string): { id: string; scope: 'memory' | 'life'; state: string; lifeId: string | null; archivePath: string | null; commit: string | null; error: string | null } | null;
}
const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const noQuery = object({});
const scope = { enum: ['memory', 'life'] };

export function registerResetHttp(app: FastifyInstance, backend: Partial<ResetHttpBackend>): void {
  const resets = (): ResetHttpBackend => {
    if (!backend.previewReset || !backend.reset || !backend.resetStatus) throw new WebHttpError('unavailable');
    return backend as ResetHttpBackend;
  };
  app.post<{ Body: { scope: 'memory' | 'life' } }>('/api/memory/reset/preview', { bodyLimit: 1024, schema: { querystring: noQuery, body: object({ scope }, ['scope']) } }, async request => {
    const preview = await resets().previewReset(request.body.scope);
    return { scope: preview.scope, lifeId: preview.lifeId, persona: { name: preview.persona.name, custom: preview.persona.custom },
      impact: { memoryFiles: preview.impact.memoryFiles, memoryBytes: preview.impact.memoryBytes, compactions: preview.impact.compactions, messages: preview.impact.messages,
        pendingWakes: preview.impact.pendingWakes, pendingDeliveries: preview.impact.pendingDeliveries },
      busy: { running: preview.busy.running, subagents: preview.busy.subagents }, token: preview.token, expiresAt: preview.expiresAt, archivePath: preview.archivePath };
  });
  // The typed confirmation is checked here as well as in the dialog: a script
  // cannot reset without the same explicit word and a fresh preflight token.
  app.post<{ Body: { scope: 'memory' | 'life'; token: string; confirm: string; stopRunning: boolean; resetPersona?: boolean } }>('/api/memory/reset', { bodyLimit: 2048, schema: { querystring: noQuery,
    body: object({ scope, token: { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' }, confirm: { const: '重置' }, stopRunning: { type: 'boolean' }, resetPersona: { type: 'boolean' } }, ['scope', 'token', 'confirm', 'stopRunning']) } },
  async (request, reply) => {
    const result = await resets().reset({ scope: request.body.scope, token: request.body.token, stopRunning: request.body.stopRunning, resetPersona: request.body.resetPersona === true });
    return reply.code(202).send({ resetId: result.resetId });
  });
  app.get<{ Params: { id: string } }>('/api/memory/reset/:id', { schema: { querystring: noQuery, params: object({ id: { type: 'string', format: 'uuid' } }, ['id']) } }, async (request, reply) => {
    const view = resets().resetStatus(request.params.id);
    if (!view) return reply.code(404).send({ error: 'Reset not found' });
    return { id: view.id, scope: view.scope, state: view.state, lifeId: view.lifeId, archivePath: view.archivePath, commit: view.commit, error: view.error };
  });
}
