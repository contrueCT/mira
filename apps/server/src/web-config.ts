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
