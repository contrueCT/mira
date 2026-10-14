# Combined agent capability acceptance

Integration is isolated on `integration/agent-capabilities`, based on
`a7eda5f83f7d6d56b8555c11b003ad833934aed8`. No merge to main or deployment is part
of this verification.

## Source revisions

- PR #24, durable single-shot delivery: `86da75793558c5897887ffbcb0a7c93aa442b80e`
- PR #25, live user input: `c3263b339c782e2d4bccdad6bc81831ee1ccfb2e`
- PR #26, task-scoped subagents: `1b761358db063569488aa2f8d4c5016c965d615b`
- PR #27, public on-demand skills: `9a4cfe56e3f5bc0d29ad1243993bd1fd13695610`

Source CI and reviews do not substitute for integration-head validation.

## Integration-specific changes

- Keep all three migrations, scheduling owner lifecycles, the single fenced parent
  writer, separate child transcript writers and independent history readers.
- Exercise all eight migrations up/down/up in their actual order. The separate
  Wake rollback fixture now removes migration 0001 itself and asserts that
  `wake_runs` is absent; removing only later migrations did not test that claim.
- A child wait reads durable pending input for its claimed run and receives
  committed live-input hints. Tests include receipt-before-execute and a receipt
  during the admission read. Child work is not cancelled by user steering.
- Child completion remains queued and cannot clear a failed parent run's error.
- Worker skills use a standalone persisted metadata section, with no main Mira
  persona, Memory bootstrap or checkpoint. All five bundled skills are discovered
  and read through ordinary worker tools; failure/ownership/CAS fences remain.
- Merge-only fixture updates preserve source assertions, including scheduled
  installation identity, ordered upload selection and read-only child details.

## Gates and evidence

`pnpm check` covers all typechecks, package boundaries, offline/core and Web tests,
and builds. `pnpm check:all` adds real PostgreSQL integration and process recovery.
`pnpm test:capabilities:e2e` adds a real Chromium/HTTP/PostgreSQL/runtime scenario:

1. A fresh child discovers the skill catalog and reads the public PDF skill.
2. A reminder becomes due and the child completes while a parent bash tool waits.
3. An ordinary user send is durably accepted during that one active tool.
4. After its real outcome, the model sees the user input before an old sibling;
   the sibling has no intent/effect and has a truthful not-started observation.
5. Reminder and child result remain in the next coalesced Wake. Each input has
   one owner; main Memory is unchanged and children have no Memory checkpoint.
6. Service restart preserves both replies, one effect and one receipt of each
   background result, without another model request.

`tests/recovery/agent-capabilities.test.mts` separately checks real-service child
wait release and completion after parent failure. Existing source recovery tests
remain in the full suite, including unknown effects and no automatic replay.
Only provider responses are synthetic; these tests do not claim live-model
quality. PostgreSQL/browser gates require the configured CI service: local socket
restrictions are not bypassed and are not counted as a pass. Screenshots and traces
are retained by the CI artifact under `agent-capabilities-real/`.

Final exact-head full CI and independent whole-diff review are required before
calling this integration ready. Their outcome is reported on the integration PR.
