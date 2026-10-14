# ADR 0029: Bounded transient model-request retries

Status: Accepted scope, 2026-10-14. Implementation and verification are described below; live provider validation is not claimed.

## Boundary

Retry one buffered provider request before a complete assistant message reaches the durable runtime. The credential-owning server transport already withholds SSE deltas. A failed partial response, including partial tool calls, is discarded. Only the final complete message or exhausted error is emitted. Runtime persistence, tool intent, effects, outcome recording, Wake completion and compaction publication are outside this retry loop.

No whole Wake, tool batch, unknown external effect or persistence operation is automatically replayed. A later model request after a tool uses the already persisted outcome/recovery observation. Existing context-overflow compaction recovery remains separate. Compaction summary requests and child requests inherit the same transport boundary; retries do not rerun compaction publication or child tools.

## Policy

- At most three attempts, including the original request. Pi/SDK `maxRetries` remains explicitly zero; no provider internal retry settings or Pi package versions change.
- Backoff before attempts two and three is 250 ms and 1,000 ms. An observed HTTP `Retry-After` may raise a delay up to 10 seconds. No timer survives cancellation or process exit.
- Explicit retryable HTTP statuses are 408, 429, 500, 502, 503, 504 and 529.
- Explicit transport codes are `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `UND_ERR_HEADERS_TIMEOUT`, `UND_ERR_BODY_TIMEOUT`, `ECONNRESET`, `ECONNREFUSED`, `EPIPE`, `EAI_AGAIN` and `UND_ERR_SOCKET`. Inspect at most three cause levels, without guessing from diagnostic text. Response-body errors are observed at the actual fetch/reader boundary before the SDK flattens them.
- Authentication/configuration/schema errors, redirects, TLS certificate failures, permanent DNS failures, unknown errors, invalid provider output and cancellation are not retryable. Once a non-success HTTP status is received, it owns classification: a network reset while reading a permanent 400/401/403/422 error body cannot make that request retryable. No credential, URL, provider body or arbitrary error field enters retry status.
- Each attempt creates fresh request-local auth/header/failure state. The configured model, request context and explicit output/reasoning options remain the same. Web credential revision checks run again before dispatch.
- Providers without a verified observable fetch boundary, including the pinned Pi Google adapter, do not gain text-inferred retries. Existing upstream behavior remains unchanged.

The attempt count and delays bound retry overhead, not the duration of a single provider request. A failed generation may still have incurred provider-side usage; this does not promise free retry or provider-side exactly-once generation.

## Errors, cancellation and status

Intermediate errors are not persisted as assistant messages and do not set the Web error state. Runtime receives one sanitized terminal error containing only the last failure. Bounded first/last diagnostics and the actual attempt count stay in the separate `ModelRequestFailure.message` for Web status; its `terminalMessage` links that diagnostic to the thrown runtime error. This prevents an earlier rate-limit message from masking Pi’s final context-overflow classification and existing compaction recovery. Successful recovery clears temporary status. Existing credential-echo rejection and bounded diagnostic redaction apply to every attempt.

The main Web request exposes an optional `modelRetry` observation via the existing status endpoint: phase (`waiting`/`requesting`), attempt, maximum attempts, delay and a fixed reason category. The ordinary working indicator displays waiting/retrying text. It is transient, clears on success/failure/cancellation/close, and is not a Timeline event or a durable retry log. Child model activity remains scoped to the child and cannot overwrite the main retry status.

The indicator reflects the latest status poll, not a pushed event or retry history. Visible-page polling remains 1.2 seconds while working and 5 seconds while idle. When any refresh confirms working, a pending idle poll is brought forward to the active interval; an already earlier poll is not postponed. The same one-shot scheduler handles manual refresh, visibility and disposal, with no duplicate loop or timer after hidden/unmounted completion. This is best-effort observation: a short retry phase can start and finish between polls and need not flash in the UI.

Abort during backoff settles the same stream as aborted and prevents the next request. Late completions after cancellation are withheld. Shutdown drops pending retry timers. On restart, existing durable Wake/runtime recovery decides whether an unfinished model request may continue; retry counters are request-local, not a new persistent scheduler. Settled or unknown tools retain their original evidence and are not rerun by this feature.

## Verification

`tests/unit/model-retry.test.mts` runs the real pinned SDK with injected synthetic HTTP/SSE failures, the actual transport and durable runtime. It covers request-only recovery, three-attempt exhaustion and first/last diagnostics, non-retryable cases, network codes, bounded Retry-After, partial text/tool streams, unknown effects, assistant-write failure and cancellation. Existing three-protocol transport and secret-redaction tests remain applicable.

`tests/recovery/model-retry.test.mts` uses isolated PostgreSQL and the real Web service, settings, runtime, SDK and actual ordinary bash tool. It checks temporary HTTP status, one committed effect, no intermediate error transcript, completed restart and shutdown during backoff followed by recovery. `modelFetch` is programmatic test injection at the same credential-bound transport; it does not supply an alternate runtime or expose a Web setting.

`tests/e2e/web.spec.ts` checks the retry indicator on a narrow screen, refresh, phase changes and completion using the established browser fixture. This UI fixture does not claim PostgreSQL or provider connectivity. Real PG and browser gates must run in CI if local socket/browser restrictions prevent execution. No live provider, paid model or deployment was used.

`pnpm test:capabilities:e2e` additionally includes a real browser → HTTP → PostgreSQL → runtime → credential-bound SDK/fetch test. A real ordinary bash effect is followed by injected HTTP 429, visible backoff, recovery, browser refresh and service restart. It checks one effect and absence of intermediate failure records; provider responses alone are synthetic. The first SDK response is gated until the browser has observed working, and a controlled browser clock proves that the next real status read happens at 1.2 seconds rather than retaining the old 5-second idle timer. Server backoff remains a real 3 seconds. A gated successful SDK response then keeps the actual requesting phase stable for a narrow-screen screenshot; it does not extend Retry-After or mock status. Deterministic Web timer tests additionally cover repeated working refreshes, earlier polls, visibility, shared in-flight reads, and disposal/late completion. The fixture-only status test is supplemental, not a replacement for this gate.

Each retry repeats the SDK logging/cloud-environment guard before constructing
a fresh SDK instance or resolving credentials. An unsafe environment change during
backoff stops the request before another fetch and cannot enable raw SDK logging.


## SDK-construction guard

The pinned public eager OpenAI Completions, OpenAI Responses, Anthropic Messages and Google Generative AI implementations are imported before requests. Models still performs explicit async authentication; its `streamSimple` dispatch then checks SDK logging/cloud environment and synchronously enters the eager implementation. In Pi 1.0.2 these implementations construct the client before their first await. Checking only at request entry, retry entry or before a lazy adapter import leaves a gap in which a newly set logging variable can leak response headers.

No global environment, console, SDK package or logging implementation is mutated. Static loading adds the already-installed SDK modules to startup, with no credential resolution or network request. Builtin identity, model metadata, compatibility options and headers remain intact; OpenCode/OpenCode Go reuse the public `withOpenCodeSessionHeader` wrapper. Deferred Cloudflare/Copilot integrations remain excluded. Unrelated implementations, including Mistral, keep their provider-owned dispatch.

Fresh-process real-SDK regression tests cover all three logging protocols, custom and builtin connections, credential-resolution changes, the former lazy-load window, HTTP-200 response-header echoes, and Google cloud-mode changes. Permanent HTTP broken-body failures remain single-attempt; retryable 5xx and 2xx stream resets retain retries. A real runtime path verifies settled tool → 429 → 400 context overflow → transient summary retry → one compaction → final response, without repeating the tool. These are injected protocol responses, not live provider validation.
