import {
  parseExternalEvent, parseExternalWake, parseExternalNotification, parseExternalReceipt,
  type ExternalEvent, type ExternalWake, type ExternalNotification, type ExternalReceipt,
} from './protocol.ts';

export interface MiraCredentials { senderId: string; token: string }
export interface MiraClientOptions {
  /** An explicit http://127.0.0.1:<port> origin (1024–65535, matching the local CLI); no other URL components. */
  baseUrl: string;
  /** Loaded for every call. The SDK never reads files or ambient credentials. */
  credentials: () => MiraCredentials | Promise<MiraCredentials>;
  fetch?: typeof globalThis.fetch;
  /** Whole-call timeout, including credential loading and the response body. */
  timeoutMs?: number;
}
export interface MiraRequestOptions { signal?: AbortSignal }
export interface MiraClient {
  emitEvent(event: ExternalEvent, options?: MiraRequestOptions): Promise<ExternalReceipt>;
  requestWake(wake: ExternalWake, options?: MiraRequestOptions): Promise<ExternalReceipt>;
  sendNotification(notification: ExternalNotification, options?: MiraRequestOptions): Promise<ExternalReceipt>;
}
export type MiraClientErrorOutcome = 'not_sent' | 'rejected' | 'unknown';
export type MiraClientErrorCode = 'invalid_configuration' | 'invalid_input' | 'credentials_unavailable'
  | 'cancelled' | 'timeout' | 'network_error' | 'http_error' | 'invalid_response' | 'response_too_large';

const messages: Record<MiraClientErrorCode, string> = {
  invalid_configuration: 'Invalid external client configuration',
  invalid_input: 'Invalid external request',
  credentials_unavailable: 'External credentials unavailable',
  cancelled: 'External request cancelled',
  timeout: 'External request timed out',
  network_error: 'External request transport failed',
  http_error: 'External server returned an HTTP error',
  invalid_response: 'Invalid external receipt',
  response_too_large: 'External response exceeded its limit',
};

/** Contains fixed diagnostics only: never a request, response body, URL, token,
 * or original exception. Unknown outcomes must be reconciled with the exact
 * original request; the client never retries or generates replacement IDs. */
export class MiraClientError extends Error {
  readonly code: MiraClientErrorCode;
  readonly outcome: MiraClientErrorOutcome;
  readonly status: number | undefined;
  constructor(code: MiraClientErrorCode, outcome: MiraClientErrorOutcome, status?: number) {
    super(messages[code]);
    this.name = 'MiraClientError'; this.code = code; this.outcome = outcome; this.status = status;
  }
}

export const MAX_EXTERNAL_RESPONSE_BYTES = 8192;
const senderIdentifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const bearerToken = /^[A-Za-z0-9_-]{43}$/;
const routes = { event: '/api/external/events', wake: '/api/external/wake', notification: '/api/external/notifications' } as const;

function readCredentials(input: unknown): MiraCredentials {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error();
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) throw new Error();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== 2) throw new Error();
  for (const key of ['senderId', 'token']) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error();
  }
  const senderId: unknown = descriptors['senderId']!.value;
  const token: unknown = descriptors['token']!.value;
  if (typeof senderId !== 'string' || !senderIdentifier.test(senderId)
    || typeof token !== 'string' || !bearerToken.test(token)) throw new Error();
  return { senderId, token };
}

