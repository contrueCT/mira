import { useEffect, useRef } from 'react';

/** Read-only polling pauses for hidden panels/pages; all late reads are ignored. */
export function useVisiblePoll(active: boolean, read: (signal: AbortSignal) => Promise<void>, interval: number, version: string | number = 0): void {
  const readRef = useRef(read); readRef.current = read;
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { controller?.abort(); clearTimeout(timer); };
    const poll = async () => {
      stop();
      if (stopped || document.hidden) return;
      const current = new AbortController(); controller = current;
      try { await readRef.current(current.signal); }
      finally { if (!stopped && !current.signal.aborted && !document.hidden) timer = setTimeout(() => { void poll(); }, interval); }
    };
    const visibility = () => { if (document.hidden) stop(); else void poll(); };
    void poll(); document.addEventListener('visibilitychange', visibility);
    return () => { stopped = true; stop(); document.removeEventListener('visibilitychange', visibility); };
  }, [active, interval, version]);
}
