/** Validate before migration or any connection. Never echo a credential-bearing
 * URL in an exception, and never let pg fall back to an ambient database. */
export function localDatabaseUrl(value: string | undefined): string {
  const invalid = () => new Error('Set MIRA_DATABASE_URL to an explicit local PostgreSQL database without URL options');
  if (!value) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash || url.pathname.length <= 1) throw invalid();
  return value;
}

/** Startup setting only; no credentials, persisted preference, or settings UI. */
export function subagentConcurrency(value: string | undefined): number {
  if (value === undefined) return 8;
  if (!/^(?:[1-9]|[12][0-9]|3[0-2])$/.test(value)) throw new Error('MIRA_SUBAGENT_CONCURRENCY must be an integer from 1 to 32');
  return Number(value);
}
