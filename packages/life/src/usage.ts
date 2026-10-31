/** Read-only model usage aggregation (ADR 0048). The runtime adapter owns the
 * transcript format; it supplies JSON paths so storage never interprets it. */
export interface UsageProjection {
  /** Paths inside a context record envelope. */
  message: {
    /** Envelope `kind` value of an ordinary transcript message. */
    kind: string;
    role: string[]; roleValue: string;
    usage: string[]; provider: string[]; model: string[];
    stopReason: string[]; failedStopReasons: string[];
  };
  checkpoint: { kind: string; usage: string[] };
  /** Usage object keys, summed as the request total. */
  fields: { input: string; output: string; cacheRead: string; cacheWrite: string };
}
export type UsageRange = 'today' | '7d' | '30d';
export interface UsageRequest { range: UsageRange; timeZone: string }
export interface UsageCounts { requests: number; failedRequests: number; input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
export type UsageSource = 'main' | 'subagent' | 'compaction' | 'dreaming';
export interface UsageReport {
  range: UsageRange;
  timeZone: string;
  generatedAt: string;
  /** Inclusive start of the selected range, as an ISO instant. */
  since: string;
  totals: UsageCounts;
  /** The equally long period immediately before `since`. */
  previous: UsageCounts;
  /** One entry per local day, oldest first: 7 for today/7d, 30 for 30d. */
  days: Array<{ date: string } & UsageCounts>;
  bySource: Array<{ source: UsageSource; tasks: number } & UsageCounts>;
  /** At most 5 Wakes in the range with the largest totals (subagents excluded). */
  topWakes: Array<{ runId: string; claimedAt: string; trigger: { source: string; type: string } | null; preview: string | null } & UsageCounts>;
  /** At most 10 provider/model pairs. */
  byModel: Array<{ provider: string; model: string } & UsageCounts>;
}
export interface UsageReader {
  usage(request: UsageRequest, projection: UsageProjection): Promise<UsageReport>;
}
