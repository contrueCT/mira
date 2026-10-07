# Local Extension Host

Official pins: `cordis@4.0.0-rc.10`, `@cordisjs/plugin-loader@1.0.0-rc.7`,
`@cordisjs/plugin-hmr@1.1.0`, and `@cordisjs/plugin-timer@1.1.3` (timer declares
Cordis `^4.0.0-rc.9`). No native addon or dependency installation scripts run.
Source HMR requires Node 24 with `--expose-internals`.

`ExtensionHost` loads explicitly configured absolute local files, preserving stable
configured identities across code instances. Cordis owns dependency injection,
plugin state, load/apply/disposal and HMR. Registry inspection combines that state
with registered tools, activation IDs, diagnostics, and requested-change receipts;
there is no additional registry database.

Every registered tool name must start with an ASCII letter or underscore and
contain 1–64 ASCII letters, digits, underscores or hyphens
(`^[A-Za-z_][A-Za-z0-9_-]{0,63}$`). Invalid names fail activation with an explicit diagnostic.
Names are used unchanged by Pi and model APIs; dotted names are not supported.

`await requestChange(...)` serializes management, saves desired configuration, waits
for cleanup/application and returns **applied** or **failed**, with separate
`persistence` and `runtime` facts captured before the next management operation.
Invalid requests reject; the server presents those as `status: rejected`.
After awaited configuration I/O, management drains known Loader tasks again and
starts runtime mutation synchronously after the final empty-task check. This
prevents an already-started HMR replacement from restoring the old state/config;
no private HMR hooks or alternate reload implementation are used.
`prepare()` waits for known lifecycle work and captures an immutable declaration
snapshot. `finish()` settles lifecycle work on exit without reopening cognition.
There is no accepted queue or batch-end application mode. Management tools use
the same schema, immutable intent/outcome and provenance path as every tool.
The main model decides to call or clarify; there is no separate authorize callback
(see [ADR 0007](../../docs/adr/0007-model-owned-action-decisions.md)).

Only an actually executing extension tool holds its activation's resources.
Admission checks activation identity and running state synchronously before
acquiring the execution lease. Once unloading starts, old declarations cannot
start another execution: they return an explicit stale/not-executed result, mapped
to a normal error tool outcome by the server. They never redirect to a new same-name
implementation. Pi keeps the original declaration for validation and obtains the
fresh registry on its next natural model request. Management is not an extension
execution and never holds a lease on the resources it waits to clean up.

Native service/timer disposers use ordered Cordis effects that first drain actual
executions. Registering an independent async cleanup is insufficient because
Cordis otherwise disposes sibling resources concurrently. Registration is fenced
once unloading starts; each listener registration has its own identity. Provided
services are withdrawn and dependent generations drained before provider timers
and listeners stop; user cleanup runs afterward. Shutdown tracks dependencies even
after Cordis removes registry entries. Detached, unregistered extension work has
no such guarantee; extensions must cancel and join their own async callbacks.

Each activation has an instance UUID appended to tool descriptions by the server.
Existing Pi declaration deltas persist it even when a code change keeps the schema.
It identifies an activation, not a cryptographic code hash. Generated tools additionally include their release content SHA-256. On restart, actual
configured files/registry are rebuilt and normal declaration changes are recorded;
files, registry, PostgreSQL, and remote effects are not one atomic transaction.

## Desired configuration

`readExtensionConfiguration(file)` loads an existing ordinary JSON file; passing its
`configurationFile` to the host enables same-file persistence. enable/disable/configure
is saved before apply, with separate `persistence` and `status` receipt fields.
A failed save leaves runtime unchanged; a failed apply leaves saved desired state
for restart/retry. Content changes observed before replacement reject the write.
Temp-file rename is atomic, but the check is not a CAS against concurrent external
editors and no transaction spans config, Cordis, or PostgreSQL. Unknown unrelated
JSON keys are retained. Programmatic entries without a file are explicitly ephemeral.
Receipts are process-local inspection, while ordinary tool results/declaration history
and the desired configuration supply durable evidence. Pending calls are not replayed.

## HMR and failure limits

- Actual official file watching reloads source and transitive ESM dependencies, and
  CommonJS modules imported through the ESM graph
- Nested CJS `require()` edges are not tracked by this release; change the tracked
  entry or restart the host after such edits. Tests explicitly preserve this limit
- File watcher delivery is asynchronous. An explicit configured activation is
  awaited before the next natural model request; a file edit is not a synchronous
  activation barrier. If detected later, it waits for a safe resource boundary
- Import/validation failure can preserve an old live instance. Apply failure occurs
  after old disposal and is not atomic rollback. Inspect actual status/diagnostics
- For manual entries, `reload` restarts the currently imported module, including recovery from a failed
  apply. It is not cache invalidation; source changes use official HMR
- Changes to the host/framework dependency graph can make upstream `loader.exit()`
  exit the process. No vendored HMR fork or process-exit suppression is installed
- Watching covers trusted extension directories, never default Memory change
  notifications. Extensions can explicitly emit events or request Wakes

