-- Up Migration

    CREATE TABLE mira_owners (
      mira_id text PRIMARY KEY,
      lock_key integer GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
      epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      context_version bigint NOT NULL DEFAULT 0 CHECK (context_version >= 0),
      head_record_id text
    );
    CREATE TABLE context_records (
      mira_id text NOT NULL REFERENCES mira_owners(mira_id),
      record_id text NOT NULL,
      version bigint NOT NULL CHECK (version > 0),
      parent_id text,
      envelope json NOT NULL,
      PRIMARY KEY (mira_id, record_id),
      UNIQUE (mira_id, version),
      FOREIGN KEY (mira_id, parent_id) REFERENCES context_records(mira_id, record_id)
    );
    CREATE TABLE life_events (
      mira_id text NOT NULL REFERENCES mira_owners(mira_id),
      event_id text NOT NULL,
      event json NOT NULL,
      requested_wake json,
      PRIMARY KEY (mira_id, event_id)
    );
    CREATE TABLE wake_requests (
      mira_id text NOT NULL,
      wake_id text NOT NULL,
      event_id text NOT NULL,
      wake json NOT NULL,
      PRIMARY KEY (mira_id, wake_id),
      UNIQUE (mira_id, event_id),
      FOREIGN KEY (mira_id, event_id) REFERENCES life_events(mira_id, event_id)
    );
    CREATE TABLE tool_executions (
      mira_id text NOT NULL,
      call_id text NOT NULL,
      assistant_record_id text NOT NULL,
      context_version bigint NOT NULL CHECK (context_version > 0),
      intent json NOT NULL,
      outcome json,
      PRIMARY KEY (mira_id, call_id),
      FOREIGN KEY (mira_id, assistant_record_id) REFERENCES context_records(mira_id, record_id)
    );
    CREATE FUNCTION mira_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Mira history is append-only';
    END
    $$;
    CREATE TRIGGER context_append_only BEFORE UPDATE OR DELETE ON context_records
      FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();
    CREATE TRIGGER event_append_only BEFORE UPDATE OR DELETE ON life_events
      FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();
    CREATE TRIGGER wake_append_only BEFORE UPDATE OR DELETE ON wake_requests
      FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();
    CREATE FUNCTION mira_guard_tool_outcome() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Mira tool history is append-only';
      END IF;
      IF OLD.outcome IS NOT NULL OR NEW.outcome IS NULL OR
        OLD.mira_id IS DISTINCT FROM NEW.mira_id OR OLD.call_id IS DISTINCT FROM NEW.call_id OR
        OLD.assistant_record_id IS DISTINCT FROM NEW.assistant_record_id OR
        OLD.context_version IS DISTINCT FROM NEW.context_version OR
        OLD.intent::text IS DISTINCT FROM NEW.intent::text THEN
        RAISE EXCEPTION 'Only the first tool outcome may be appended';
      END IF;
      RETURN NEW;
    END
    $$;
    CREATE TRIGGER tool_outcome_once BEFORE UPDATE OR DELETE ON tool_executions
      FOR EACH ROW EXECUTE FUNCTION mira_guard_tool_outcome();
  
-- Down Migration

    DROP TABLE tool_executions;
    DROP FUNCTION mira_guard_tool_outcome();
    DROP TABLE wake_requests;
    DROP TABLE life_events;
    DROP TABLE context_records;
    DROP FUNCTION mira_reject_history_change();
    DROP TABLE mira_owners;
  