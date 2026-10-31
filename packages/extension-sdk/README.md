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
Inside a tool call made by a delegated task worker, `create`, `replace` and
`cancel` reject; `get`/`list` still work ([ADR 0052](../../docs/adr/0052-subagent-reports-capabilities-close.md)).

## Main-only tools

Mira can hand an extension's tools to a delegated task worker. Set
`mainOnly: true` on a tool (for example one that messages the user) to keep it
with Mira only; workers never receive it. Tool names use only
`[a-zA-Z0-9_-]`.

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


设置动作可声明 `group: 'primary' | 'secondary'`（省略为 primary）。状态投影可提供
`visibleActions: string[]`，仅包含已声明且当前可用的动作 ID；省略显示全部，空数组
隐藏全部。数组顺序不改变声明顺序，重复或未声明 ID 视为无效状态并隐藏动作。
插件自行决定业务状态对应哪些动作，Host/Web 不解释 provider 状态。可见集合纳入
revision，页面与插件 handle 共用的 runner 拒绝过期 revision 或当前隐藏的动作。
已有 operation 的查询/取消不受可见性影响。Web 将 secondary 与设置编辑收在默认
折叠的“更多操作”中，primary、当前操作取消和编辑取消保持可见。

### Dynamic toolsets and known failures

`registerToolset(initialTools)` returns an activation-owned handle with
`replace(candidateTools)`. The complete candidate is validated and cloned before
one synchronous publication. Names must be unique against other sets, static
tools and reserved names. The returned revision changes on every publication;
old not-yet-started declarations return known stale/not-executed, while begun
calls keep their implementation and execution lease. Retired/closing/owner-lost
activations cannot replace a toolset. Replacement does not request a Wake.

Tool results may set `isError: true` for a known failed outcome. Throwing still
means the external result is unknown; it must not be used for a known business
failure. Complete schema JSON is preserved for the ordinary runtime validator.
Toolset publication preflights schemas with JSON Schema draft 2020-12 by default;
explicit draft-07 and 2019-09 are also supported. Candidates must compile with
the pinned runtime TypeBox compiler as well. Invalid keywords/regular expressions,
unresolved references and unsupported dialects reject the whole candidate without
replacing the current set. No remote schema is fetched; unknown formats remain
annotations. Validation does not coerce arguments or log schema contents.

## Testing doubles

Unit tests import `createFakeHost` from `@mira/extension-sdk/testing`. Use it for
Event and Wake receipts. The same full body and Wake choice returns `duplicate`;
a changed field, or adding, removing, or retargeting the Wake, rejects with the
messages the host surfaces. A stub that always returns `duplicate` does not
exercise that contract.

The fake mirrors the host's observable receipt rules and is checked against the
same case table as the real Host/PostgreSQL path
(`tests/shared/extension-event-contract-cases.mts`). Those real Host/PostgreSQL
tests remain the authority for persistence, restart, and History identity. The
fake does not reproduce the private `event-content-conflict` brand, a shared
writer across extensions, or host lifecycle, timers, schedules, credentials,
settings, or JSON Schema compilation. `isEventContentConflict` checks the
observable name, code, and message.
