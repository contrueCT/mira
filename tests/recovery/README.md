# Durable context recovery tests

`pnpm test` runs offline runtime coverage in `tests/unit/runtime.test.mts`, using
`fixtures.mts`'s fault-injectable `MemoryWriter`. This fixture is not durable
storage and is never an adapter fallback.

`pnpm test:integration` also runs `postgres-recovery.test.mts` against real
PostgreSQL. The pinned CI service is `postgres:18.6`. Set an explicit isolated URL:

```sh
MIRA_TEST_DATABASE_URL=postgresql://mira:mira@127.0.0.1:5432/mira_test pnpm test:integration
```

Only `localhost`, `127.0.0.1`, or `::1` and database `mira_test` are accepted. Each
test migrates a unique synthetic schema and removes it afterward. No production
connection, implicit local default, live model account, or provider credential is
used. Missing or unreachable PostgreSQL fails the integration gate; it is not a
skipped/pass result. Check the current CI evidence before claiming a real-DB pass.

## Coverage

- Independent Node processes continue one Mira and preserve original record IDs,
  original structured message prefix and provider fields
- Processes terminate after durable intent but before/after a synthetic external
  filesystem counter effect; recovery blocks with unknown outcome and no retry
- A process terminates after outcome commit but before tool-result append; recovery
  materializes exact saved JSON and continues without repeating the counter effect
- Duplicate call IDs do not repeat effects across runtime instances
- Terminating the actual owning PostgreSQL connection during model response,
  authorization or an effect stops the old runtime's later model/tool paths
- Full public SDK compaction repeats after a system update, retains original raw
  history and paired tool tails, then supports continuation
- Real-DB stale-version CAS and compaction cancellation reject publication

The persistence integration suite separately exercises lock contention, epochs,
migration reversibility, writer fencing, event/Wake atomicity, and cancellation
while an INSERT is blocked before COMMIT. The runtime offline suite additionally
injects assistant/intent/outcome/result append failures and exercises Pi's swallowed
hook-error behavior, invalid checkpoints and provider-facing structure, model
failure latching, argument coercion, and authorization denial.

`ambient-auth-worker.mts` is an offline subprocess fixture discovered through
`tests/unit/runtime.test.mts`. It supplies only synthetic environment credentials
for recognized providers and rejects auth-file probes beneath its isolated HOME.
It checks exact original model delivery, no automatically resolved auth options,
unchanged original records/tail, and no disposable provider alias in checkpoints.

All model responses and counter effects are synthetic. HTTP/fetch are intercepted
by `tests/deny-model-network.mts`; the runner supplies a clean HOME and strips
credential/proxy environment variables. This is an accidental-call tripwire, not a
security sandbox. PostgreSQL sockets remain enabled for integration tests.

No claim is made about live providers, summary quality, provider signature replay,
real remote effect idempotency, database power failure, failover, or production
scale. After COMMIT dispatch a cancellation/connection loss may leave an ambiguous
client response; authoritative recovery is required. These tests do not prove
exactly-once remote effects or prevent an already-running tool that ignores its
AbortSignal from finishing.
