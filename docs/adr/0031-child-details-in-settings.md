# ADR 0031: Child activity only in existing run records

Status: Accepted scope, 2026-10-14. The user explicitly requested removal of the
main-chat child cards. This supersedes only the main-chat presentation in ADR 0026.

## Decision

Normal chat contains conversation text, explicit message attachments and necessary
service notices. It has no child cards, child detail entry points or replacement
main-screen button. Removing only the card component would leave empty rows and
timestamps, so the server also stops projecting delegation-only Timeline items and
child/run metadata. No CSS-only hiding or new persistent setting is introduced.

Settings → Run records → the parent Wake retains the existing independent,
read-only child list and details: actual model/tool activity, explicitly reported
progress, bounded turn/results, identity checks, refresh and error handling.
The shared management components and observation endpoints remain available.

Backend spawn/followup/wait/cancel tools, durable associations and transcript,
child completion/Event/Wake transactions, concurrency and compaction are unchanged.
Parent replies and explicit attachment publication continue through the ordinary
Timeline path; removal of a UI projection never deletes underlying history.

## Verification

Offline tests verify omitted child metadata/rows, unchanged text/attachments and
history cursors, and no chat-only child reader calls. The real PostgreSQL recovery
case retains completion Wake and read-only detail assertions. Browser fixture and
real browser→HTTP→PG→runtime suites access child details through settings, covering
running tools, progress, completion, compaction, restart and navigation/focus.
Desktop and narrow screenshots must come from final-head runtime CI. Synthetic
provider responses are allowed; no paid model call, deployment or merge is implied.
See [subagent verification](../acceptance/subagents.md) for execution status.
