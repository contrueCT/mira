# Historical replay source snapshots

These two files are byte-for-byte copies from commit
`470659e9e8cef32a6357f2592e728de16206ca72`, before the macOS fixture-root
canonicalization. The existing capture manifest and Linux replay JSON retain
all original bytes, paths, request hashes, decisions, outcomes and source hashes.
Their source provenance resolves to these snapshots rather than to a revised
script that did not produce those historical results.

The current `.mts` entry points canonicalize only newly created temporary roots.
`fixtures/reply-probe-replay-macos-node24-21.json` separately records the actual
macOS Node 24.21.0 full-CLI replay and pins the current probe/driver source hashes.
It reuses the original choices with verified UUID/index-path binding and adds no
native-model observations. Unit checks retain the full historical digest checks
and check current source/schema/decision counts against this separate artifact.

SHA256:

- `reply-probe.mts.txt`: `61a121df5dd5b49445ebc43263fa3a2ebfbf498cc8e561c80f157c43c411d786`
- `replay-reply-probe.mts.txt`: `1394ac21c545478800de20c7204d368e5a06d73ce88df4521407cefbee98951c`