/** The supplied fetch is a trusted transport and must honor redirect:'error'. */
export function createMiraClient(options: MiraClientOptions): MiraClient {
  let baseUrl: string;
  let credentials: MiraClientOptions['credentials'];
  let transport: typeof globalThis.fetch;
  let timeoutMs: number;
  try {
    const configuredBaseUrl = options.baseUrl;
    const match = typeof configuredBaseUrl === 'string' ? /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/?$/.exec(configuredBaseUrl) : null;
    if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error();
    baseUrl = configuredBaseUrl.replace(/\/$/, '');
    credentials = options.credentials;
    const configuredFetch = options.fetch;
    const configuredTimeout = options.timeoutMs;
    transport = configuredFetch === undefined ? globalThis.fetch : configuredFetch;
    timeoutMs = configuredTimeout === undefined ? 10_000 : configuredTimeout;
    if (typeof credentials !== 'function' || typeof transport !== 'function'
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error();
  } catch { throw new MiraClientError('invalid_configuration', 'not_sent'); }

  async function send<T extends ExternalEvent | ExternalWake | ExternalNotification>(
    operation: ExternalReceipt['operation'], input: T, parse: (value: unknown) => T, requestOptions?: MiraRequestOptions,
  ): Promise<ExternalReceipt> {
    let snapshot: T;
    let body: string;
    let signal: AbortSignal | undefined;
    let alreadyAborted: boolean;
    try { snapshot = parse(input); body = JSON.stringify(snapshot); }
    catch { throw new MiraClientError('invalid_input', 'not_sent'); }
    try {
      signal = requestOptions?.signal;
      // Use the platform getter, not caller-overridden signal properties. It
      // also accepts genuine AbortSignals from another realm.
      const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
      alreadyAborted = signal === undefined ? false : aborted.call(signal) as boolean;
    } catch { throw new MiraClientError('invalid_configuration', 'not_sent'); }
    if (alreadyAborted) throw new MiraClientError('cancelled', 'not_sent');

    const safeErrors = new WeakSet<object>();
    const failure = (code: MiraClientErrorCode, outcome: MiraClientErrorOutcome, status?: number): MiraClientError => {
      const error = new MiraClientError(code, outcome, status);
      safeErrors.add(error); return error;
    };
    let dispatched = false;
    let status: number | undefined;
    let stopped: 'cancelled' | 'timeout' | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let received: Response | undefined;
    const controller = new AbortController();
    let rejectStopped!: (error: MiraClientError) => void;
    const stopPromise = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    // Install a rejection observer even if a synchronous failure occurs before
    // the first race. Every pending transport/read promise is also observed.
    void stopPromise.catch(() => undefined);
    const outcome = (): MiraClientErrorOutcome => dispatched ? 'unknown' : 'not_sent';
    const stop = (code: 'cancelled' | 'timeout'): void => {
      if (stopped) return;
      stopped = code;
      rejectStopped(failure(code, outcome(), status));
      controller.abort();
      if (reader) { try { void reader.cancel().catch(() => undefined); } catch { /* Abort still completes. */ } }
    };
    const onAbort = (): void => stop('cancelled');
    if (signal) EventTarget.prototype.addEventListener.call(signal, 'abort', onAbort, { once: true });
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    const checkStopped = (): void => { if (stopped) throw failure(stopped, outcome(), status); };
    try {
      // A loader is invoked once per call and its failure never escapes intact.
      const loaded = await Promise.race([
        Promise.resolve().then(() => { checkStopped(); return credentials(); }).then(readCredentials, () => { throw failure('credentials_unavailable', 'not_sent'); })
          .catch(() => { throw failure('credentials_unavailable', 'not_sent'); }),
        stopPromise,
      ]);
      checkStopped();
      const headers = {
        'x-mira-client': 'external', 'x-mira-sender': loaded.senderId,
        authorization: `Bearer ${loaded.token}`, 'content-type': 'application/json',
      };
      // Once fetch has been called, failure cannot establish whether the server
      // committed. Omit ambient cookies, referrers and browser cache credentials.
      dispatched = true;
      let pending: Promise<Response>;
      try {
        pending = Promise.resolve(transport(`${baseUrl}${routes[operation]}`, {
          method: 'POST', headers, body, signal: controller.signal,
          redirect: 'error', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        }));
      } catch { checkStopped(); throw failure('network_error', 'unknown'); }
      const safePending = pending.then(response => {
        received = response;
        if (stopped) {
          try { void response.body?.cancel().catch(() => undefined); } catch { /* Untrusted transport. */ }
          checkStopped();
        }
        return response;
      }, () => { checkStopped(); throw failure('network_error', 'unknown'); });
      const response = await Promise.race([safePending, stopPromise]);
      checkStopped();
      // Read status/stream under a sanitizing boundary even for injected fetch.
      try {
        const responseStatus = response.status;
        if (!Number.isInteger(responseStatus) || responseStatus < 100 || responseStatus > 599 || response.redirected) throw new Error();
        status = responseStatus;
        reader = response.body?.getReader();
      } catch { throw failure('invalid_response', 'unknown'); }
      if (status !== 200 && status !== 201) {
        // Error bodies are neither needed nor trusted; never copy them out.
        const rejected = status >= 400 && status < 500 && status !== 408;
        throw failure('http_error', rejected ? 'rejected' : 'unknown', status);
      }
      if (!reader) throw failure('invalid_response', 'unknown', status);
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      while (true) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try { chunk = await Promise.race([reader.read(), stopPromise]); }
        catch { checkStopped(); throw failure('network_error', 'unknown', status); }
        checkStopped();
        if (chunk.done) break;
        if (!(chunk.value instanceof Uint8Array)) throw failure('invalid_response', 'unknown', status);
        bytes += chunk.value.byteLength;
        if (bytes > MAX_EXTERNAL_RESPONSE_BYTES) throw failure('response_too_large', 'unknown', status);
        chunks.push(chunk.value);
      }
      let receipt: ExternalReceipt;
      try {
        const buffer = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
        receipt = parseExternalReceipt(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer)));
        if (receipt.operation !== operation || receipt.id !== snapshot.id
          || receipt.receipt !== (status === 201 ? 'inserted' : 'duplicate')
          || (receipt.operation === 'wake' && receipt.eventId !== (snapshot as ExternalWake).event.id)) throw new Error();
      } catch { throw failure('invalid_response', 'unknown', status); }
      return receipt;
    } catch (error) {
      if (error !== null && typeof error === 'object' && safeErrors.has(error)) throw error;
      throw failure(dispatched ? 'invalid_response' : 'credentials_unavailable', outcome(), status);
    } finally {
      clearTimeout(timer);
      if (signal) EventTarget.prototype.removeEventListener.call(signal, 'abort', onAbort);
      controller.abort();
      if (reader) {
        try { void reader.cancel().catch(() => undefined); reader.releaseLock(); } catch { /* Cleanup cannot leak transport errors. */ }
      } else {
        try { void received?.body?.cancel().catch(() => undefined); } catch { /* Malformed responses still fail safely. */ }
      }
    }
  }

  return {
    emitEvent: (event, requestOptions) => send('event', event, parseExternalEvent, requestOptions),
    requestWake: (wake, requestOptions) => send('wake', wake, parseExternalWake, requestOptions),
    sendNotification: (notification, requestOptions) => send('notification', notification, parseExternalNotification, requestOptions),
  };
}
