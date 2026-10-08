import { defineExtension, type ExtensionEvent, type Json } from '@mira/extension-sdk';

/** Source facts, not a synthetic identity for every poll or activation. */
export type Observation = {
  id: string;
  revision: string;
  occurredAt: string;
  status: string;
  payload: Json;
};

/** Supply this via a separate provider using only the authorized source access.
 * Return a bounded batch; retain/replay the complete original source envelope
 * (id, revision, occurredAt, status and payload) if delivery fails or restarts.
 * Changing a fact needs a new revision/ID, never a new timestamp under its old ID.
 * Capture an unavailable source timestamp once at first observation and retain it;
 * do not substitute a fixed production timestamp or the current retry time.
 * Honor abort and bound actual I/O. The example itself has no account,
 * credentials, or network. */
export type WatchSource = {
  id: string;
  poll(signal: AbortSignal): Promise<readonly Observation[]>;
};
export type WatchConfig = {
  intervalMilliseconds: number;
  targetStatus: string;
  statusToolName: string;
};
type Phase = 'poll' | 'event' | 'wake';

export default defineExtension<WatchConfig>({
  name: 'watch-and-wake',
  requires: ['watch-source'],
  apply(api, config) {
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || !Number.isSafeInteger(config.intervalMilliseconds) || config.intervalMilliseconds < 1
      || config.intervalMilliseconds > 2_147_483_647
      || typeof config.targetStatus !== 'string' || !config.targetStatus.trim()
      || typeof config.statusToolName !== 'string' || !config.statusToolName.trim()) {
      throw new TypeError('Expected positive integer intervalMilliseconds <= 2147483647, targetStatus and statusToolName');
    }
    // Capture this generation; never look up a newer provider from a running tool.
    const source = api.service<WatchSource>('watch-source');
    if (!source || typeof source.id !== 'string' || !source.id || typeof source.poll !== 'function') {
      throw new TypeError('watch-source must provide a stable id and cancellable poll');
    }
    const controller = new AbortController();
    let stopping = false;
    let pending: Promise<void> | undefined;
    let phase: Phase = 'poll';
    let completedPolls = 0;
    let failureCount = 0;
    let lastFailure: { phase: Phase } | null = null;

    async function pollOnce(): Promise<void> {
      phase = 'poll';
      const observations = await source.poll(controller.signal);
      for (const observation of observations) {
        if (stopping) return;
        phase = 'event';
        if (typeof observation.id !== 'string' || !observation.id
          || typeof observation.revision !== 'string' || !observation.revision
          || typeof observation.status !== 'string' || typeof observation.occurredAt !== 'string'
          || !Number.isFinite(Date.parse(observation.occurredAt))) {
          throw new TypeError('Source observations need stable id/revision and occurrence time');
        }
        const event: ExtensionEvent = {
          id: JSON.stringify(['watch', source.id, observation.id, observation.revision]),
          type: 'watch.observation',
          occurredAt: observation.occurredAt,
          payload: { status: observation.status, data: observation.payload },
        };
        if (observation.status === config.targetStatus) {
          phase = 'wake';
          // Submit the event and Wake together. Emitting this event first could
          // deduplicate the later submission before its Wake is enqueued.
          // This reason is deterministic. Retries must retain the full event,
          // Wake ID and reason; the host rejects changed bodies under one ID.
          await api.requestWake({ id: event.id, reason: 'Watcher matched the configured status', event });
        } else {
          await api.emitEvent(event);
        }
      }
      if (!stopping) completedPolls++;
    }

    function tick(): void {
      if (stopping || pending) return; // interval callbacks do not await async work
      pending = pollOnce().catch((error: unknown) => {
        const expectedAbort = stopping && phase === 'poll' && controller.signal.aborted
          && (error === controller.signal.reason || (error instanceof Error && error.name === 'AbortError'));
        if (!expectedAbort) {
          failureCount++;
          // Do not expose raw error messages or source data: they may contain secrets.
          lastFailure = { phase };
        }
      }).finally(() => { pending = undefined; });
    }

    // Register before starting work. The host stops the interval before this runs.
    api.onCleanup(async () => {
      stopping = true;
      controller.abort();
      // SDK event delivery has no abort parameter. Join it rather than releasing
      // state early; the loop checks stopping before submitting another fact.
      await pending;
    });
    api.registerTool({
      name: config.statusToolName,
      description: 'Inspect watcher activity and polling/delivery failure counts without source data.',
      parameters: { type: 'object', additionalProperties: false },
      async execute(_arguments, { signal }) {
        signal.throwIfAborted();
        const details = { running: pending !== undefined, stopping, completedPolls, failureCount, lastFailure };
        return { text: JSON.stringify(details), details };
      },
    });
    api.interval(tick, config.intervalMilliseconds);
    tick();
  },
});
