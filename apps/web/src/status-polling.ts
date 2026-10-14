const activeInterval = 1200;
const idleInterval = 5000;

/** The Timeline's existing visible-page polling loop, shared by automatic and manual refreshes. */
export function createStatusPolling(refresh: () => Promise<void>, isWorking: () => boolean, isHidden: () => boolean) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dueAt = 0;
  let stopped = false;
  let generation = 0;
  const clear = () => { clearTimeout(timer); timer = undefined; };
  const schedule = (delay: number) => {
    clear();
    dueAt = Date.now() + delay;
    timer = setTimeout(() => { timer = undefined; void poll(); }, delay);
  };
  const poll = async () => {
    const currentGeneration = ++generation;
    clear();
    if (stopped || isHidden()) return;
    await refresh();
    if (!stopped && !isHidden() && currentGeneration === generation) schedule(isWorking() ? activeInterval : idleInterval);
  };
  return {
    poll,
    statusChanged() {
      // A manual refresh can discover work while the old idle timer is still armed.
      // Shorten that wait, without postponing an earlier poll or starting a second loop.
      if (!stopped && !isHidden() && timer !== undefined && isWorking() && dueAt > Date.now() + activeInterval) schedule(activeInterval);
    },
    visibilityChanged() { generation += 1; clear(); if (!isHidden()) void poll(); },
    stop() { stopped = true; generation += 1; clear(); },
  };
}
