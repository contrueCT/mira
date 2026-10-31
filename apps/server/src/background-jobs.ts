import type { BackgroundJobReader, DurableWriter, LifeEvent } from '@mira/life';
import type { BackgroundJob, BackgroundOutcome, ForegroundOptions } from '@mira/runtime-pi';

/** ADR 0049 bounds: hard foreground limit and the grace before a waiting user
 * message moves the running tool to the background. */
export const FOREGROUND_HARD_LIMIT_MS = 5 * 60_000;
export const FOREGROUND_STEER_GRACE_MS = 20_000;
const RESULT_TEXT_BYTES = 16_384;
/** Never moved: reply publication and quick History/Memory reads. */
const NON_PROMOTABLE = new Set(['send_reply', 'history_search', 'history_read', 'history_page']);

export function backgroundResultId(jobId: string): string { return JSON.stringify(['tool-background-result', jobId]); }
function bounded(text: string, limit = RESULT_TEXT_BYTES): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= limit) return { text, truncated: false };
  return { text: `${bytes.subarray(0, limit).toString('utf8').replace(/\uFFFD+$/u, '')}\n[Result truncated for this event.]`, truncated: true };
}
function minutes(ms: number): string { return ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.round(ms / 60_000)} min`; }

export interface BackgroundJobsOptions {
  writer: DurableWriter & BackgroundJobReader;
  /** Wake Mira (non-user source; a balance pause keeps the event queued). */
  kick: () => void;
  signal: AbortSignal;
  activeSubagents?: () => number;
  onFailure?: (error: unknown) => void;
  hardLimitMs?: number;
  steerGraceMs?: number;
}

/** Owner-side registry for tool calls moved off the foreground (ADR 0049).
 * Durable facts are events: started (non-waking), then exactly one of
 * settled (real outcome) or lost (process ended first). Never replays. */
export class BackgroundJobs {
  readonly #options: BackgroundJobsOptions;
  readonly #running = new Map<string, BackgroundJob>();
  constructor(options: BackgroundJobsOptions) { this.#options = options; }

  get running(): BackgroundJob[] { return [...this.#running.values()]; }

  foreground(): ForegroundOptions {
    return {
      hardLimitMs: this.#options.hardLimitMs ?? FOREGROUND_HARD_LIMIT_MS,
      steerGraceMs: this.#options.steerGraceMs ?? FOREGROUND_STEER_GRACE_MS,
      promotable: name => !NON_PROMOTABLE.has(name),
      signal: this.#options.signal,
      onBackground: job => this.#started(job),
      onSettled: (job, outcome) => this.#settled(job, outcome),
    };
  }

  async #started(job: BackgroundJob): Promise<void> {
    await this.#options.writer.receive({ id: JSON.stringify(['tool-background-started', job.jobId]), type: 'tool.background.started', source: 'system',
      occurredAt: job.backgroundedAt, payload: { operation: 'background-started', ...job } });
    this.#running.set(job.jobId, job);
  }

  async #settled(job: BackgroundJob, outcome: BackgroundOutcome): Promise<void> {
    this.#running.delete(job.jobId);
    if (this.#options.signal.aborted || this.#options.writer.signal.aborted) return;
    const settledAt = new Date().toISOString();
    let detail: Record<string, string | boolean>;
    if (outcome.status === 'completed') {
      const text = outcome.result.content.map(block => block.type === 'text' ? block.text : `[${block.mimeType} image omitted from this event]`).join('\n');
      const result = bounded(text);
      detail = { status: 'completed', result: result.text, truncated: result.truncated };
    } else detail = { status: 'rejected', error: bounded(outcome.error, 2_048).text,
      note: 'The tool threw after running in the background. This does not prove the effect failed or did not happen.' };
    const event: LifeEvent = { id: backgroundResultId(job.jobId), type: 'tool.background.settled', source: 'system', occurredAt: settledAt,
      payload: { operation: 'background-settled', jobId: job.jobId, callId: job.callId, toolName: job.toolName, startedAt: job.startedAt, settledAt, ...detail } };
    try {
      const receipt = await this.#options.writer.receive(event, { id: event.id, reason: 'background tool settled' });
      if (receipt === 'inserted') this.#options.kick();
    } catch (error) { this.#options.onFailure?.(error); }
  }

  /** At startup: a started job without a result belonged to a previous
   * process. Its outcome is unknown; record that once, never re-run it. */
  async recoverLost(): Promise<number> {
    let count = 0;
    for (const started of await this.#options.writer.pendingBackgroundJobs()) {
      const payload = started.payload as Record<string, unknown>;
      const jobId = typeof payload['jobId'] === 'string' ? payload['jobId'] : null;
      if (!jobId) continue;
      const event: LifeEvent = { id: backgroundResultId(jobId), type: 'tool.background.lost', source: 'system', occurredAt: new Date().toISOString(),
        payload: { operation: 'background-lost', jobId, callId: typeof payload['callId'] === 'string' ? payload['callId'] : null,
          toolName: typeof payload['toolName'] === 'string' ? payload['toolName'] : null, startedAt: typeof payload['startedAt'] === 'string' ? payload['startedAt'] : null,
          status: 'unknown', note: 'Mira restarted while this tool call ran in the background. Its outcome is unknown and it was not re-run. Check the actual state before relying on it.' } };
      if (await this.#options.writer.receive(event, { id: event.id, reason: 'background tool lost on restart' }) === 'inserted') count++;
    }
    return count;
  }

  /** Model-only status attached to a newly delivered input; null when there
   * is nothing worth saying for an initial Wake input. */
  status(context: { phase: 'initial' | 'live'; wakeStartedAt: string }): string | null {
    const now = Date.now();
    const jobs = this.running;
    const subagents = this.#options.activeSubagents?.() ?? 0;
    const lines: string[] = [];
    if (context.phase === 'live') lines.push(`This message arrived while the current Wake was running (started ${context.wakeStartedAt}, ${minutes(now - Date.parse(context.wakeStartedAt))} ago). It was delivered at a safe boundary; nothing was cancelled.`);
    if (jobs.length) {
      lines.push('Tool calls still running in the background (outcome unknown until their tool.background.settled event arrives):');
      for (const job of jobs.slice(0, 10)) lines.push(`- ${job.toolName} (job ${job.jobId}, running ${minutes(now - Date.parse(job.startedAt))})`);
      if (jobs.length > 10) lines.push(`- …and ${jobs.length - 10} more`);
    }
    if (subagents) lines.push(`Subagents running: ${subagents}.`);
    if (context.phase === 'initial' && !jobs.length && !subagents) return null;
    return lines.join('\n');
  }
}
