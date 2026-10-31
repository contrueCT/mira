import type { UsageProjection } from '@mira/life';

/** Where Pi v1 session entries keep provider usage (ADR 0048). Storage sums
 * these paths generically; it never parses Pi payloads itself. */
export const PI_USAGE_PROJECTION: UsageProjection = Object.freeze({
  message: Object.freeze({
    kind: 'message', role: ['payload', 'message', 'role'], roleValue: 'assistant',
    usage: ['payload', 'message', 'usage'], provider: ['payload', 'message', 'provider'], model: ['payload', 'message', 'model'],
    stopReason: ['payload', 'message', 'stopReason'], failedStopReasons: ['error', 'aborted'],
  }),
  checkpoint: Object.freeze({ kind: 'checkpoint', usage: ['payload', 'usage'] }),
  fields: Object.freeze({ input: 'input', output: 'output', cacheRead: 'cacheRead', cacheWrite: 'cacheWrite' }),
}) as UsageProjection;
