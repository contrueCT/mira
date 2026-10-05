# Trusted local Extension Host

Official pins: `cordis@4.0.0-rc.10`, `@cordisjs/plugin-loader@1.0.0-rc.7`,
`@cordisjs/plugin-hmr@1.1.0`, and `@cordisjs/plugin-timer@1.1.3` (timer declares
Cordis `^4.0.0-rc.9`). No native addon or dependency installation scripts run.
Source HMR requires Node 24 with `--expose-internals`.

`ExtensionHost` loads explicitly configured absolute local files, preserving stable
configured identities across code instances. Cordis owns dependency injection,
plugin state, load/apply/disposal and HMR. Registry inspection combines that state
with registered tools, activation IDs, diagnostics, and requested-change receipts;
there is no additional registry database.

`requestChange` returns **accepted**, not applied. The next `prepare()` releases the
previous entire model/tool batch, awaits queued operations and known Cordis work,
then captures a complete immutable registry and holds its resources. `finish()`
releases the terminal/error batch without reopening cognition. Never await a queued
change from a tool that belongs to the batch being retired. Server management tools
use the same authorization/intent/outcome path as every other tool.

Native service/timer disposers are collected into ordered Cordis effects, with the
batch wait disposed first. Registering an independent async cleanup is insufficient:
Cordis otherwise disposes sibling resources concurrently. SDK tools/listeners and
async callbacks wait for the same batch. Provided services are withdrawn and their
dependent generations fully drained before provider timers/listeners are stopped;
only then do user cleanup callbacks release provider resources. Shutdown also
tracks dependencies after Cordis removes its registry entries. Code is not unloaded while its published
batch is executing. Detached, unregistered extension work has no such guarantee.

Each activation has an instance UUID appended to tool descriptions by the server.
Existing Pi declaration deltas persist it even when a code change keeps the schema.
It identifies an activation, not a cryptographic code hash. On restart, actual
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
- `reload` restarts the currently imported module, including recovery from a failed
  apply. It is not cache invalidation; source changes use official HMR
- Changes to the host/framework dependency graph can make upstream `loader.exit()`
  exit the process. No vendored HMR fork or process-exit suppression is installed
- Watching covers trusted extension directories, never default Memory/State change
  notifications. Extensions can explicitly emit events or request Wakes

No generated extensions, npm marketplace, auto dependency installation, unknown-code
isolation, approval buttons, or hard risk-category gate is added. Plain settings
reject Cordis `__jsExpr` executable expressions to keep configuration from becoming
an implicit code-activation route.

## Checks

`pnpm check` runs strict typechecking, boundaries, all offline tests and tool build.
`tests/unit/official-hmr.test.mts` launches real Node `--expose-internals` children;
it requires a post-teardown completion marker so an upstream zero-code exit cannot
look like a passing test. Host tests cover dependency loss/recovery, errors, queued
changes, repeated async cleanup and whole-batch leases. `pnpm check:all` additionally
requires the explicit isolated PostgreSQL service; no live models are used.
