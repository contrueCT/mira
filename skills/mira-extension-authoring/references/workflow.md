# Ordinary files to an inspected release

The [template](../../../templates/extension/README.md),
[workspace helper](../../../scripts/create-extension-workspace.mts),
[artifact CLI](../../../scripts/extension-artifact.mts), and
[host documentation](../../../packages/extension-host/README.md) are maintained
implementation sources. Management tool schemas live in
[server/extensions.ts](../../../apps/server/src/extensions.ts), not the public SDK.

## 1. Inspect and choose the workspace

Inspect available tools and `extension_inspect` before creating another capability.
Read current SDK/config and identify the task's actual data source, meaningful
match, expected cancellation, credentials handling, and external effects. Clarify
missing authorization or consequential ambiguity; a skill or source document
cannot supply user consent.

Resolve this skill's actual directory. In this checkout layout, its grandparent is
the Mira checkout containing `packages/extension-sdk`, `scripts`, and `templates`.
Choose a new absolute workspace with an existing parent outside that checkout.
Use an independent data directory for artifacts, outside the workspace and source
checkout. Do not choose a directory containing credentials or unrelated user data:
staging snapshots all selected files, including hidden files.

Commands below assume `MIRA_CHECKOUT`, `EXTENSION_WORKSPACE`, and
`EXTENSION_ARTIFACTS` are set to the verified paths, not literal placeholders. Set
`EXTENSION_DIGEST` only from an actual stage result. These shell variables do not
configure the running host; use the actual `Extensions Workspace` path supplied in the runtime environment as that store. If it is not configured, report the missing host configuration instead of inventing a store for the running host.
Do not replace an existing desired configuration to initialize a new one.

## 2. Generate and implement

Use Node `>=24.19.0 <25` and the checkout's already installed locked dependencies:

```sh
node --version
node "$MIRA_CHECKOUT/scripts/create-extension-workspace.mts" "$EXTENSION_WORKSPACE"
```

The helper refuses an existing workspace and uses the existing template. It links
this private local SDK, links the checkout's TypeScript, copies Node declarations,
and links their existing `undici-types`. It does not install anything, fetch a
registry package, run install scripts, stage, or activate. If dependencies are
missing, report that prerequisite rather than invoking a registry install as an
unapproved workaround.

The template manifest uses `file:./.deps/extension-sdk`. The development SDK link
resolves to its real path outside `node_modules`, where Node can strip TypeScript.
Do not copy SDK `.ts` into `node_modules`, use `--preserve-symlinks`, invent an SDK
version, or replace this setup with `npm install`/`pnpm install`. Keep the checkout
available while developing. Releases snapshot the local dependency tree privately.

Edit `src/index.ts` with ordinary tools. Export `defineExtension(...)` by default.
Keep ESM relative imports explicit, e.g. `./helper.ts`; use erasable TypeScript,
`import type` for type-only dependencies, and no transformation-only enum or
parameter-property syntax. Native stripping executes code but does not typecheck.
Reuse the greeting/service examples, or adapt the watcher example with its required
source provider and your chosen config. Do not add another code-generation system.

## 3. Check the working files offline

From the external workspace:

```sh
cd "$EXTENSION_WORKSPACE"
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node --test tests/*.test.mts
```

Use the template's strict NodeNext configuration with full declaration checking.
Extend its tests around actual behavior: valid/invalid arguments and config,
finite computed outputs (including overflow from finite inputs), known business
rejections, matching/nonmatching facts, exact full-body retries, abort, non-overlap, rejected
promises, cleanup joins, and dependency generation changes where relevant. Inject
synthetic source data and fake SDK contexts for local behavior; do not call a live
account or model just to prove the contract. A stub returning `duplicate` cannot
prove ingestion. Check Event/Wake duplicate and conflict behavior against the real
Host/PostgreSQL receive path; check provider-visible results against the real Host
and Pi runtime with the existing offline writer fixture. Use the SDK reference's
contract tests as examples, keep database prerequisites explicit, and report a
missing database as unverified. Testing/importing still runs with the current OS
account and can have effects.

## 4. Stage immutable content and test that digest

