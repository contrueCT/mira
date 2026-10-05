import { defineExtension } from '@mira/extension-sdk';
export default defineExtension({
  name: 'clock-source',
  apply(api) {
    let ticks = 0;
    const startedAt = new Date().toISOString();
    const pending = new Set<Promise<unknown>>();
    let lastFailure: unknown;
    api.provideService('example-clock', { read: () => ticks });
    api.interval(() => {
      ticks++;
      api.publish('example.tick', { ticks });
      const event = { id: `${startedAt}:${ticks}`, type: 'example.tick', occurredAt: new Date().toISOString(), payload: { ticks } };
      // A durable fact is still not a Wake. Save failure is observed at cleanup;
      // no detached rejection or untracked operation survives the resource scope.
      const task = api.emitEvent(event).catch(error => { lastFailure = error; }).finally(() => pending.delete(task));
      pending.add(task);
    }, 1000);
    api.onCleanup(async () => { await Promise.all(pending); ticks = 0; if (lastFailure) throw lastFailure; });
  },
});
