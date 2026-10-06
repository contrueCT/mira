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
