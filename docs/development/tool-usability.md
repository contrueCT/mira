# Independent tool usability exercise

The disposable session starts with an empty `home/`, not a prewritten extension
configuration. Its first tool operation calls the same default configuration
loader as the web CLI, then starts the real `ExtensionHost`; later CLI operations
reopen that saved home. No `MIRA_EXTENSIONS` override is supplied. The scenario's
paths and rendered prompt point to `home/extensions.json` and
`home/extension-artifacts`. Evaluators use this CLI directly rather than writing
their own adapter or manual configuration. This covers the default loader and
production management handlers, not the database-backed web service or listener.

Run `node scripts/tool-usability.mts init` from the source checkout. The command
creates a fresh disposable directory outside the checkout (and rejects a TMPDIR inside it) and prints its path,
exercise goals, a `paths.memory` directory, and production prompt/skill references.
It creates an independent disposable Memory Git repository using the production
`setupMemoryWorkspace` and `snapshotMemory` functions, with synthetic notes and
a genuine commit carrying a `History-Id` trailer. It does not use a model,
network connection, credential, existing Mira home, or database.

Give an independent evaluator only the resulting task brief, this command entry
point, and access to ordinary file/shell tools. Do not give it fixture source,
fixture history JSON, the test assertions, implementation discussion, or expected
answers. Have it run `node scripts/tool-usability.mts --help`, discover the live
production declarations with `list`, and inspect the real prompt with `prompt`.
It can read production skills and linked SDK documentation as needed. The evaluator
should report confusing wording, failed attempts, actual results, and limitations.

```sh
node scripts/tool-usability.mts /tmp/mira-tool-usability-EXAMPLE list
node scripts/tool-usability.mts /tmp/mira-tool-usability-EXAMPLE prompt
node scripts/tool-usability.mts /tmp/mira-tool-usability-EXAMPLE call extension_inspect '{}'
node scripts/tool-usability.mts /tmp/mira-tool-usability-EXAMPLE serve
```

The last command accepts one JSON request per line and keeps one live
`ExtensionHost` until stdin closes or a `{"command":"close"}` request arrives.
Each `call` or `batch` completes one host preparation boundary. A batch freezes the
same tool registry for all of its calls; newly activated tools are available at
the next boundary. The other invocations start a new host from the same saved
configuration. Restart imports active extensions again, so use `serve` when
measuring in-process resources or activation continuity. No wrapper service or
alternative runtime is introduced.

`list` returns names, descriptions, and JSON schemas directly from production
`createHistoryTools`, `extensionManagementTools`, and active `extensionTools`.
`prompt` renders the production template with synthetic environment values and
appends the production skill loader's catalog, matching the runtime's composition.
Calls use Pi's real argument validator and then invoke those actual handlers.
Stage, install, activate, execution, disable, and saved configuration changes use
the real artifact store and Cordis host against disposable local files.

History uses a clearly labeled synthetic `HistoryReader` adapter. Exact reads and
substring searches use the fixture's original records and enforce bounded queries
and reads. Every History record has a canonical globally unique UUID; reads accept
only `{id, maxBytes?}` and return the record kind. Event originals retain their
external IDs, tool records retain their provider call IDs, and wake membership
separately exposes `eventId`, `externalEventId`, and `wakeReceiptId`. These source
keys are not History IDs. Reads and searches enforce the fixture Mira scope,
including a negative-control record belonging to another Mira. Wake input/final
references, context parent chains, event membership and tool assistant references
resolve to complete fixture originals. Full-text search is only a Unicode-word approximation over the same
65,536-character prefix; it does not reproduce PostgreSQL parsing, JSON spacing,
lexical rank, or snippets. Pagination is not exposed by these model tools and is
not implemented in this fixture. Database correctness belongs to the separate
PostgreSQL integration suite.

The Memory commit is a real Git object produced during `init`, not an invented
commit hash or simulated snapshot tool. Its `History-Id` identifies the completed
fixture wake. The historical conversation and write-tool evidence are synthetic,
and an explicit fixture annotation links the final record to the separately
generated commit. This does not mean a real Pi wake produced the synthetic
history or that a historical tool invocation executed. The later verification
intent deliberately has no recorded outcome. The evaluator can inspect ordinary
Memory files and Git history, then use the production History tools to establish
the original evidence without access to fixture source/data or supplied answer
IDs. This exercise also does not verify Pi durable intent/outcome persistence, remote
model transport, or live-account behavior.

`evidence.jsonl` contains actual displayed declarations, prompt, call start/result
records, and post-boundary host state. It is a test witness, not production history.
A missing result after a started call is unknown, not success. Tool errors appear
as the actual returned result or caught validation/execution error. Use those
records and ordinary file checks to assess the evaluator after it finishes.

Native tests and extension imports execute with the current OS user's permissions.
These directories are not a sandbox. Use synthetic local code only; do not expose
secrets, user files, external accounts, or production extensions. Remove only the
session directory you created after retaining any desired evidence.

## Harness regression check

`node --test tests/unit/tool-usability.test.mts` covers blank-home default startup
and configuration retention across reopening, live declarations and
prompt references, id-only schemas and canonical UUID validation, complete
provenance links and Mira scoping, history read limits, a real production Memory
commit-to-History round trip, file-only staging, genuine rejections,
and actual template install/activate/invoke/disable with persisted config. These
checks are included in the ordinary offline test discovery. The CLI source is
checked by `tsconfig.pi.json` because Pi/Cordis declarations require the same
Bundler-resolution profile as the production adapters. Run the CLI from source;
it is intentionally not part of the standalone NodeNext script build.
