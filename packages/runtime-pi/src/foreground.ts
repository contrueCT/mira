import { randomUUID } from 'node:crypto';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';

/** A tool call that stopped blocking the conversation but keeps running.
 * Identity is durable through the owner's job registry (ADR 0049). */
export interface BackgroundJob {
  jobId: string; callId: string; toolName: string;
  startedAt: string; backgroundedAt: string;
  reason: 'hard-limit' | 'user-input';
}
/** The real end of a backgrounded call. A throw proves neither success nor
 * failure, so it is reported as `rejected` with its bounded message only. */
export type BackgroundOutcome =
  | { status: 'completed'; result: AgentToolResult }
  | { status: 'rejected'; error: string };

export interface ForegroundOptions {
  /** Hard bound for one foreground tool execution (default 5 minutes). */
  hardLimitMs: number;
  /** With a user message waiting, the tool moves to background once it has run this long. */
  steerGraceMs: number;
  /** Tools that may never be moved (e.g. reply publication); default all. */
  promotable?: (toolName: string) => boolean;
  /** Owner lifetime for promoted work. A promoted call is detached from the
   * Wake attempt; only this signal (service close) cancels it afterwards. */
  signal?: AbortSignal;
  /** Awaited before the receipt is returned; must durably record the job. */
  onBackground: (job: BackgroundJob) => Promise<void>;
  /** Called once with the real outcome. Never awaited by the Wake. */
  onSettled: (job: BackgroundJob, outcome: BackgroundOutcome) => void | Promise<void>;
}

export const BACKGROUND_NOTE = 'Still running; outcome unknown; it will arrive as a later event. Do not assume success or failure.';

/** Model-visible receipt. Honest: it states only that the call continues. */
export function backgroundReceipt(job: BackgroundJob, elapsedMs: number): AgentToolResult {
  const body = { status: 'backgrounded', jobId: job.jobId, elapsedMs, note: BACKGROUND_NOTE };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], details: body };
}

export function boundedError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

export interface Lease { promoted: Promise<BackgroundJob['reason']>; dispose(): void }

/** Race one foreground execution against its bounds. `pending()` reports
 * whether a user message is waiting; `subscribe` hints that one arrived. */
export function foregroundLease(options: ForegroundOptions, startedAt: number, pending: () => Promise<boolean>,
  subscribe?: (listener: () => void) => () => void): Lease {
  let resolve!: (reason: BackgroundJob['reason']) => void;
  const promoted = new Promise<BackgroundJob['reason']>(done => { resolve = done; });
  const timers: ReturnType<typeof setTimeout>[] = [];
  let disposed = false; let steering = false;
  timers.push(setTimeout(() => resolve('hard-limit'), Math.max(0, options.hardLimitMs - (Date.now() - startedAt))));
  const check = (): void => {
    if (disposed || steering) return;
    void pending().then(waiting => {
      if (!waiting || disposed || steering) return;
      steering = true;
      timers.push(setTimeout(() => resolve('user-input'), Math.max(0, options.steerGraceMs - (Date.now() - startedAt))));
    }, () => { /* the next boundary rechecks durably */ });
  };
  const unsubscribe = subscribe?.(check);
  check();
  return { promoted, dispose() { disposed = true; for (const timer of timers) clearTimeout(timer); unsubscribe?.(); } };
}

export function newJob(callId: string, toolName: string, startedAt: number, reason: BackgroundJob['reason']): BackgroundJob {
  return { jobId: randomUUID(), callId, toolName, startedAt: new Date(startedAt).toISOString(), backgroundedAt: new Date().toISOString(), reason };
}

/** Runtime status for the model only, attached to a delivered user message. */
export const RUNTIME_STATUS_FIELD = 'miraRuntimeStatus';
export const RUNTIME_STATUS_MAX_BYTES = 4_096;
export const RUNTIME_STATUS_PREFIX = '[Mira runtime status — system-sourced, not written by the user]';
export function validRuntimeStatus(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(RUNTIME_STATUS_PREFIX) && new TextEncoder().encode(value).byteLength <= RUNTIME_STATUS_MAX_BYTES;
}
export function boundRuntimeStatus(text: string): string {
  const full = `${RUNTIME_STATUS_PREFIX}\n${text}`;
  const bytes = new TextEncoder().encode(full);
  if (bytes.byteLength <= RUNTIME_STATUS_MAX_BYTES) return full;
  return `${new TextDecoder().decode(bytes.slice(0, RUNTIME_STATUS_MAX_BYTES - 8)).replace(/\uFFFD+$/u, '')}…`;
}
