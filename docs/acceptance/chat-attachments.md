# Chat attachment verification

Scope and limits: [ADR 0021](../adr/0021-chat-attachments.md).

## Evidence separation

- `tests/unit/attachments.test.mts`: immutable local bytes, metadata/path safety,
  MIME/dimension/size bounds and explicit known publication projection.
- `tests/unit/runtime-attachments.test.mts`: request-only image hydration and explicit read-only video hydration,
  references across restore and repeated compaction, malformed metadata/digest/
  native media limits. `wake-loop.test.mts` covers ordered merged refs and overflow.
- `tests/unit/model-video-transport.test.mts`: actual Pi 1.0.2 and bundled Google SDK
  HTTP serialization into native video inlineData, including interleaved tool
  messages, original reference text and supported protocol limits. Fetch is
  intercepted with synthetic credentials and responses. No live provider call or
  video semantic quality is claimed.
- `tests/recovery/attachments.test.mts`: real isolated PostgreSQL service, user
  receipt conflict, explicit attachment tool, immutable snapshot and restart.
- `tests/e2e/web.spec.ts`: explicitly mocked UI state/interaction tests.
- `pnpm test:attachments:e2e`: real browser -> production HTTP -> PG -> Wake ->
  runtime -> synthetic model -> real send_attachment -> immutable files. Includes
  picker/drop/paste, attachment-only order, preview/cancel/history, duplicate
  envelope, source modification/deletion, protected download, video/documents,
  pending failure/removal, service restart and desktop/narrow screenshots.

## First local failures and corrections

The first combined core test run passed 20/22. A new native-image test used the
old tiny synthetic context window despite the added media estimate, and repeated
compaction attempted a second cut without any new material. Test setup was fixed
with a realistic isolated context window and an actual new turn; 22/22 then passed.
Neither failure was hidden by skipping a test.

The local real-browser gate was attempted but had no configured isolated
MIRA_TEST_DATABASE_URL or PostgreSQL installation. The browser-only attempt also
failed to create Chromium's required socket with Operation not permitted. No local
PG/browser pass or screenshots are claimed. Full CI evidence, exact commit and
independent reviews must be recorded before this change is called ready to merge.

The initial default pnpm store path was unavailable. Installing the existing
locked dependencies with a workspace-local store/data directory and
--frozen-lockfile --ignore-scripts succeeded without changing dependencies or
running install scripts.

## First independent review

The first independent review reproduced a P2: an oversized old video disabled all
subsequent native media, including a new small image, because the byte budget was
all-or-nothing. Selection now prioritizes complete newest user-message groups and
explicitly marks omitted groups. A regression asserts the old video is not read
while the new image is native. Estimation uses the same model eligibility and
selection. This finding and fix remain subject to a fresh independent re-review.

The same first review reproduced two further P2 edge cases: an arbitrary 1,000-ref
limit could reject a legal coalesced backlog, and a zero-byte file published by the
model could not download in the browser. The aggregate cap was removed (per-message
10-file limit remains), with a 1,010-ref regression. Zero-byte Blob downloads now
work, including empty-body responses; the picker still rejects empty uploads.

The first full local check ran 720 Node tests, 718 passed and two toolchain tests
failed because the launcher was pnpm 11.25.0 rather than repository-pinned 11.28.4.
The strict engine test was not weakened. A workspace-local official pinned pnpm
is used for the rerun; CI also installs that exact pinned version.

The first review's fourth P2 exposed unbudgeted reference-text injection: a
200-document overflow Wake grew from a small spool notice to an over-window
provider request. Production Wake records now mark that refs are already in the
input/spool; documents are not reinjected. Native labels/notices and estimates use
one shared text projection. Compaction keeps compact original History-ID pointers,
with exact refs still available from authoritative records via history_read.
A 200-document overflow regression verifies the provider projection stays bounded.

The user's subsequent clarification changed video behavior before any merge:
video arrival is always file-only. Native Gemini video is available only after the
model explicitly invokes the existing read tool. Initial and restored user-video
messages must make zero byte-resolver calls for all model types.

A later review found a duplicate directory-fsync declaration introduced during
integration; it caused module-import/typecheck failures before execution. The
duplicate was removed and the focused store/read tests passed. The same review
identified lifetime growth of the compaction attachment index. It now indexes only
projected source records and points to the previous checkpoint for older references.
An eight-compaction regression follows that bounded chain back to the original
attachment source even when every synthetic summary omits the pointers.

## Current local aggregate result

With the exact pinned pnpm directory prepended to PATH (including nested scripts),
`pnpm check` passed: all typecheck projects, package boundaries, 727 Node tests,
42 Web unit tests, tool build and production Vite build. The final compaction-index
change also passed a separate Pi typecheck and its focused seven-test suite.
PostgreSQL/browser/live-model stages are separate and not included in this claim.
