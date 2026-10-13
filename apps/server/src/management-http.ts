import type { FastifyInstance } from 'fastify';
import { WebHttpError } from './http.ts';
import type { AssistantReplyView, ExtensionMutation, ExtensionView, ManagementBackend, MemoryReceiptView, RunSummaryView } from './management.ts';

const object = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', additionalProperties: false, properties, required });
const noQuery = object({});
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const cursor = { type: 'string', minLength: 1, maxLength: 2048, pattern: '^[A-Za-z0-9_-]+$' };
const page = { querystring: object({ before: cursor }) };
const uuid = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const runParams = object({ id: uuid }, ['id']);
const privateError = 'The operation reported a problem. Raw diagnostics are hidden to protect private data.';
const replyView = (reply: AssistantReplyView | null) => reply ? { id: reply.id, text: reply.text, occurredAt: reply.occurredAt } : null;
const memoryView = (memory: MemoryReceiptView) => ({ state: memory.state, commit: memory.commit });
const summaryView = (run: RunSummaryView) => ({ id: run.id, occurredAt: run.occurredAt, status: run.status, requestCount: run.requestCount });
const extensionView = (entry: ExtensionView): ExtensionView => ({
  id: entry.id, revision: entry.revision, enabled: entry.enabled, status: entry.status, activation: entry.activation,
  tools: [...entry.tools], contextProviders: [...entry.contextProviders], error: entry.error === null ? null : privateError,
  generated: entry.generated ? { digest: entry.generated.digest, revision: entry.generated.revision,
    history: entry.generated.history.map(revision => ({ id: revision.id, digest: revision.digest })) } : null,
});
/** Re-project even typed service output: accidental adapter fields must never
 * reach the browser when host/history structures grow. */
export function registerManagementHttp(app: FastifyInstance, backend: Partial<ManagementBackend>): void {
  const requireMethod = <K extends keyof ManagementBackend>(key: K): ManagementBackend[K] => {
    const method = backend[key]; if (!method) throw new WebHttpError('unavailable');
    return method.bind(backend) as ManagementBackend[K];
  };
  app.get('/api/memory', { schema: { querystring: noQuery } }, async () => {
    const result = await requireMethod('memory')();
    return { configured: result.configured, content: result.content, revision: result.revision };
  });
  app.get<{ Params: { id: string } }>('/api/messages/:id/status', {
    schema: { querystring: noQuery, params: object({ id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_.:-]*$' } }, ['id']) },
  }, async request => {
    const result = await requireMethod('messageStatus')(request.params.id);
    return { id: result.id, eventId: result.eventId, runId: result.runId, state: result.state,
      assistant: replyView(result.assistant), memory: memoryView(result.memory), error: result.error === null ? null : privateError };
  });
  app.get('/api/extensions', { schema: { querystring: noQuery } }, async () => {
    const result = await requireMethod('extensions')();
    return { available: result.available, extensions: result.extensions.map(extensionView), releases: result.releases.map(release => ({ digest: release.digest })),
      error: result.error === null ? null : privateError };
  });
  app.post<{ Params: { id: string }; Body: ExtensionMutation }>('/api/extensions/:id', {
    schema: { querystring: noQuery, params: object({ id: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[a-zA-Z][a-zA-Z0-9_-]*$' } }, ['id']),
      body: { oneOf: [
        object({ expectedRevision: digest, action: { enum: ['enable', 'disable', 'reload'] } }, ['expectedRevision', 'action']),
        object({ expectedRevision: digest, action: { const: 'configure' }, config: {} }, ['expectedRevision', 'action', 'config']),
        object({ expectedRevision: digest, action: { const: 'update' }, digest }, ['expectedRevision', 'action', 'digest']),
        object({ expectedRevision: digest, action: { const: 'rollback' }, revision: uuid }, ['expectedRevision', 'action', 'revision']),
      ] } },
  }, async request => {
    const result = await requireMethod('changeExtension')(request.params.id, request.body);
    return { id: result.id, extensionId: result.extensionId, action: result.action, status: result.status, persistence: result.persistence,
      runtime: result.runtime ? extensionView(result.runtime) : null, error: result.error === null ? null : privateError };
  });
  app.get<{ Querystring: { before?: string } }>('/api/runs', { schema: page }, async request => {
    const result = await requireMethod('runs')(request.query.before);
    return { items: result.items.map(summaryView), nextCursor: result.nextCursor };
  });
  app.get<{ Params: { id: string }; Querystring: { before?: string } }>('/api/runs/:id', {
    schema: { ...page, params: runParams },
  }, async (request, reply) => {
    const result = await requireMethod('run')(request.params.id, request.query.before);
    if (!result) return reply.code(404).send({ error: 'Run not found' });
    return { ...summaryView(result), requests: result.requests.map(item => ({ eventId: item.eventId, source: item.source, type: item.type, reason: item.reason })),
      assistant: replyView(result.assistant), memory: memoryView(result.memory),
      executions: result.executions.map(item => ({ id: item.id, occurredAt: item.occurredAt, kind: item.kind, name: item.name, status: item.status, error: item.error === null ? null : privateError })),
      nextCursor: result.nextCursor, compactionErrors: 'not-recorded', error: result.error === null ? null : privateError };
  });
}
