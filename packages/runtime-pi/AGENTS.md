# Pi adapter

Shared rules: [root AGENTS.md](../../AGENTS.md). Read `README.md` before changes.

## Entry and authority

- `src/index.ts` exports the durable agent-core adapter; `src/records.ts` owns
  versioned Pi JSON validation; `src/compactor.ts` uses full public SDK compaction
- Pi packages are pinned to 1.0.2; change versions only with explicit approval and
  contract/recovery tests. Upstream provenance is in the approved Pi feasibility ADR
- PostgreSQL is the sole authority. Never introduce persistent SessionManager
  files, copied private compaction helpers or a file-backed runtime fallback
- Unknown versions/types and unsafe tool/checkpoint structure fail closed; only
  mira.recovery-observation.v1 is accepted as a custom-message extension

## Hard boundaries

- Authorization before durable intent and effect; persist original requested and
  actual validated arguments independently. Never infer permission from tool text
- Effects are sequential. Hook throws alone do not stop Pi. Keep explicit stopped
  latch, outer error, wrapped model/effect gates and awaited subscribers
- A thrown effect is unknown; never synthesize definitive failure or blindly replay.
  Persist the narrowly versioned recovery observation and continue cognition;
  application deferral records not-started plus reason without a global stop.
  Matching arguments are advisory evidence, not an unconditional retry veto
- Preserve exact known outcomes across the outcome/transcript crash window,
  including timestamps. Duplicate call IDs are errors
- Compaction snapshots are disposable. CAS and cancellation fence publication;
  COMMIT-dispatch ambiguity requires authoritative recovery
- Compactor uses an unregistered disposable provider alias verified through public
  APIs. Pass the original model to the injected stream; never persist the alias,
  register a provider, or mutate process env to prevent ambient auth discovery
- `miraPrompt.loadInitialMemory` loads only an empty version-zero durable stream; persist the first-record `miraMemory` snapshot and never reread after ordinary wake, restart, file change or compaction. No change-notice machinery
- `miraPrompt` uses the full source template and `mira.system.v0.2` section at the actual request boundary; persist updates before requests under the same writer/CAS
- Maintain current v0.5/v0.2 only: no old initialization entrypoint, bootstrap parser or checkpoint migration; preserve current raw history, tool recovery and exact-system compaction checks
- Renderer substitutions are allowlisted, escaped and single-pass; tool guidance uses the same declared registry, never a stale separate snapshot
- `history-tools.ts` returns Mira-bound original history; generic persistence never parses Pi
- All streams are injected; no credentials or live provider fallback. Runtime
  compaction never modifies Memory

## Checks

Root `pnpm test` covers offline runtime tests. `pnpm test:integration` includes
real PostgreSQL recovery tests under `tests/recovery/`, needs the explicit isolated
`MIRA_TEST_DATABASE_URL`, and fails rather than silently skipping absent service.
`pnpm check:all` is the full gate. Tests and claims must distinguish offline,
real database, and live model validation. See recovery README for exact setup.
