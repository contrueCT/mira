---
name: mira-extension-authoring
description: Build, test, install, inspect, and maintain a Mira extension, MCP server connection, or software watcher using the public extension SDK and ordinary local files.
---

# Mira extension authoring

Use an extension when Mira needs a reusable tool, service, event source, or a
software watcher that requests cognition only for meaningful matches. First inspect
available tools and installed extensions; reuse an existing capability when it fits.
Use ordinary file and shell tools to do the work. This skill grants no additional
permission to run code, access accounts, or create external effects.

## Design or review

Read the applicable references below and inspect the proposed or existing extension
against current APIs. Report design choices or findings instead of following the
installation workflow. Do not write files, install extensions, or change runtime
configuration unless the user requests implementation.

## Reuse the shipped MCP connection

For MCP, read the [ordinary MCP plugin](../../packages/mcp-plugin/README.md)
before creating a new extension. Prepare that existing package, then use the same
stage/content-test/install/activate workflow below. Each server gets its own
ordinary installation; configure, refresh, disable, update and rollback reuse
existing tools/settings. Install local server software at a pinned version first.
Credentials and OAuth links belong only in protected connection settings, never
source, config, arguments or model-facing operation receipts. Follow the README’s
same-computer callback or explicitly configured existing HTTPS route requirements.

## Deliver a working extension first

1. Resolve the requested result and whether an existing tool or extension already
   provides it. Start with a small working version; do not add speculative features
2. Discover only the APIs needed for that version: use `extension_inspect` for
   installed state, then read the SDK contract and relevant references below.
   Read lifecycle guidance before choosing asynchronous work or services
3. Create an ordinary workspace with the existing template. Write the extension,
   validate its configuration and computed results (see the SDK reference for Json
   narrowing, finite output checks, and sync/async test patterns), typecheck and
   test offline. Stage the complete workspace, then test the exact staged digest
   using the documented artifact CLI
4. When the user's request authorizes execution, install the staged release as
   disabled, read the actual management result, then activate it. Management waits
   for application and returns `status`, `persistence`, and a `runtime` snapshot.
   Check those fields before continuing; saved configuration does not prove an
   active runtime. Continue the requested workflow within the same user request,
   with ordinary progress messages when useful, without waiting for another user
   message or Wake. Inspect when discovery, failure diagnosis or fresh state needs
   it; do not repeat inspections when the returned result already establishes the
   requested state
5. Exercise the actual capability with safe authorized inputs, fix observed defects
   in the same extension, and report its location and verification limits. A fake
   provider test is not proof of real account access or external effects

## Choose the relevant reference

- Read [SDK contracts](references/sdk.md) when writing a tool, event source,
  service, listener, timer, or cleanup callback
- Read [lifecycle](references/lifecycle.md) when adding asynchronous work,
  dependencies, reload/update handling, or diagnosing a stopped extension
- Follow [workspace and release workflow](references/workflow.md) for generation,
  native TypeScript checks, staging, content-bound tests, and installation or changes
- Adapt [watch-and-wake.ts](examples/watch-and-wake.ts) for non-overlapping polling,
  software filtering, stable IDs, cancellation, and observed failures. It needs a
  source service; it does not contact an account or install itself
- Adapt [finite-sum.ts](examples/finite-sum.ts) for input narrowing, computed-output
  validation, and known failures that return `isError: true` with `details.ok: false`

The authoritative contract is [extension-sdk/src/index.ts](../../packages/extension-sdk/src/index.ts).
Check it and the [host README](../../packages/extension-host/README.md) before
assuming an API exists. Reuse the [ordinary workspace template](../../templates/extension/README.md)
and [existing examples](../../examples/extensions/README.md); do not copy the SDK,
create another scaffolding wrapper, or invent runtime APIs. Links here are relative
to this skill in the current Mira checkout. Resolve the actual skill location and
checkout before running commands; do not guess a machine-specific path.

## Preserve Mira's boundaries

1. Extensions import Mira APIs only from `@mira/extension-sdk`. Default work adds an
   independent extension outside the source checkout, not edits to Life Core,
   authorization, history, context, or runtime security
2. `emitEvent` records a fact; `requestWake` explicitly requests continuation of the
   existing Mira. `publish`/`onEvent` only communicate in-process. A timer tick or
   ordinary Memory file edit does not itself warrant cognition or reinjection.
   Retrying one ID requires the same full event and optional Wake, including the
   original `occurredAt`, payload, Wake ID, and reason. A changed source fact needs
   a new ID; changing its timestamp to the retry time is not deduplication.
   Generated unit tests use `createFakeHost()` from `@mira/extension-sdk/testing`
   for that receipt behavior. A hand-written stub that returns `duplicate` does not
   exercise it
3. Register resources in `apply`. Capture injected services there. Track async work,
   observe its errors, and cancel/join it in `onCleanup`; never detach a promise and
   assume Cordis will stop it
4. Native tests, import, and `apply` execute with the host OS identity. Cordis, cwd,
   generated directories, and content snapshots are not security sandboxes. Keep
   secrets and user data out of source trees, examples, staged files, and outputs
5. The main model decides whether the user's instruction authorizes an action or
   needs clarification. Preserve existing schema, provenance, durable intent/outcome,
   and OS boundaries; add no independent approval engine or synthetic consent
6. Inspect actual results. Saved desired configuration, verified bytes,
   test evidence, and active runtime are distinct. A rollback is another explicit
   activation and cannot undo an external effect. Never blindly replay an unknown
   outcome

Finish with the workspace and entry, checks actually run, staged digest/test
receipt if any, requested change receipt, observed runtime/configuration state,
and remaining limitations. Do not claim installation, live-provider behavior,
cleanup, or rollback succeeded from a typecheck or saved configuration alone.


## Upstream source

The design/review branch, working-extension-first workflow, API discovery order,
and verification guidance are adapted from DeepSeek's official shipped
[cordis-plugin-development skill](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/preset/agent-preset/skills/cordis-plugin-development/SKILL.md)
and its verification reference, pinned at commit
`5badb15009ae1756c3afe0ae0cef1faafc290ccc`. Copyright (c) 2026 DeepSeek;
[MIT license](LICENSE.deepseek).

Mira's SDK, content-bound staging, disabled installation, lifecycle and test
commands replace DSH's profile bundles and direct Cordis APIs. Like DSH live-profile
management, Mira waits for lifecycle application and returns an actual result.
Mira retains its own disabled-install, persistence and activation fields; both
workflows use those actual results before exercising and reporting the capability. DSH's UI slots,
presets, MCP bundles, executable YAML and separate approval mechanisms are not
Mira features. The linked Mira-specific references describe the current code.
