# Integrated first native attempt: cleanup failure

These files retain the exact probe source and observed process-exit output for
the six original integrated-schema native evaluations on 2026-10-16.
`reply-probe.mts.txt` is byte-identical to the probe at source commit
`ab63f3ad2cbedd16ac9fcf3d8a641f3ec4a293a1`, SHA-256
`b8672dbd3e9545e6fa0431f0aeece62b68d3035f10cdca9c282b26ea8e52876c`.

All six wrote completed `result.json`, including their actual native decisions
and successful selected tool outcomes, then exited **1** during cleanup because
the synthetic writer lacked `interruptSubagents`. The exception happened in
`finally`, outside the failure-file catch, so absent `failure.json` was not
evidence of a successful process exit. `process-exits.json` retains the six
observed exit statuses and returned output chunks, including the error and
actual Node v24.19.0 version; these are not complete stdout transcripts.

The active native fixture retains all fourteen original decisions unchanged.
The fixed probe only adds the no-child lifecycle cleanup method. Unsupported
subagent selections still fail before execution; no child persistence is
implemented. Separate recorded-choice CLI replay exercises actual execution
and normal cleanup but provides no new native-model judgment.

See [the acceptance report](../../../../docs/acceptance/reply-native-behavior.md)
and [capture manifest](../../reply-native-capture-manifest.json) for attribution,
raw-directory digests, replay evidence, and outstanding real-PG/browser gates.
