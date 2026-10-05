# Real PostgreSQL integration

`postgres.test.mts` exercises the real `pg` adapter and `node-pg-migrate` runner against an explicitly configured synthetic PostgreSQL 18.6 database. It covers up/down/up, exact envelope restoration, append-only storage, CAS, chain/duplicate rejection, atomic optional-wake receipts, intent/outcome persistence, transaction rollback, unknown-version failure, session-lock loss without epoch change, backend termination, and cross-process ownership/takeover.

Run from the repository root:

```sh
MIRA_TEST_DATABASE_URL=postgres://mira_test:synthetic-ci-only@127.0.0.1:5432/mira_test pnpm test:integration
```

There is no implicit URL or skip fallback. `database.mts` rejects non-local URLs and databases other than `mira_test`, creates a unique schema, applies migrations and removes the schema in cleanup. Use a dedicated disposable server/role with synthetic data only. The CI workflow provides the official PostgreSQL 18.6 service. No model, provider credentials or paid network calls are needed.

Socket-restricted environments cannot run these client integration tests. PostgreSQL single-user SQL checks alone validate only migration syntax and constraints; they do not validate this adapter, node-pg-migrate, connection loss or concurrency. Report those separately.