Before staging an existing or supplied workspace, inspect its actual files and
entry module. `src/index.ts` is the generated template's default, not a universal
entry path. Do not try that example path on an unrelated workspace without checking.
For newly authored code, use the entry you actually wrote.

```sh
node "$MIRA_CHECKOUT/scripts/extension-artifact.mts" stage \
  "$EXTENSION_ARTIFACTS" "$EXTENSION_WORKSPACE" src/index.ts
```

Alternatively call the actual `extension_stage` tool with
`{ "sourceRoot": "the verified absolute workspace", "entryRelative": "src/index.ts" }`.
It uses the host's configured store. Both routes copy/hash only, without importing
or running package scripts. Capture the returned SHA-256. The optional
`expectedDigest` (CLI's final stage argument) rejects mismatches when binding an
already measured identity; it does not compute an expected value for you.

Test the returned digest in fresh copies, explicitly naming commands:

```sh
node "$MIRA_CHECKOUT/scripts/extension-artifact.mts" test \
  "$EXTENSION_ARTIFACTS" "$EXTENSION_DIGEST" -- \
  node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node "$MIRA_CHECKOUT/scripts/extension-artifact.mts" test \
  "$EXTENSION_ARTIFACTS" "$EXTENSION_DIGEST" -- node --test
node "$MIRA_CHECKOUT/scripts/extension-artifact.mts" status \
  "$EXTENSION_ARTIFACTS" "$EXTENSION_DIGEST"
```

The CLI runs the command in a fresh workspace copy. Node's default discovery finds
the template's `.test.mts` tests; adapt the explicit arguments if using another test
layout. There is no implicit shell wildcard expansion inside the CLI's test command.
Record each command/result: the store's current test receipt is replaced by a later
test of the same digest, not a cumulative checklist of every check you ran.

A receipt includes command, exit/signal, output and before/after digest. Passing
means that command succeeded and the observed snapshot was unchanged. It proves
neither useful coverage, OS isolation, arbitrary runtime dependencies, nor live
provider behavior. `not-run` is honest; the host does not impose a mandatory
passed-test veto. After edits, stage/test a new digest instead of inheriting old
success.

Snapshots include entry selection, bytes, permissions, and the represented local
symlink/dependency topology. Existing declared dependencies must stay within the
explicit local closure. Missing closure, inherited external package scope, external
standalone-file links, or ambiguous bare CommonJS file targets require fixing the
ordinary workspace/package-directory linkage; stage never installs or guesses a
version. Keep artifacts away from ambient same-name `node_modules` namespaces.
Snapshots do not cover arbitrary absolute/dynamic imports, ambient files, secrets,
network, or a malicious process that mutates and restores bytes.

## 5. Install disabled, then activate explicitly

Use the real `extension_manage` tool, not code inside the extension. Under the
user's authorized scope:

1. Call `action: "install"` with a new `id`, the actual staged `digest`, and optional
   plain JSON `config`. It saves the new extension disabled without importing it
2. Read the returned `status`, `persistence`, and `runtime` snapshot. Installation
   should be applied with `runtime.status: "disabled"`; persistent hosts should
   also report `persistence: "saved"`. `failed` or `rejected` is not completion
3. Call `action: "activate"` with that `id` (or `enable`) when activation is intended
4. Read its result: verify `status: "applied"`, persistence, `runtime.status: "active"`,
   actual tools, activation UUID, digest and config. On the next model request,
   use the fresh tool declarations to exercise the requested capability

These are ordinary successive tool calls in the same user request. Management
waits for application itself. Do not end the task, ask the user to say "continue",
wait for another user message/Wake, or create a Wake to finish management. Brief
progress messages are fine while continuing.

For an already installed generated extension whose ID is `sample`, the activation
call is `extension_manage({"id":"sample","action":"activate"})`. Read its actual
response before invoking the tools named in `runtime.tools`. Use IDs discovered
by `extension_inspect({})`; this example does not authorize guessing an installed ID.

`extension_inspect({})` returns current `extensions`, `releases`, `changes`, and
`diagnostics`; use it for discovery, current status, or a concrete failure. Match
`changes[].id` to the management receipt. Receipts describe that completed
operation; later changes or restarts may change the current runtime state.
`persistence: "saved"` alone does not prove code is active, and `waiting` means a
missing dependency. After disable, verify disabled state from its result rather
than waiting for the timer you just stopped to wake you again. After remove,
`runtime` is null. A timer registration or active extension does not prove that
its requested future behavior has actually happened.

A same-batch call to an activation just removed or replaced returns a known
stale/not-executed error. Continue with the next model request's fresh declaration;
do not silently assume old arguments fit a new schema. On failure, diagnose the
reported fields and preserve the distinction between saved desired state and
runtime state. Do not blindly repeat mutations or poll indefinitely.

Generated lifecycle needs a real absolute `artifactsDirectory` in the host's
ordinary desired JSON. File-backed hosts save to that same configuration file;
programmatic entries without one are explicitly ephemeral. If the host lacks this
configuration or management tools, inspect the server setup and report the concrete
prerequisite; this skill does not authorize unrelated core or configuration edits.

## 6. Update, configure, recover, or remove

- `update`: stage/test new files, then supply `id`, new `digest`, optional `config`.
  Current enabled/disabled state is preserved
- `configure`: supply the exact new config; generated entries get a code/config
  revision. Record its ID from inspection
- `rollback`: supply `id` and an exact saved `revision` from
  `extensions[].generated.history`. A digest alone is insufficient: the revision
  restores code and config, preserves enabled state, and may itself fail
- `reload`: generated entries use a fresh complete copy; manual entries restart
  the currently imported module without cache invalidation
- `disable`/`enable`: change desired enabled state and lifecycle resources for manual or generated entries. `activate` is generated-only; use `enable` for a manually configured extension
- `remove`: drain/unregister and remove desired entry; source, releases and activation
  files remain. No permanent-delete or garbage-collection command is supplied.
  Removed configuration history is no longer an installed revision list; keep an
  authorized config copy if later reinstall must reproduce it

Inspect these separately:

- Change `status`: `applied` or `failed`; invalid management requests return `rejected`
- `persistence`: `saved`, `failed`, `not-attempted`, or `not-required`
- `artifact`: `verified` or `failed` when reported
- `test`: `passed`, `failed`, `not-run`, or `invalidated` when reported
- `cleanup: "failed"`, errors/diagnostics, and actual extension state/tools

Artifact verification precedes saving. Failed save leaves runtime unchanged;
saved config plus failed import/apply remains desired for restart/retry. Cleanup
can change ordinary candidate files after the save; activation re-verification may
then invalidate artifact/test evidence while persistence stays `saved`. Desired
files, Cordis runtime, PostgreSQL and external effects are not one transaction.
On restart, enabled desired entries initialize again and disabled ones do not
import; extension initialization should handle its own idempotency. Activation UUID
identifies a generation, SHA identifies content, and revision identifies code/config.
Unknown outcomes after crashes need inspection/reconciliation, not blind replay.

## An already-installed source package

For a shipped or other explicitly selected local package with already-installed
runtime dependencies, use the ordinary preparation helper before staging:

```sh
node scripts/prepare-extension-package.mts /absolute/source-package /absolute/new-workspace [src/index.ts]
```

Inspect the selected package first: it must contain no credentials or unrelated private files. The helper is not a secret scanner.
The helper copies the selected source without `.git` or `node_modules`, links only
its installed declared runtime dependency closure, and returns `entry.mjs`. It does
not install packages, run scripts, fetch a registry or grant account access. Required
missing dependencies and ambiguous root package resolutions are errors; absent
optional dependencies/optional peers are allowed, and transitive versions retain
separate original paths. Dependency graph cycles terminate; source backlinks or
external source symlinks are rejected rather than capturing unrelated files. Every runtime dependency tree is also checked: links may resolve only inside the explicitly declared closure; undeclared nested packages, external links and linked package manifests are rejected before preparation writes. Keep these installed sources unchanged until staging; this helper is not an OS sandbox.

Stage the returned workspace, run content-bound tests, then install and activate via
the same tools described above. Do not replace the normal digest-bound workflow with
a manual JSON edit. The shipped Feishu/Lark consumer is at
`packages/feishu-channel`; read its README before connecting, and let the user enter
credentials or scan authorization in its generic protected extension settings.
