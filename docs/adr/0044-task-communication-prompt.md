# ADR 0044: Brief execution acknowledgement and useful task updates

Status: User-approved, implemented locally, 2026-10-17. No push, CI run or merge is authorized for this change.

The main v0.2 prompt adds a single `<task_communication>` section. A user request
to execute work gets a brief acknowledgement and intended action before tools or
delegation, followed by execution in the same response. Short questions remain
direct answers. Longer work gets concrete stage results, blockers, decisions and
notice of an expected noticeable wait at natural opportunities, without empty
status repetition, per-tool narration, invented completion or hidden reasoning.
Substantial independent work still prefers delegation. New user input is answered
when it reaches the model and incorporated into the continuing task.

Ordinary main assistant text already reaches the Timeline, including text in a
complete assistant message containing tool calls. Pi awaits that message's durable
append before executing tools; `visible()` publishes its text without requiring a
terminal stop reason. Timeline HTTP reads can therefore observe that text while a
tool is still running. The Web client uses its existing polling and text rendering.
`send_reply` is an explicit quoted-message publication, not a necessary progress
channel. Child text and `report_progress` do not automatically enter the main
conversation; the main Mira must evaluate and express useful findings itself.

No transmission, UI, timer, scheduling, tool schema, worker contract or execution
boundary changes are included. Visibility is at complete-message granularity,
not token granularity. A main model cannot generate a new update inside an
in-flight single tool or between tools in one batch. It can describe an expected
wait before calling, and report new findings at its next natural request. This
prompt does not promise a timed heartbeat or immediate interruption. A stronger
requirement would need a separately scoped runtime change and is not implemented.

The previous published `a3ea5a…` bytes remain immutable in
`mira-system-v0.2-pre-communication.md`, alongside the pre-delegation revision.
All three template identities are hash checked; missing identity still means only
the pre-delegation revision. ADR 0038's natural-request upgrade, frozen Memory,
append/CAS, historical validation and compaction identity rules remain unchanged.
Compaction alone does not upgrade a template. New code is adopted after process
restart at the next natural main request; source edits do not hot-reload a process.

There is no product setting for a custom Mira template in the current source.
This change does not add one or search/replace user files. Programmatic runtimes
without `miraPrompt` retain ordinary custom system content/sections through
run/recovery/compaction. Unknown or modified identified Mira snapshots still fail
closed instead of being silently overwritten or relabelled as a default template.

The complete added wording, raw native outputs, actual delivery evidence and
verification limits are recorded in [acceptance](../acceptance/task-communication-prompt.md).
