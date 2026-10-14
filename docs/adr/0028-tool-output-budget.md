# ADR 0028: Unified tool text budget with complete readable evidence

Status: Accepted implementation scope, 2026-10-14. Local verification and CI results
must be reported separately; no paid provider or deployment validation is implied.

## Problem

Pi bash already limits output to 2,000 lines / 50 KiB and provides its own full
output file. Mira must retain that behavior, while extension `result.text` and
other tools currently enter the model without a shared text budget.
`normalizeToolResult` validates and detaches JSON; it must not silently erase
known evidence. Original History reads also have a 1 MiB complete-response ceiling,
which previously made larger records unreachable through `history_read`.

## Decision

- Keep the existing technical execution boundary: validate arguments, save intent,
  execute once, normalize JSON, save the complete outcome, then append the exact
  transcript result. Save all defined normalized result fields, including opaque
  metadata, `structuredContent`, `terminate`, images and attachment references.
- At the disposable active-projection boundary, cap each tool result's combined
  UTF-8 text at 16,384 bytes, including an explicit incomplete-preview notice and
  actionable complete-evidence reference. This covers built-ins, extensions,
  management, History and child tools using the same runtime. Short results with sufficient room for media annotations remain
  unchanged. Non-text blocks and metadata keep their original meaning; native
  media still follows its separate existing hydration budget.
- Use the existing `writeOverflowInput` / `writeWakeInput` immutable ordinary-file
  spool. The stable key includes Mira and the original tool-result History UUID.
  Keys within the spool's 4,096-character limit retain their existing spelling and
  file paths. Longer keys, which could not previously be published, use a distinct
  `tool-output-sha256:` namespace and the SHA-256 of the JSON-encoded Mira/History
  pair. This bounds arbitrary valid Mira IDs without changing existing references.
  PostgreSQL remains the authority. No table, migration, persistent SessionManager,
  new log, background worker, generic state engine or custom file-reading tool is
  introduced. Bash's own full-output pointer stays intact in the preserved result.
- Spool the complete canonical result JSON as `mira-tool-result-json-chunks-v1`
  JSONL: a header with total original JSON bytes and SHA-256, then ordered
  `{ "text": "..." }` chunks. Joining decoded chunk values reconstructs the exact
  JSON. Each source chunk is at most 2,048 UTF-8 bytes; encoding yields a small
  ordinary-file line even for a giant single-line original. Use existing `read`
  with line `offset`/`limit`, initially `offset=1, limit=3`. Full text and metadata
  are reachable; a preview never implies the omitted text was reviewed.
- Recovery first validates original outcome/transcript equality and repairs a
  known outcome missing its append. Only then does it derive bounded projections.
  Each fresh runtime restores all potentially referenced result files from the
  full verified history, including entries entirely outside the compacted tail.
  Active references are verified on every projection. Archived files are checked
  once per runtime instance, tracked by disposable immutable History IDs, avoiding
  repeated lifetime file I/O on each request; the next runtime checks them again.
  Missing files reconstruct from canonical evidence and conflicts fail without
  replacement. This cache is not recovery authority. Spool/ownership failure prevents model
  dispatch but cannot relabel a committed known outcome as unknown or replay it.
- Read-result media annotations get a conservative model-independent allowance
  when deciding which canonical results need complete-evidence files. Thus even a
  near-limit original whose file is referenced only after hydration can be restored
  after compaction or a model change. At the final stream boundary, preserve every
  media annotation and native-video slot, shortening only original preview text to
  fit the 16 KiB total. If annotations plus the reference cannot fit, fail before
  provider dispatch rather than hide them. Request-local native-video/base64 and
  omission notes never enter the canonical evidence file.
- Automatic and explicit compaction consume the same bounded projection. Candidate
  fit checks also use it, while authoritative original history remains intact.
  Existing request-budget and compaction logic still bounds aggregate context;
  16 KiB is a per-result text limit, not a provider tokenizer guarantee. A summary
  may omit details; original History remains searchable/readable afterward.

## Large History reads

The fixed-Mira core reader adds `readText({id,offset,maxBytes?,revision?})`.
The existing `read({id,maxBytes?})` contract and 1 MiB full-response ceiling remain.
The model uses the same `history_read` tool with optional `offset` and `revision`:

- Omit `offset` for a complete original or an honest `too_large` response.
- Pass `offset=0` to begin JSON-text pagination, including originals over 1 MiB.
  Text budgets default to 4,096 bytes and accept 4..65,536; response metadata adds
  bounded overhead. The page envelope includes only fixed-size identity/revision
  and numeric pagination fields; original Mira/timestamp strings appear only in
  paged JSON text, so large valid source metadata cannot make every page too large.
  PostgreSQL returns at most `floor(maxBytes/4)` code points per
  page, guaranteeing the UTF-8 bound without slicing a multibyte character.
- Copy `nextOffset` and the first page's SHA-256 `revision` for continuation.
  Offsets count Unicode code points, not JavaScript UTF-16 units or bytes. A null
  next offset is the end. Join page `text` in order to reconstruct the original.
- Every page is a fixed-Mira read-only query over the original identity/detail
  sources. Only its bounded slice crosses the database connection. Source identity
  checks and parameter validation remain enforced; original timestamps remain
  exactly preserved in the paged JSON. Tool/Wake records
  can acquire an outcome or final association; if the source changes, the next
  revision-bound page rejects and tells the caller to restart. There is no cached
  snapshot or new pagination state table. Database timeouts still apply.

## Verification and limits

`tests/unit/tool-output.test.mts` exercises real Pi tool execution, extension text
mapping, ordinary `read`, full JSON/Unicode/metadata preservation, restart and
missing-file reconstruction, conflict/failure handling, outcome-before-append
recovery and full SDK compaction. `tests/unit/history.test.mts` covers SQL bounds,
scope, code-point offsets, request validation and revision failure.

`tests/integration/history.test.mts` reconstructs a >1 MiB Unicode record through
real database pages, including an oversized writer-valid timestamp, and rejects
a changed Wake revision.
`tests/recovery/tool-output.test.mts` and its process fixture exercise actual
PostgreSQL process death after outcome commit, fresh-process reconstruction and
real runtime `history_read` pagination. The capabilities browser gate adds
Chromium → HTTP → service → PostgreSQL → extension → runtime → ordinary read,
followed by service restart and no repeated effect. Only model output is scripted.

The main/child runtime must receive the existing spool writer. Missing configuration
fails explicitly only when an oversized result needs a reference. Giant inherited
`fork=all` snapshots retain their existing explicit size refusal; this change does
not relax the child inheritance bound. No file is automatically deleted. This is
not a sandbox against arbitrary host-user edits, a disk quota, or a claim of live
model accuracy. Local socket restrictions block real PG/browser execution when
present; those gates must actually pass in CI before claiming they passed.