Generated extensions follow ADR 0005 below. No npm marketplace, auto dependency
installation, execution isolation, approval buttons, or hard risk-category gate is added. Plain settings
reject Cordis `__jsExpr` executable expressions to keep configuration from becoming
an implicit code-activation route.

## Checks

`pnpm check` runs strict typechecking, boundaries, all offline tests and tool build.
`tests/unit/official-hmr.test.mts` launches real Node `--expose-internals` children;
it requires a post-teardown completion marker so an upstream zero-code exit cannot
look like a passing test. Host tests cover dependency loss/recovery, errors, awaited
management, stale-generation rejection, repeated async cleanup and in-flight execution leases. `pnpm check:all` additionally
requires the explicit isolated PostgreSQL service; no live models are used.


## Generated ordinary-file releases

See [ADR 0005](../../docs/adr/0005-generated-extension-lifecycle.md). Configure an
absolute `artifactsDirectory` alongside `entries` in the ordinary JSON document.
The host does not infer a source-workspace location or limit general filesystem tools.

- `stage(sourceRoot, entryRelative, expectedDigest?)` copies all workspace files and
  explicitly present local dependency directories without importing or executing code
- `ArtifactStore` (also exported at `@mira/extension-host/artifacts`) offers stage,
  read/list/verify, fresh activation copies, explicit native command tests and receipts
- `install` takes a digest plus optional config under a new ID, initially disabled
- `activate` (or `enable`) imports a fresh complete copy with new module paths
- `update` takes a new digest and optional config, preserving enabled/disabled state
- `configure` records a new code/config revision; `rollback` requires an exact saved
  revision ID from inspection and restores that code and config in a fresh copy
- Generated `reload` also uses a fresh complete copy; generated files are not watched
- `remove` drains resources and removes desired configuration. Source, releases and
  activation files remain; no garbage collector or irreversible deletion is provided

Use [the template](../../templates/extension/README.md) and native read/write/edit/bash.
For example, from the repository, with paths outside it:

```sh
node scripts/create-extension-workspace.mts /absolute/coding/my-extension
node scripts/extension-artifact.mts stage /absolute/data/releases /absolute/coding/my-extension src/index.ts
node scripts/extension-artifact.mts test /absolute/data/releases SHA256 -- node --test
node scripts/extension-artifact.mts status /absolute/data/releases SHA256
```

Use the returned digest in `extension_manage`; `extension_stage` exposes the same
file-only stage operation. Read the template for its exact entry filename and
compiler command. A test receipt is tied to unchanged complete snapshot bytes;
changed code/dependencies get a new digest and cannot inherit old test success.
An untested version is `not-run`, not implicitly verified by an activation UUID.
No mandatory test-success veto is imposed on an otherwise authorized decision.

Each revision stores config in the same JSON desired state. Release/config/runtime
and PG writes remain separate. Persistence reports saved, failed,
not-attempted (artifact failed first), or not-required (ephemeral/reload). A saved
version whose import/apply fails remains desired for restart, without claiming
rollback. If old cleanup changes candidate files after saving, activation-time
verification invalidates the earlier artifact/test evidence while retaining saved
persistence. Disabled restart does not import. Explicit rollback may fail and never
undoes external effects. Management outcomes that are unknown after a crash remain
visible to the model; they are not blindly replayed.

Snapshots cover the workspace and explicit local dependency tree, not arbitrary
absolute/dynamic imports, host files, environment, network or malicious mutate-and-
restore behavior. Native tests/imports execute as the host OS identity without
isolation. This is an ordinary-file consistency mechanism, not a security sandbox.


Snapshot layout preserves the relative topology of selected roots in a private
sparse tree; `workspace` points into that tree. Only those roots are copied, not
unrelated common-ancestor contents. Existing declared dependency aliases are
retained only for explicitly supplied targets; a resolvable runtime dependency
outside the snapshot is a stage error, not an implicit install or version guess.
External standalone-file links and inherited package scopes outside the selected
roots require linking the containing package directory instead. Internal file
links remain supported. A container scope barrier prevents the release location
from silently changing ESM/CJS defaults. Content identity includes represented
relative topology as well as bytes and permissions.


Manual HMR excludes the canonical and configured artifact-store subtree even
when it is nested below a manual watch root. Retargeting a configured store alias
requires a host restart to establish the new exclusion; it cannot silently move
generated versions into the watcher. Declared dependency closure is rechecked
when reading, verifying and making fresh copies, so previously absent optional
or peer dependencies cannot start resolving outside the container. Declared bare
CommonJS file targets (including suffix lookup) require a package directory or
an explicit within-snapshot relative import; they are rejected before execution.


Declared namespaces conservatively include every directory candidate in the
ordinary ancestor node_modules chain, since CommonJS can fall through an empty
directory or a missing subpath. An artifact store underneath an ambient same-name
package namespace is rejected even when a nearer private candidate exists;
choose an independent data directory. This is snapshot consistency, not a limit
on the general file/Shell tools or an OS execution sandbox.
