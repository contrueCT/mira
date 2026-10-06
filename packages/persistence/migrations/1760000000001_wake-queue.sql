-- Up Migration

    -- Receipts have durable insertion order independent of their event timestamp.
    ALTER TABLE wake_requests ADD COLUMN receipt_order bigint GENERATED ALWAYS AS IDENTITY;
    ALTER TABLE wake_requests ADD CONSTRAINT wake_receipt_order_unique UNIQUE (receipt_order);

    CREATE TABLE wake_runs (
      mira_id text NOT NULL REFERENCES mira_owners(mira_id),
      run_id uuid NOT NULL,
      history_kind text GENERATED ALWAYS AS ('wake'::text) STORED,
      claimed_at text NOT NULL,
      claimed_version bigint NOT NULL CHECK (claimed_version >= 0),
      input_record_id uuid,
      final_record_id uuid,
      completed boolean NOT NULL DEFAULT false,
      PRIMARY KEY (mira_id, run_id),
      FOREIGN KEY (run_id, mira_id, history_kind) REFERENCES history_records(id, mira_id, kind),
      UNIQUE (mira_id, input_record_id),
      UNIQUE (mira_id, final_record_id),
      FOREIGN KEY (mira_id, input_record_id) REFERENCES context_records(mira_id, record_id),
      FOREIGN KEY (mira_id, final_record_id) REFERENCES context_records(mira_id, record_id),
      CHECK (final_record_id IS NULL OR input_record_id IS NOT NULL),
      CHECK (final_record_id IS NULL OR final_record_id <> input_record_id),
      CHECK (NOT completed OR final_record_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX wake_one_active_run ON wake_runs (mira_id) WHERE NOT completed;

    CREATE TABLE wake_run_requests (
      mira_id text NOT NULL,
      wake_id text NOT NULL,
      run_id uuid NOT NULL,
      PRIMARY KEY (mira_id, wake_id),
      FOREIGN KEY (mira_id, wake_id) REFERENCES wake_requests(mira_id, wake_id),
      FOREIGN KEY (mira_id, run_id) REFERENCES wake_runs(mira_id, run_id)
    );
    CREATE INDEX wake_run_requests_by_run ON wake_run_requests (mira_id, run_id);
    CREATE TRIGGER wake_membership_append_only BEFORE UPDATE OR DELETE ON wake_run_requests
      FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();

    CREATE FUNCTION mira_guard_wake_run() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Mira wake runs are append-only';
      END IF;
      IF OLD.mira_id IS DISTINCT FROM NEW.mira_id OR OLD.run_id IS DISTINCT FROM NEW.run_id OR
        OLD.claimed_at IS DISTINCT FROM NEW.claimed_at OR OLD.claimed_version IS DISTINCT FROM NEW.claimed_version OR
        (OLD.input_record_id IS NOT NULL AND OLD.input_record_id IS DISTINCT FROM NEW.input_record_id) OR
        (OLD.final_record_id IS NOT NULL AND OLD.final_record_id IS DISTINCT FROM NEW.final_record_id) OR
        (OLD.completed AND NOT NEW.completed) THEN
        RAISE EXCEPTION 'Wake evidence may only be appended once';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER wake_run_evidence_once BEFORE UPDATE OR DELETE ON wake_runs
      FOR EACH ROW EXECUTE FUNCTION mira_guard_wake_run();

-- Down Migration

    DROP TABLE wake_run_requests;
    DROP TABLE wake_runs;
    DROP FUNCTION mira_guard_wake_run();
    ALTER TABLE wake_requests DROP COLUMN receipt_order;
