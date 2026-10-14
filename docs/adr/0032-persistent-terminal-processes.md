# ADR 0032: Lightweight terminal processes across turns

Status: Approved scope; implemented in this change. Processes survive conversation
turns, not service restart. No new conversation domain, daemon platform or UI.

## Decision

The existing synchronous Pi `bash` remains unchanged. The server adds four
ordinary durable runtime tools: `exec_command`, `write_stdin`, `terminal_close`,
`terminal_list`.
Every exec starts a new shell command. The shell defaults to `/bin/bash -c` and
cwd defaults to the configured tool directory; neither is a sandbox. `tty: true`
explicitly allocates a real PTY through Microsoft node-pty 1.1.0. To retain cwd,
environment and an interactive shell, explicitly start
`exec /bin/bash --noprofile --norc -i` in a PTY and send subsequent shell lines.
Nothing silently turns unrelated exec calls into one shared shell.

A service-owned manager is shared across main Wake runtimes and child followups.
Each tool closure binds its exact owner stream. Main and sibling streams cannot
read/write/close another stream's handle. This is handle isolation, not an OS
security sandbox; ordinary filesystem tools still share the host filesystem.
There are no terminal cards/buttons and no automatic result Wake or polling agent.

## Protocol and budgets

Exec returns `session_id`, `status`, `output`, byte `offset`/`next_offset`,
`has_more`, `exit_code`, `signal` and an immutable ordinary-file `log_index`.
Read/write copies `next_offset`; 0 explicitly rereads without re-execution. UTF-8
boundaries are preserved. Results are incremental snapshots, not a claim that a
running command has completed. A running snapshot can have no more bytes yet.
The referenced JSON index lists ordered UTF-8 chunk paths and byte ranges through
its exact snapshot byte count. Ordinary `read` can inspect/reconstruct these files.
Later output needs a later poll and index. Ended handles retain unread output.

Calls are serialized per handle; separate handles run independently. Input is
acknowledged by the supervisor before a result can claim it was accepted; this is
not proof the program consumed it or acted on it. Each call is at most 32 KiB
UTF-8; each session has a 1 MiB cumulative stdin budget, bounding even node-pty’s
internal unobservable write queue. Remaining input bytes are reported. A request
not acknowledged in one second, or whose wait is cancelled, becomes an unknown
ordinary tool effect. Wait defaults to 1 second, accepts 0..10 seconds, and returns
early when output arrives. Model output is at most 8 KiB per page, in addition to
the common runtime result projection. At most 16 live/closing processes and 128
retained handles exist; only ended handles can be evicted. Old logs remain files.
Each session retains at most 64 MiB of output. Crossing the limit stops it and
explicitly reports that excess output was not retained. Pipe reads are paused until ordinary immutable spool chunks are persisted. PTY
reads keep draining to avoid node-pty’s 200 ms post-exit socket teardown losing
output under slow storage. At most 1 MiB of unpersisted output is accepted; a PTY
exceeding this pending-output budget is stopped with explicit incomplete-output
notice. No silent head/tail discard.

## Lifecycle and durability

Intent is durably recorded before each tool effect and the exact observed outcome
is stored by the existing Pi runtime. No terminal database, persisted SDK session,
command replay or file-backed cognition state is introduced. Commands and inputs
remain ordinary effects: an absent outcome is unknown, not a retry instruction.
Normal turn completion preserves the process. Cancelling an already-running wait
returns a cancellation observation and leaves the process alive; cancellation
before input dispatch does not send input. `interrupt: true` sends Ctrl-C to a PTY
foreground job or SIGINT to a pipe group, potentially leaving the shell alive.
`terminal_close` explicitly terminates the managed group and observed descendants;
this cannot undo effects. Service shutdown terminates its managed sessions.

A small per-session child supervisor owns the native process and listens for IPC
disconnect. If its service owner dies, it terminates its managed group and observed
descendants instead of intentionally remaining a daemon. The common Mac/Linux guarantee is the managed process group plus descendants
still observable at close, matching Codex’s bounded process-group approach. A
process that changes group and is reparented, including an ordinary interactive
background job after its shell exits, may survive. Every result and the close
tool explicitly state this limitation. Close jobs while their shell is alive.
There is no claim of arbitrary complete process-tree cleanup, no session-ID
platform fork, and no additional native cleanup helper. This is not a sandbox.
No processes are reattached after restart. Old IDs return `unavailable`, explaining
that old work is interrupted or unknown and saved outcomes/logs must be inspected.
`terminal_list` returns owner-bound live/retained IDs correlated with the original
durable launch call ID, so a cancelled launch with no durable result is still
discoverable on a child followup. It does not replay anything or reveal siblings.
Historical running results stay truthful observations of their original call,
never rewritten as completed. Host/storage errors are not fabricated successes.

Live user input retains ADR 0024: settle the current bounded terminal call, consume
new input, and leave old siblings not-started. Terminals do not intercept steering
or add a second cognition writer. Child cancellation does not claim to undo prior
process effects; subsequent explicit followup can inspect its own handles while
the service remains alive.

## Dependency and validation

`pnpm install --frozen-lockfile --ignore-scripts` remains policy. The explicit
`pnpm terminal:prepare` builds only pinned node-pty on Linux or fixes the upstream
packaged Mac spawn-helper mode. See [toolchain](../development/toolchain.md).
No platform upgrades, persistent access, external credentials or paid calls.

Tests spawn real pipes/PTYs: incremental UTF-8, shell cwd/env, independent commands,
serialization, owner isolation, interruption, managed-group/observable-tree cleanup,
reported background-job cleanup limits, cancelled waits and discoverable unknown launches,
owner SIGKILL/IPC disconnect and restart without replay. Real PostgreSQL service
tests exercise cross-Wake input/outcomes and preserved live-input ordering. CI runs
those plus the existing browser/PG joined chains; no frontend source changed.
Fake provider responses verify mechanics, never live-model behavior.
