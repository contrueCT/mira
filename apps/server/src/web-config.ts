import os from 'node:os';
import path from 'node:path';

/** Shared CLI path resolution; startup still validates the source boundary. */
export function resolveWebMiraHome(value: string | undefined): string {
  return path.resolve(value ?? path.join(os.homedir(), '.mira'));
}

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

/** An explicit single browser origin, never a wildcard or the bind address. */
export function webPublicOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('MIRA_PUBLIC_ORIGIN must be an exact http(s) origin, for example http://192.168.1.20:3210'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/' || value !== url.origin || url.hostname.includes('*') || ['0.0.0.0', '[::]'].includes(url.hostname)) throw new Error('MIRA_PUBLIC_ORIGIN must be an exact http(s) origin without path, credentials or wildcard bind address');
  return url.origin;
}
export function webListenHost(value: string | undefined): '127.0.0.1' | '0.0.0.0' {
  if (value === undefined || value === '127.0.0.1') return '127.0.0.1';
  if (value === '0.0.0.0') return value;
  throw new Error('MIRA_HOST must be 127.0.0.1 or 0.0.0.0');
}
