// Offline-model tripwire, not a security sandbox. PostgreSQL sockets remain available.
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';

const nativeFetch = globalThis.fetch;
const localOrigins = new Map<string, number>();
function denied(): never { throw new Error('Tests may not call HTTP/model providers'); }

/** Explicit, revocable fixture-only permission. No environment bypass or general
 * loopback allowance: register only the exact HTTP origin this test started. */
export function allowLocalTestHttp(origin: string): () => void {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin);
  if (!match || Number(match[1]) > 65_535) throw new Error('An explicit local fixture HTTP origin is required');
  localOrigins.set(origin, (localOrigins.get(origin) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const remaining = (localOrigins.get(origin) ?? 1) - 1;
    if (remaining) localOrigins.set(origin, remaining); else localOrigins.delete(origin);
  };
}

http.request = denied;
http.get = denied;
https.request = denied;
https.get = denied;
globalThis.fetch = (input, init) => {
  let origin: string;
  let target: string | Request;
  try {
    // Snapshot the actual Request state rather than trusting a shadowed url
    // property, or stringifying a mutable URL-like object again at dispatch.
    target = input instanceof Request ? new Request(input) : String(input);
    const value = typeof target === 'string' ? target : target.url;
    // Reject alternate numeric hosts, implicit ports, credentials and schemes
    // before URL normalization. Matching the parsed origin also bounds the port.
    const match = /^(http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4})(?:[/?#]|$)/.exec(value);
    if (!match) return denied();
    origin = match[1]!;
    if (new URL(value).origin !== new URL(origin).origin) return denied();
  } catch { return denied(); }
  if (!localOrigins.has(origin)) return denied();
  // Native fetch must never follow a fixture redirect to a provider or another
  // unregistered port, even if a caller explicitly requests redirect:'follow'.
  return nativeFetch(target, { ...init, redirect: 'error' });
};
syncBuiltinESMExports();
