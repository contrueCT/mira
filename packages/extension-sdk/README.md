# Extension SDK

The public contract for manually installed, trusted local extensions. It imports no
Cordis, Pi, database, Node, or core types. `defineExtension` produces a structural
Cordis plugin; extension authors use only this package.

Capabilities: JSON-schema tools with text/JSON results, durable event emission,
explicit Wake requests, named services/dependencies, an in-process event bus,
cleanup callbacks, and lifecycle-owned intervals. `emitEvent` never requests a
Wake. A Wake includes a stable event and receipt ID; the host binds source identity.
In-process `publish`/`onEvent` are not durable Life History or Wake requests.

Register resources during `apply`. Resource-creating APIs reject an unloading or
retired activation; existing service reads, publication and event emission remain
available to the leased generation until its cleanup finishes. Capture injected services there so tools retain
their generation. Register every external listener/socket/resource disposer with
`onCleanup`; cleanup may be asynchronous and is awaited. Cordis cannot clean up
resources that an extension fails to register. Detached work must be canceled or
joined by the extension's cleanup. This is trusted same-process code, not a sandbox.

See `examples/extensions` for a tool, timer/service source, and dependent consumer.
Tool names start with an ASCII letter or underscore and contain 1–64 ASCII
letters, digits, underscores or hyphens (`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`), for
example `example_greet`. The host rejects invalid names;
there is no automatic renaming or alias layer.
Tools use the ordinary runtime schema/parameter checks, durable intent/outcome,
and provenance boundary. The main model decides whether to call or clarify.
The SDK exposes no database, direct context mutation, package installation,
generated-code activation, or independent authorization decision API.

Run `pnpm check` at the repository root. Offline host and runtime suites exercise
these public contracts with real pinned Cordis/Pi packages and synthetic models.


External coding workspaces use the ordinary [extension template](../../templates/extension/README.md).
`node scripts/create-extension-workspace.mts /absolute/workspace` (from the repository)
links this private SDK and existing local TypeScript/Node types; it does not fetch a
registry package or run install scripts. Node resolves the SDK's real path outside
node_modules, where TypeScript stripping is supported. Staging materializes the
local dependency tree into private sibling directories and preserves that property.

## Host configuration boundary

`ExtensionDefinition<C>.apply` retains the author's configuration type `C`. The
plugin returned by `defineExtension` accepts raw `Json` at its host-facing
`apply({ mira }, config)` entry, matching the actual configuration/host contract.
This does not parse or approve configuration: the author must validate it before
creating resources. Runtime forwarding is unchanged.

Tests can derive `Parameters<typeof extension.apply>[1]` and pass ordinary valid
or deliberately invalid JSON directly, without casts to a config-free template's
`null` type. For either synchronous or asynchronous validation failure use
`await assert.rejects(async () => { await extension.apply({ mira: context }, value); })`.
The ordinary template demonstrates the derived input type. This change does not
widen tool arguments, author callbacks, or any unrelated public interface.

## Context providers

`registerContextProvider({ id, async provide({ signal }) { return { text }; } })`
registers a read-only observation for each natural model request. Return `null` or
an empty string for no observation, and honor cancellation. IDs use the tool-name
syntax above and are unique within this extension, rather than across extensions.
The host supplies configured extension identity, activation and generated digest;
return only text, never credentials or purported authorization. This is not a tool
effect/intent transaction. Use ordinary model-selected tools for actions.

There are at most 32 registered providers. An extension contributing one must have
a configured ID of at most 128 characters. Each serialized sourced sample is
limited to 16 KiB and the complete JSON array to 64 KiB, before prompt escaping.
Oversized, empty, failed, stale or aggregate-budget-exceeded samples have explicit
statuses; no silent truncation or reuse of old success. Registration collisions
fail activation and unwind resources. Sampling does not create an Event or Wake,
load Memory again, or run during recovery/compaction. Cancellation stops preparation
while actual callback resources remain leased until it settles. See
[ADR 0019](../../docs/adr/0019-extension-context-providers.md).

## Persistent one-shot delivery

`context.schedules.create({ key, dueAt, event, wake?, expiresAt? })` saves one UTC
delivery. `get(key)` and `list()` expose durable status. `replace(version, input)`
and `cancel(key, version)` use CAS; inspect the returned delivery. `settled` with
status `enqueued` cannot be retracted. Duplicate create requires identical complete
data, including occurredAt. The host binds ownership to a persistent installation.
Calendar/recurrence/missed-reminder policy belong to extensions. See
[ADR 0022](../../docs/adr/0022-durable-single-shot-delivery.md).

## Private settings

`context.credentials.get/has/set/delete` reads/writes private installation-scoped strings.
Never put credentials in config, tools, events, context providers or logs. `has` means
stored, not authenticated. `context.privateDirectory` is a private installation data
folder for extension-owned ordinary files; it is null without persistent identity.
`context.registerSettings({ fields, actions, status })` declares the protected settings
screen. Field types are text, boolean, select, secret. Actions receive AbortSignal;
status returns a fixed connection state, optional safe code, bounded public details,
and an optional HTTPS authorization link with `qr: true` for local rendering.
See [ADR 0035](../../docs/adr/0035-extension-private-settings.md). These APIs organize
trusted code under the same OS account; they provide no security sandbox.

`registerSettings` 返回当前安装/激活专属的 `ExtensionSettingsActions`。
插件可以在自己的普通工具中选择调用 start/current/cancel；只返回安全 operation
receipt，不返回受保护的 settings view 或 provider URL，详见 ADR0035。
### Immutable sourced messages

`emitEvent` / `requestWake` events may include `message: { direction: 'inbound' | 'outbound', text, sourceLabel, senderId?, senderVerified? }`. The same immutable event identity/content deduplication applies. The host keeps the configured extension ID; the Web Timeline renders text with a small source label and direction. The sender and verification are assertions by that trusted extension, never host authentication, a Web-user identity, or permission to execute an action. Projection does not wake by itself. Publish outbound only after confirmed delivery; uncertain delivery must not be displayed as sent. Raw event data remains outside this display DTO. Ordinary model finals are unchanged, so an extension/tool should advise the model not to repeat already-sent text; this is not a hard mirror/deduplication guarantee.
