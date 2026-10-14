# ADR 0026: Observable delegated work and global skills

Status: User-approved scope; implementation under verification, 2026-10-14.

## Decision

Mira keeps one life, one main conversation and one Memory owner. Delegated workers
remain task-scoped. The user requested higher concurrency, directly inspectable
worker activity comparable to Codex, and loading `~/.agents/skills`.

The default child concurrency is eight. `MIRA_SUBAGENT_CONCURRENCY` accepts an
integer from 1 through 32 at startup. There is no new settings panel, nested
worker, automatic replay, or deployment/configuration change. Capacity admission
is serialized; cancelled work still occupies its process slot until actual work
and cleanup settle. PG also validates the configured bound.

An optional explicit public `title` describes a task. Without one the UI uses
“子任务”, never an excerpt of the private task or inherited context. Runtime model
and tool start/end observations are captured at real dispatch/persistence
boundaries. A child can explicitly call `report_progress` with a short public
update. Neither timers nor unknown tool outcomes imply active execution.

A turn stores its start time and a bounded public activity snapshot on its
existing PG row: at most 40 events, a dropped count and one current activity.
Runtime events contain structural names/states only, no tool arguments, results,
model request, reasoning or raw exception. Worker progress is explicitly sourced.
Terminal/restart handling clears current activity; unknown effects stay unknown.
Original transcript and tool records remain the authoritative execution evidence.

The main conversation contains compact clickable child cards only where a durable
spawn/followup parent-call association exists. Each card opens read-only child
turns, public activity and bounded result text. No permanent toolbar icon or
control panel is added. Followup/cancellation remains an ordinary request to Mira.
Results do not automatically become a Mira reply or downloadable attachment;
ordinary immutable attachment publication is still required. Common credential
literals are redacted defensively, without claiming to classify all private text.

`/api/runs/:id/subagents` and `/api/runs/:id/subagents/:childId` use an independent
read-only connection and verify parent-run ownership through the original tool's
durable context version. Lists are bounded/paginated; detail includes the latest
eight turns (plus any still-running earlier turn) and bounded activity. Expanded detail refreshes by child and run ID,
not parent-history cursors. Visible active cards poll independently; hidden pages
and offscreen cards stop. Parent run history no longer mixes latest child history
into its own pagination. A child observation outage does not erase parent history.

Skills still use Pi's explicit `loadSkills` with `includeDefaults:false`. Ordered
roots are source `skills/`, `${MIRA_HOME}/skills`, then the running OS user's
`os.homedir()/.agents/skills`. Source wins same-name collisions, then Mira home,
then global; Pi reports collisions and deduplicates real paths. `MIRA_CWD` does not
add project discovery. `.agent` and `.pi` are not implicitly scanned. Main and
child discover metadata at natural requests and read bodies only on demand;
workers never receive main persona or Memory. Tests inject a temporary home.

## Codex source comparison

The following official source was actually read at pinned commit
[`4906ddf5b80d4cf4e54ac1a22dc000c389835e9c`](https://github.com/openai/codex/tree/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c):

- [`SubAgentActivityItem`](https://github.com/openai/codex/blob/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/protocol/src/items.rs) carries stable item/child thread/path identity and activity kind.
- [`multi_agents_v2`](https://github.com/openai/codex/tree/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/core/src/tools/handlers/multi_agents_v2) separates spawn/list/followup/send/wait/interrupt behavior.
- [`completion.rs`](https://github.com/openai/codex/blob/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/core/src/agent/control/completion.rs) associates completion activity with the initiating parent turn and child identity.
- [`thread_status.rs`](https://github.com/openai/codex/blob/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/app-server/src/thread_status.rs) derives thread status from runtime start/end/active guards and publishes changes.
- [`thread_processor.rs`](https://github.com/openai/codex/blob/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/app-server/src/request_processors/thread_processor.rs) provides thread read/turn listing and resume; [`thread_lifecycle.rs`](https://github.com/openai/codex/blob/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/app-server/src/request_processors/thread_lifecycle.rs) attaches connection subscriptions to the selected thread with unload guards.
- [`agent_status_feed.rs`](https://github.com/openai/codex/blob/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/tui/src/app/agent_status_feed.rs) deduplicates started/completed item IDs into bounded previews; [`multi_agents.rs`](https://github.com/openai/codex/blob/4906ddf5b80d4cf4e54ac1a22dc000c389835e9c/codex-rs/tui/src/multi_agents.rs) presents activity and maps it to the child thread.

Mira reuses these mechanisms conceptually: stable child identity, real lifecycle
signals, a small parent preview and independently observed detail. It does not
copy the app-server protocol, process/thread store, control UI or Rust code.
Codex's public TUI can preview reasoning summaries and command bodies; Mira
explicitly excludes those. This comparison covers public core/app-server/TUI
source, not an assertion about unavailable desktop UI implementation. Polling is
an intentional fit for Mira's current local HTTP stack, not a claim of Codex's
push-subscription transport.

## Verification

See `docs/acceptance/subagents.md` and the joined capabilities browser suite.
Mechanism tests use synthetic provider responses; real PG, actual ordinary tools,
HTTP and Chromium verification are separate from live-model quality. A skipped,
failed or unavailable service/browser gate is never reported as passed.
