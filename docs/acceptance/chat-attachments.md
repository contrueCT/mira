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

## Local aggregate results before the final image-limit finding

With the exact pinned pnpm directory prepended to PATH (including nested scripts),
`pnpm check` passed: all typecheck projects, package boundaries, 727 Node tests,
42 Web unit tests, tool build and production Vite build. The final compaction-index
change also passed a separate Pi typecheck and its focused seven-test suite.
PostgreSQL/browser/live-model stages are separate and not included in this claim.


## First CI run and follow-up

Run `38416989302` failed in the old hidden-tool timeline recovery test: its
hand-built cursor used only event/context kinds, while the timeline now includes
tool records to expose explicit attachment publications. History correctly rejected
that mismatched cursor (HTTP 400). The fixture now uses all three timeline kinds;
privacy assertions and the strict cursor validation remain intact. The other 171
PostgreSQL integration/recovery tests passed, including attachment recovery. Browser
stages did not run because the earlier stage failed.

A further budget regression reserves bytes already present in ordinary Pi image
blocks before selecting attachment media. A 6 MiB ordinary image plus a 7 MiB
explicit video read now retains the file reference and reports omitted video,
rather than exceeding the provider request budget. All eight focused runtime
attachment tests and the Pi typecheck passed locally.

The fresh final review reproduced a P2 quiet-Timeline regression: an oversized
private tool result hit the generic read-limit notice before publication filtering.
The fallback now keeps unreadable tool/context records invisible rather than
publishing a notice. It cannot verify an oversized context record is a public
reply; the original remains retained. Event read-limit notices remain unchanged.
Ordinary tools remain private; only explicit bounded send_attachment publications
are intended for the conversation.

The same review found that re-sending an uploaded immutable `.../UUID/data` path
lost its display name. Snapshotting now recognizes only verified paths owned by
this attachment store and preserves the original name in a new immutable copy.
The regression covers PDF names, unrelated lookalike paths, symlinks and tampering.

On `11ea5a1fd99ffd66d96269abdd4088df79c8450b`, the complete local check
passed 729 Node tests, 42 Web unit tests, all typechecks, boundaries and builds.
The newly added oversized-read PostgreSQL regression still requires CI execution.

A subsequent fresh independent review reproduced another P2 with a valid 9,000px
PNG: storage accepted the image, and actual Anthropic Pi/SDK request serialization
forwarded its original out-of-limit dimensions. The synthetic fetch intercepted
the request; no live provider was called. The correction reuses Pi's public image
resize helper on verified request-only bytes, keeping immutable originals intact,
and honors model-declared image-count limits. Failed normalization must report
omitted bytes rather than repeatedly failing the Wake.

The image correction's 12 focused runtime attachment tests and 133 combined
runtime/compaction/provider regressions passed locally. The real Anthropic SDK
wire test now sees a 2,000×2 request image and coordinate note for a 9,000×10
original, with identical original digest/bytes and repeatable restart hydration.
Coverage includes failed image preparation, catalog count limits and deterministic
post-resize accounting when an image's encoded representation grows.
