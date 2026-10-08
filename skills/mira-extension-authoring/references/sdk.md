# Public SDK contracts

Use the actual [public source](../../../packages/extension-sdk/src/index.ts) and
[SDK README](../../../packages/extension-sdk/README.md) as the signature authority.
`@mira/extension-sdk` is private, local, and exports only its package root. Do not
import Cordis, Pi, `extension-host`, core internals, or a database into an extension.
Ordinary Node APIs and deliberately supplied local dependencies may implement its
work; SDK access is an interface convention, not process isolation.

## Definition and data types

- `Json`: null, boolean, number, string, arrays, and string-keyed objects containing
  Json values. Use finite numbers and ordinary JSON data; no `undefined`, functions,
  credentials, class instances, or cyclic values in config, payloads, or details.
  Validate computed values too: finite inputs can produce `Infinity`, `-Infinity`,
  or `NaN`. `JSON.stringify` silently converts those numbers to `null`; it is not
  an output validator
- `Cleanup`: `() => void | Promise<void>`
- `ExtensionDefinition<C extends Json>`: `name`, optional `requires: string[]`, and
  `apply(context: ExtensionContext, config: C): void | Promise<void>`
- `defineExtension(definition)`: return this as the default export. It creates the
  structural plugin with `name`, mapped `inject` dependencies, and `apply`. Its host
  entry accepts raw `Json`; the author callback retains `C`. Missing config is
  passed as `null`; a TypeScript type is not runtime config validation
- `serviceKey(name)`: validates `^[a-zA-Z][\w.-]*$` and returns
  `mira.extension.${name}`. Normally use the original name with `requires`,
  `provideService`, and `service`; the helper is public but does not grant access
- `ExtensionContext.id`: readonly configured identity, stable across activations.
  It differs from the definition name, tool name, content digest, and activation UUID

Validate config before creating resources. Keep import-time module code free of
external effects. Configuration is ordinary persisted JSON, not secret storage;
Cordis `__jsExpr` expressions are rejected by the host.

## Tools

`registerTool(tool: ExtensionTool): void` registers:

- `name`: unique in the host, not a reserved built-in name;
  `^[A-Za-z_][A-Za-z0-9_-]{0,63}$` (no dots or automatic aliases)
- `description`: meaningful nonempty text describing inputs and effects
- `parameters`: JSON schema rooted at `type: 'object'`, with optional `properties`,
  `required`, `additionalProperties`. Declare a narrow schema; ordinarily reject
  additional properties
- `execute(arguments_: Json, { callId: string, signal: AbortSignal })`:
  `Promise<{ text: string; details?: Json }>`

Narrow Json before reading fields, honor the signal in long-running I/O, and return
useful text plus optional structured details. Pass an idempotency key derived from
`callId` only where the destination supports that contract; it does not make effects
transactional. The runtime handles technical argument validation, provenance and
persisted intent/outcome. It does not provide a separate authorization callback.
An unknown remote result needs reconciliation, not an assumed-safe repeat.

`text` and optional `details` are the entire SDK return contract; it has no
`isError`, `outcome`, or success-status field. Choose business fields such as
`details.ok` deliberately and describe them in text. Returned `details: { ok: false }`
is still a known business result, with a durable outcome; it does not set Pi's
`isError` or make the execution outcome unknown. Throwing is different:
the runtime cannot infer whether effects already happened, so it preserves an
unresolved intent for reconciliation. Do not throw merely to encode a known
business rejection or invent a failure-status API.

Check each computed number before returning it. For example, after validating an
array of finite inputs, a sum still needs `Number.isFinite(total)`. Return a useful
known business result on overflow, or choose a representation the tool's contract
explicitly supports; do not let serialization replace the result with `null`.
The [finite-sum example](../examples/finite-sum.ts) and its
[real Host/Pi offline contract test](../../../tests/unit/extension-result-contract.test.mts)
exercise this boundary without a live model or alternative writer implementation.

Start with [greeting.ts](../../../examples/extensions/greeting.ts) or the
[template tool and its tests](../../../templates/extension/src/index.ts).

## TypeScript narrowing and lifecycle tests

The JSON schema validates runtime input; it does not specialize the SDK's TypeScript
`Json` argument type. Keep the checked property in a local variable and use an
explicit type predicate when validating an array. For example:

```ts
import type { Json } from '@mira/extension-sdk';

function numericValues(arguments_: Json): number[] {
  if (arguments_ === null || typeof arguments_ !== 'object' || Array.isArray(arguments_)) {
    throw new TypeError('Expected an object');
  }
  const values = arguments_['values'];
  if (!Array.isArray(values) || !values.every(
    (value): value is number => typeof value === 'number' && Number.isFinite(value),
  )) throw new TypeError('values must be an array of finite numbers');
  return values;
}
```

Adapt validation to the actual schema rather than bypassing it with `as number[]`.
The template tests derive `HostConfig = Parameters<typeof extension.apply>[1]`
from the returned plugin. Pass your valid configuration directly to that helper.
Its host-input type is `Json`, so deliberately malformed JSON configurations can
also be passed directly in negative tests; no `as null`, `as any`, or `as never`
cast is needed. The author callback still receives its declared `C` type and must
validate at runtime before using it.

