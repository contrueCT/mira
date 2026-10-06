# Independent tool usability exercise

Run `node scripts/tool-usability.mts init` from the source checkout. The command
creates a fresh disposable directory outside the checkout (and rejects a TMPDIR inside it) and prints its path,
exercise goals, and production prompt/skill references. It does not use a model,
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
and reads. Full-text search is only a Unicode-word approximation over the same
65,536-character prefix; it does not reproduce PostgreSQL parsing, JSON spacing,
lexical rank, or snippets. Pagination is not exposed by these model tools and is
not implemented in this fixture. Database correctness belongs to the separate
PostgreSQL integration suite. Commit references in the history are synthetic.
This exercise also does not verify Pi durable intent/outcome persistence, remote
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

`node --test tests/unit/tool-usability.test.mts` covers live declarations and
prompt references, history read limits, file-only staging, genuine rejections,
and actual template install/activate/invoke/disable with persisted config. These
checks are included in the ordinary offline test discovery. The CLI source is
checked by `tsconfig.pi.json` because Pi/Cordis declarations require the same
Bundler-resolution profile as the production adapters. Run the CLI from source;
it is intentionally not part of the standalone NodeNext script build.
