-- Up Migration

-- Cap only the search projection, never the authoritative original. PostgreSQL
-- tsvectors have a size limit; an unbounded expression index could break writes.
CREATE INDEX life_events_history_fts ON life_events USING gin
  (to_tsvector('simple'::regconfig, left(event::text || E'\n' || coalesce(requested_wake::text, ''), 65536)));
CREATE INDEX context_records_history_fts ON context_records USING gin
  (to_tsvector('simple'::regconfig, left(envelope::text, 65536)));
CREATE INDEX tool_executions_history_fts ON tool_executions USING gin
  (to_tsvector('simple'::regconfig, left(intent::text || E'\n' || coalesce(outcome::text, ''), 65536)));
CREATE INDEX wake_runs_history_fts ON wake_runs USING gin
  (to_tsvector('simple'::regconfig, left(run_id || E'\n' || claimed_at || E'\n' || coalesce(input_record_id, '') || E'\n' || coalesce(final_record_id, '') || E'\n' || CASE WHEN completed THEN 'completed' ELSE 'running' END, 65536)));

-- Down Migration

DROP INDEX wake_runs_history_fts;
DROP INDEX tool_executions_history_fts;
DROP INDEX context_records_history_fts;
DROP INDEX life_events_history_fts;