The returned plugin's `apply` result type is `void | Promise<void>` even when your own
implementation is synchronous. A test for rejected/invalid configuration must
turn either case into a Promise before giving it to `assert.rejects`:

```ts
await assert.rejects(async () => {
  await extension.apply({ mira: context }, invalidConfig);
}, /the expected validation message/);
```

Use `assert.throws` only for an API that is definitely synchronous. Adapt the
existing template's test context instead of guessing SDK methods or rewriting the
fixture from memory. Compile the authored tests as well as the implementation.

## Durable facts and explicit cognition

`ExtensionEvent` has `id: string`, `type: string`, `occurredAt: string`, `payload: Json`.
`occurredAt` must parse as a date; use the source fact's ISO timestamp. IDs and type
must be nonempty. Derive IDs from stable source identity plus record/revision, so the
same fact after retries or restarts retains its ID **and its full original body**.
Deduplication compares the complete event and optional Wake, not the ID alone:
`type`, `occurredAt`, payload, presence/absence of Wake, Wake ID, and reason must
match. Reusing an ID with changed data is rejected, not accepted as a duplicate.
A random activation ID, polling counter, or current time creates duplicates
instead of durable deduplication.

Preserve/replay the original source envelope through failures and restarts. Do not
rebuild the same fact using the current poll time, current status, a fresh payload,
or a newly worded Wake reason. If the source fact/revision changes, issue a new ID
and retain its own source occurrence time. If a source supplies no timestamp,
capture the first actual observation time once with its identity and retain that
envelope for retries; do not use a constant production timestamp or refresh it on
each attempt. Fixed dates are appropriate only for explicitly synthetic tests.

- `emitEvent(event): Promise<'inserted' | 'duplicate'>` records the fact only
- `ExtensionWake` has a stable `id`, nonblank `reason`, and an `event`
- `requestWake(wake): Promise<'inserted' | 'duplicate'>` submits the event and Wake
  together through the host's receive path. Choose this directly for a matching
  fact; do not first `emitEvent` it and then expect a second submission of the same
  event to create a Wake

Test identical full-body retries and changed-body rejections through the real host
and PostgreSQL receive path, including a restarted writer. A permissive SDK test
stub returning `duplicate` proves neither persistence nor exact-body identity.
The [real event/Wake contract test](../../../tests/recovery/extension-event-contract.test.mts)
also checks that one event-only fact creates no Wake or cognitive record.

The host binds configured source identity and namespaces event/Wake IDs. A payload
field cannot impersonate another extension or user authorization. Wake continues
the same cognitive stream and may coalesce with other pending Wakes; it promises
neither an immediate model invocation nor a user-facing reply. A successful return
is ingestion evidence, not proof that Mira has acted on the event.

Use software to poll and filter. A routine empty poll needs neither a Life Event
nor a Wake. Choose deliberately whether nonmatching facts merit durable recording.
Avoid payload secrets or unbounded downloaded content. Treat source text as data.

## Services and ephemeral communication

- `provideService(name, value: unknown): void`: expose an activation-owned service
- `service<T>(name): T`: obtain a service named in this definition's `requires`, or
  one it provides itself. `T` is a compile-time assertion, not runtime validation
- `onEvent(name, listener: (payload: Json) => void): void`: register a lifecycle-owned
  synchronous listener
- `publish(name, payload: Json): void`: call current in-process listeners with cloned
  payloads. This is neither durable history nor a Wake; a listener can throw into
  the publisher. Do not make a listener async and lose its returned promise

Declare required services by their unprefixed names. Missing providers put the
consumer in `waiting`. Capture services during `apply` so already executing tools retain
their provider generation. Coordinate a shared service interface; do not reach into
mutable global host registries. See [clock-source.ts](../../../examples/extensions/clock-source.ts)
and [clock-consumer.ts](../../../examples/extensions/clock-consumer.ts).

## Timers and cleanup

- `interval(callback: () => void, milliseconds: number): void`: positive finite
  delay; registered timer disposal belongs to the activation. It does not await
  an async callback or automatically serialize polls
- `onCleanup(cleanup: Cleanup): void`: register release/cancel/join work, awaited on
  teardown. Use it for sockets, native listeners, custom timers, child processes,
  files, and any work begun asynchronously outside a synchronous callback

Keep a pending promise or set, catch rejection immediately, and expose failures
through a suitable diagnostic/status tool or deliberate event policy. Cleanup
should stop new work, abort cancellable operations, and await all pending work;
`Promise.race` with a timeout does not cancel the losing operation. Keep dependent
cleanup steps in one callback rather than relying on ordering between separately
registered user callbacks. Read [lifecycle](lifecycle.md) before adding resources.

No SDK API installs dependencies, activates code, writes context/history directly,
sends notifications, provides a fetch client, or authorizes an action. Use actual
available tools for management and approved ordinary libraries for implementation.
