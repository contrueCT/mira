import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parseExternalEvent, parseExternalWake, parseExternalNotification, ExternalProtocolError } from '@mira/external-sdk';
import type { ExternalIngress } from './external-ingress.ts';

export interface ExternalHttpOptions {
  access: { authenticate(senderId: string, token: string): Promise<boolean> };
  ingress: ExternalIngress;
}
/** Encapsulated JSON parser preserves ordinary payload keys without assigning
 * them into prototypes. Web parsers and origin guards remain unchanged. */
export function registerExternalHttp(app: FastifyInstance, ingress: ExternalIngress, senderOf: (request: FastifyRequest) => string): void {
  app.register(async scope => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 65_536 }, (_request, body, done) => {
      try { done(null, JSON.parse(body as string) as unknown); }
      catch { done(new ExternalProtocolError()); }
    });
    const schema = { querystring: { type: 'object', additionalProperties: false, properties: {} } };
    scope.post('/api/external/events', { schema }, async (request, reply) => {
      const result = await ingress.emitEvent(senderOf(request), parseExternalEvent(request.body));
      return reply.code(result.receipt === 'inserted' ? 201 : 200).send(result);
    });
    scope.post('/api/external/wake', { schema }, async (request, reply) => {
      const result = await ingress.requestWake(senderOf(request), parseExternalWake(request.body));
      return reply.code(result.receipt === 'inserted' ? 201 : 200).send(result);
    });
    scope.post('/api/external/notifications', { schema }, async (request, reply) => {
      const result = await ingress.sendNotification(senderOf(request), parseExternalNotification(request.body));
      return reply.code(result.receipt === 'inserted' ? 201 : 200).send(result);
    });
  });
}
