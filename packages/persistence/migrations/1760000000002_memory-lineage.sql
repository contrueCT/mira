-- Up Migration

    -- PostgreSQL and the Memory Git repository cannot commit atomically.
    -- Intent, immutable Git outcome, then Wake completion are separate durable
    -- boundaries. State files never participate in these Memory snapshots.
    CREATE TABLE wake_memory_checkpoints (
      mira_id text NOT NULL,
      run_id text NOT NULL,
      final_record_id text NOT NULL,
      prepared_at text NOT NULL,
      payload json NOT NULL,
      PRIMARY KEY (mira_id, run_id),
      FOREIGN KEY (mira_id, run_id) REFERENCES wake_runs(mira_id, run_id),
      FOREIGN KEY (mira_id, final_record_id) REFERENCES context_records(mira_id, record_id)
    );
    CREATE TRIGGER memory_checkpoint_append_only BEFORE UPDATE OR DELETE ON wake_memory_checkpoints
      FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();

    CREATE TABLE wake_memory_receipts (
      mira_id text NOT NULL,
      run_id text NOT NULL,
      commit_id text CHECK (commit_id IS NULL OR commit_id ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
      PRIMARY KEY (mira_id, run_id),
      FOREIGN KEY (mira_id, run_id) REFERENCES wake_memory_checkpoints(mira_id, run_id)
    );
    CREATE TRIGGER memory_receipt_append_only BEFORE UPDATE OR DELETE ON wake_memory_receipts
      FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();

    CREATE FUNCTION mira_guard_memory_completion() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.completed AND EXISTS (
        SELECT 1 FROM wake_memory_checkpoints AS c
        WHERE c.mira_id = NEW.mira_id AND c.run_id = NEW.run_id
      ) AND NOT EXISTS (
        SELECT 1 FROM wake_memory_receipts AS r
        WHERE r.mira_id = NEW.mira_id AND r.run_id = NEW.run_id
      ) THEN
        RAISE EXCEPTION 'Pending Memory checkpoint must finish before Wake completion';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER wake_memory_completion BEFORE UPDATE ON wake_runs
      FOR EACH ROW EXECUTE FUNCTION mira_guard_memory_completion();

-- Down Migration

    DROP TRIGGER wake_memory_completion ON wake_runs;
    DROP FUNCTION mira_guard_memory_completion();
    DROP TABLE wake_memory_receipts;
    DROP TABLE wake_memory_checkpoints;
