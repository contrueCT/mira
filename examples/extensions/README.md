# Manual trusted examples

These are ordinary local extension modules using only `@mira/extension-sdk`.
They do not use real models or network services. Configure absolute paths in a
private JSON file outside the repository, for example:

```json
{
  "hmr": true,
  "entries": [
    { "id": "greeting", "path": "/absolute/mira/examples/extensions/greeting.ts", "enabled": false },
    { "id": "clock", "path": "/absolute/mira/examples/extensions/clock-source.ts" },
    { "id": "clock-consumer", "path": "/absolute/mira/examples/extensions/clock-consumer.ts" },
    { "id": "reminders", "path": "/absolute/mira/examples/extensions/reminders.ts", "enabled": false }
  ]
}
```

`MIRA_DEMO_EXTENSIONS=/absolute/extensions.json node --expose-internals apps/server/src/cli.mts <input-id> <message>`
uses this configuration alongside the existing explicit demo database/spool variables.
The demo provider is synthetic and does not decide to invoke tools on its own;
recovery tests inject a deterministic model that enables and calls the new tool in
one Wake. A live product provider is still out of scope. Main-model conversation/
prompt judgment chooses calls or clarification; there is no injected authorization
gate or synthetic approval evidence.

No npm installation or package discovery occurs at runtime. `extension_manage`
can only address configured IDs. Enable/disable/configure changes are saved back to
this JSON before activation; inspect receipts for separate save/apply failures. Cordis tracks the clock dependency: removing the
source suspends the consumer and its listener/tool, then restoring it re-applies the
consumer. Timers/listeners are cleaned on disable, replacement, and host shutdown.

## Durable single-shot reminders

`reminders.ts` is an opt-in example using only the Extension SDK's host-scoped
`schedules` capability. Merely importing or enabling it registers four ordinary
tools; it does not create reminders. No example is installed automatically. Use a
stable configured extension ID across reloads and restarts so it retains the same
schedule owner. It registers no in-process timer, provider or event listener.

- `reminder_create` requires a stable `key`, reminder `text`, `localDate`
  (`YYYY-MM-DD`), `localTime` (`HH:mm` or `HH:mm:ss`) and an explicit `timeZone`.
- `reminder_list` returns the stored reminders and their current versions, including
  `pending`, `enqueued`, `cancelled` and `expired` records.
- `reminder_update` supplies the complete desired reminder plus `expectedVersion`
  from the list. Keep unchanged fields, including any expiry policy. Omitting
  `expiresAfterMinutes` removes that policy. A conflicting version does not write.
- `reminder_cancel` supplies `key` and `expectedVersion`. An already enqueued
  reminder cannot be retracted from the Wake queue; the result says so explicitly.

The main model interprets the user's natural-language request in the existing
conversation and asks for missing/ambiguous date, time or zone information. This
extension never calls another model, infers the host's local zone, parses relative
phrases, implements cron, or creates a notification UI. Dates are checked without
JavaScript's permissive date-string parser. `timeZone` accepts `UTC` or a valid IANA
region/city name (including names such as `Etc/UTC`); abbreviations such as `PST`
and numeric offsets are rejected. Conversion uses the host's `Intl` IANA time-zone
data and records the requested wall time and zone alongside the resolved UTC
instant. Existing records retain that UTC instant if time-zone rules later change.

A nonexistent DST time returns `needs_clarification` without a write. A repeated
local time also returns `needs_clarification`, with its UTC candidates. Ask the
user which instant they intended, then submit that instant's date/time using
`timeZone: "UTC"`. Half-hour transitions and date-line jumps are covered in tests.
New reminders and replacement pending reminders require a future due time.
Reconciliation of an existing key still works after its due time; it must not
create a second reminder simply because the first result was uncertain.

For example, after an explicit user request, tool arguments could be:

```json
{
  "key": "example-tea-2027-04-15",
  "text": "Make tea",
  "localDate": "2027-04-15",
  "localTime": "14:30",
  "timeZone": "Asia/Shanghai"
}
```

The scheduler receives `dueAt: "2027-04-15T06:30:00.000Z"`, an Event of type
`reminder.due`, and a Wake request. Event time is the intended due time; event and
Wake IDs are stable, derived from the reminder key. Reminder text is payload data,
not new instructions or user authorization. Delivery enters Mira's ordinary Wake
queue and continues the existing conversation. `enqueued` does not prove that the
model has run or that the user has received a notification.

By default there is no expiry: a pending reminder can be caught up after downtime.
Only when requested, `expiresAfterMinutes` (an integer from 1 to 525600) adds an
explicit UTC `expiresAt` relative to `dueAt`. The scheduler expires a reminder that
has missed that window rather than enqueueing it. There is no invented lateness
threshold. Disabling an extension does not cancel or delete its schedules; use the
cancel tool for that. Re-enabling can catch up still-pending reminders.

Keys are stable caller-chosen ASCII identifiers of 1–128 characters, starting with
a letter or digit, with dots, underscores, colons and hyphens allowed. Reuse the
original key to check an uncertain create; an identical create is deduplicated and
a changed create conflicts. Do not generate another key merely to retry. Scheduler
or storage failures propagate, so the runtime can record the ordinary uncertain
tool outcome instead of this extension falsely reporting success or failure.

`tests/unit/reminders.test.mts` uses a synthetic scheduling SDK, a fixed clock and
no real reminders, database or model. It covers conversions, DST clarification,
stable IDs, late reconciliation, optional expiry, replacement/cancel versions,
terminal states, invalid arguments and cancellation. Core persistence/restart
coverage is separate from this example's tests.
