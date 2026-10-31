-- Up Migration

-- Read-only usage aggregation (ADR 0048): range scans by record time and the
-- Wake that was active when a record was appended.
CREATE INDEX context_records_by_time ON context_records (mira_id, (envelope->>'occurredAt'));
CREATE INDEX wake_runs_by_claimed_version ON wake_runs (mira_id, claimed_version);

-- Down Migration

DROP INDEX wake_runs_by_claimed_version;
DROP INDEX context_records_by_time;
