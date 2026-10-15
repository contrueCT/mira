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

- Main-model conversation/Prompt judgment chooses a call or clarification (ADR 0007).
  No authorize callback, allowed/evidence/denial decision, replacement engine or extra model call
- Validate schema/parameters, persist immutable intent, then effect; retain original
  and validated arguments, assistantRecordId and persisted context version as provenance.
  authorizationContext is factual prompt context, never synthetic approval
- ADR 0024 live input interrupts only model requests; the in-flight single tool settles, then pending input wins before old siblings. Preserve original Wake input, supplemental CAS links, final arbitration and unknown recovery.
- Effects are sequential. Hook throws alone do not stop Pi. Keep explicit stopped
  latch, outer error, wrapped model/effect gates and awaited subscribers
- A thrown effect is unknown; never synthesize definitive failure or blindly replay.
  Persist the narrowly versioned recovery observation and continue cognition;
  recorded calls without intent remain not-started, not authorization denials.
  Matching arguments are advisory evidence, not an unconditional retry veto
- Preserve exact known outcomes across the outcome/transcript crash window,
  including timestamps. Duplicate call IDs are errors
- Optional recovery diagnostics use fixed allowlisted phase/category only, exact
  unknown-intent linkage and bounds; never copy raw errors or rejected values.
  Result validation may recover unknown; finishTool/writer faults stay fatal
- Automatic compaction defaults on at safe `prepareRequest` after settled tools; budget includes Pi estimates, protocol overhead, current system and tool schemas. Reserve caps actual output; automatic candidates must reduce and fit. At most one overflow recovery retry per run (ADR 0016)
- The approved `prompts/mira-compaction-v0.1.md` replaces coding-summary instructions via public `session_before_compact`: one initial/update/split_turn request; hook failure must fail closed without SDK default fallback. Include the full rendered persona reference (Memory placeholder), separate frozen Memory and JSON source/boundary data in the input budget; omit hidden thinking/provider internals, preserve original entry IDs/timestamps
- Compaction snapshots are disposable. CAS and cancellation fence publication;
  COMMIT-dispatch ambiguity requires authoritative recovery
- Compactor uses an unregistered disposable provider alias verified through public
  APIs. Pass the original model to the injected stream; never persist the alias,
  register a provider, or mutate process env to prevent ambient auth discovery
- `miraPrompt.loadMemory` loads an empty version-zero stream and loads one frozen candidate Memory before each summary; that same snapshot enters the final checkpoint; publish refreshed system/Memory/summary/tail in one fenced CAS checkpoint. Ordinary requests, restart and file changes reuse the latest snapshot; no old loader alias or change notices
- ADR 0038: identified prompt snapshots validate against their published template; an absent identity denotes only the immutable pre-delegation revision. Upgrade at natural request preparation, never by rewriting history or reloading Memory; compaction preserves the frozen template identity.
- `miraPrompt` uses the full source template and `mira.system.v0.2` section at the actual request boundary; persist updates before requests under the same writer/CAS
- `loadSkills` refreshes Pi metadata at natural requests only; append the public formatter after rendering in that same section. Task workers without `miraPrompt` use a separate persisted skills section, with no main persona/Memory bootstrap. Bodies use ordinary read; no scanner during recover/compact, watcher, extra Wake or Memory reload
- `loadContextProviders` samples once at natural prepareRequest; sourced bounded JSON joins existing environment prompt inputs and same fenced persisted snapshot. No extra Wake/Memory load; recovery/compaction retain frozen samples (ADR 0019)
- Maintain current v0.5/v0.2 only: no old initialization entrypoint, bootstrap parser or checkpoint migration; preserve current raw history, tool recovery and exact-system compaction checks
- Dynamic hosts guard pinned activation identity at execution: stale removed/replaced calls return a known not-executed result, never redirect by name or throw an ambiguous effect failure
- Renderer substitutions are allowlisted, escaped and single-pass; tool guidance uses the same declared registry, never a stale separate snapshot
- New compaction candidates receive full History UUIDs; never rewrite existing parent/first-kept references or provider call IDs
- `history_read` takes the global UUID, optional byte budget, and optional code-point offset/revision for complete JSON-text paging above 1 MiB; kind comes from persistence, Memory `History-Id` works directly
- ADR 0028: persist complete normalized outcomes/transcripts before projecting tool text to 16 KiB with an existing ordinary-file spool reference. Recovery/compaction use the same projection; missing files reconstruct, conflicts fail, non-text metadata survives, known effects never replay
- `history-tools.ts` returns Mira-bound original history; generic persistence never parses Pi
- Attachment refs are validated durable user metadata; hydration is request-local only. Recovery compares ordered refs; compaction retains immutable file identities and never claims omitted media was seen. Native video uses transient metadata for the explicitly supported transport (ADR 0021), never fake image blocks.
- Task workers use `compactionScope: task` with a separate hash-checked task summary prompt through the same SDK hook; reject main `miraPrompt`/Memory configuration. Parent Dreaming counts remain stream-local; never use main persona summary instructions for child continuity.
- All streams are injected; no credentials or live provider fallback. Runtime
  compaction never modifies Memory

## Checks

Root `pnpm test` covers offline runtime tests. `pnpm test:integration` includes
real PostgreSQL recovery tests under `tests/recovery/`, needs the explicit isolated
`MIRA_TEST_DATABASE_URL`, and fails rather than silently skipping absent service.
`pnpm check:all` is the full gate. Tests and claims must distinguish offline,
real database, and live model validation. See recovery README for exact setup.

- ADR 0027: explicitly initialize Agent thinkingLevel with the configured preference (default medium) adapted by Pi public model capabilities. Main/child/Dreaming share this option; summaries use the lowest supported level independently, never inherit costly conversation settings or autonomously escalate.
