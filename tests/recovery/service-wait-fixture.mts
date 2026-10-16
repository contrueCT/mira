import type { LocalWebService } from '@mira/server';

/** A Node test timeout does not unwind an unresolved test body. Bound fixture
 * barriers themselves so their caller reaches its resource-cleanup finally. */
export async function boundedFixtureWait<T>(work: Promise<T>, label: string, signal?: AbortSignal, timeoutMs = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      abort = () => reject(signal?.reason ?? Error(`${label}: aborted`));
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => reject(Error(`${label}: timed out after ${timeoutMs} ms`)), timeoutMs);
      work.then(resolve, reject);
      if (signal?.aborted) abort();
    });
  } finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

/** Preserve a synthetic provider's original assertion instead of replacing it
 * with a timeout after the service has already entered its protected error state. */
export async function providerEntered(service: LocalWebService, started: () => boolean, failure: () => unknown, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!started()) {
    signal?.throwIfAborted();
    if (failure() !== undefined) throw failure();
    const status = await service.status();
    if (status.state === 'error' || status.state === 'stopped' || Date.now() >= deadline) throw Error(`Provider did not enter: ${JSON.stringify(status)}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
