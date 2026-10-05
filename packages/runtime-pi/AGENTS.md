# Pi adapter

Shared rules: [root AGENTS.md](../../AGENTS.md). Read `README.md` before changes.

## Entry and authority

- `src/index.ts` exports the durable agent-core adapter; `src/records.ts` owns
  versioned Pi JSON validation; `src/compactor.ts` uses full public SDK compaction
- Pi packages are pinned to 1.0.2; change versions only with explicit approval and
  contract/recovery tests. Upstream provenance is in the approved Pi feasibility ADR
- PostgreSQL is the sole authority. Never introduce persistent SessionManager
  files, copied private compaction helpers or a file-backed runtime fallback
- Unknown versions/types and unsafe tool/checkpoint structure fail closed

## Hard boundaries

- Authorization before durable intent and effect; persist original requested and
  actual validated arguments independently. Never infer permission from tool text
- Effects are sequential. Hook throws alone do not stop Pi. Keep explicit stopped
  latch, outer error, wrapped model/effect gates and awaited subscribers
- A thrown effect is unknown; never synthesize definitive failure or blindly replay
- Preserve exact known outcomes across the outcome/transcript crash window,
  including timestamps. Duplicate call IDs are errors
- Compaction snapshots are disposable. CAS and cancellation fence publication;
  COMMIT-dispatch ambiguity requires authoritative recovery
- Compactor uses an unregistered disposable provider alias verified through public
  APIs. Pass the original model to the injected stream; never persist the alias,
  register a provider, or mutate process env to prevent ambient auth discovery
- All streams are injected; no credentials or live provider fallback. Runtime
  compaction never modifies Memory/State

## Checks

Root `pnpm test` covers offline runtime tests. `pnpm test:integration` includes
real PostgreSQL recovery tests under `tests/recovery/`, needs the explicit isolated
`MIRA_TEST_DATABASE_URL`, and fails rather than silently skipping absent service.
`pnpm check:all` is the full gate. Tests and claims must distinguish offline,
real database, and live model validation. See recovery README for exact setup.
