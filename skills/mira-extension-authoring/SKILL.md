---
name: mira-extension-authoring
description: Build, test, install, inspect, and maintain a Mira extension or software watcher using the public extension SDK and ordinary local files.
---

# Mira extension authoring

Use an extension when Mira needs a reusable tool, service, event source, or a
software watcher that requests cognition only for meaningful matches. First inspect
available tools and installed extensions; reuse an existing capability when it fits.
Use ordinary file and shell tools to do the work. This skill grants no additional
permission to run code, access accounts, or create external effects.

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
   ordinary Memory file edit does not itself warrant cognition or reinjection
3. Register resources in `apply`. Capture injected services there. Track async work,
   observe its errors, and cancel/join it in `onCleanup`; never detach a promise and
   assume Cordis will stop it
4. Native tests, import, and `apply` execute with the host OS identity. Cordis, cwd,
   generated directories, and content snapshots are not security sandboxes. Keep
   secrets and user data out of source trees, examples, staged files, and outputs
5. The main model decides whether the user's instruction authorizes an action or
   needs clarification. Preserve existing schema, provenance, durable intent/outcome,
   and OS boundaries; add no independent approval engine or synthetic consent
6. Inspect actual results. `accepted`, saved desired configuration, verified bytes,
   test evidence, and active runtime are distinct. A rollback is another explicit
   activation and cannot undo an external effect. Never blindly replay an unknown
   outcome

Finish with the workspace and entry, checks actually run, staged digest/test
receipt if any, requested change receipt, observed runtime/configuration state,
and remaining limitations. Do not claim installation, live-provider behavior,
cleanup, or rollback succeeded from a typecheck or an `accepted` receipt alone.
