-- Up Migration

    CREATE TABLE mira_owners (
      mira_id text PRIMARY KEY,
      lock_key integer GENERATED ALWAYS AS IDENTITY UNIQUE NOT NULL,
      epoch bigint NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      context_version bigint NOT NULL DEFAULT 0 CHECK (context_version >= 0),
      head_record_id uuid
    );
    CREATE TABLE history_records (
      id uuid PRIMARY KEY,
      mira_id text NOT NULL REFERENCES mira_owners(mira_id),
      kind text NOT NULL CHECK (kind IN ('event', 'context', 'tool', 'wake')),
      UNIQUE (id, mira_id, kind),
      CHECK (id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    );
    CREATE TABLE context_records (
      mira_id text NOT NULL REFERENCES mira_owners(mira_id),
      record_id uuid NOT NULL,
      history_kind text GENERATED ALWAYS AS ('context'::text) STORED,
      version bigint NOT NULL CHECK (version > 0),
      parent_id uuid,
      envelope json NOT NULL,
      PRIMARY KEY (mira_id, record_id),
      UNIQUE (mira_id, version),
      FOREIGN KEY (record_id, mira_id, history_kind) REFERENCES history_records(id, mira_id, kind),
      FOREIGN KEY (mira_id, parent_id) REFERENCES context_records(mira_id, record_id)
    );
    CREATE TABLE life_events (
      mira_id text NOT NULL REFERENCES mira_owners(mira_id),
      history_id uuid NOT NULL UNIQUE,
      history_kind text GENERATED ALWAYS AS ('event'::text) STORED,
      event_id text NOT NULL,
      event json NOT NULL,
      requested_wake json,
      PRIMARY KEY (mira_id, event_id),
      FOREIGN KEY (history_id, mira_id, history_kind) REFERENCES history_records(id, mira_id, kind)
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
      history_id uuid NOT NULL UNIQUE,
      history_kind text GENERATED ALWAYS AS ('tool'::text) STORED,
      call_id text NOT NULL,
      assistant_record_id uuid NOT NULL,
      context_version bigint NOT NULL CHECK (context_version > 0),
      intent json NOT NULL,
      outcome json,
      PRIMARY KEY (mira_id, call_id),
      FOREIGN KEY (history_id, mira_id, history_kind) REFERENCES history_records(id, mira_id, kind),
      FOREIGN KEY (mira_id, assistant_record_id) REFERENCES context_records(mira_id, record_id)
    );
    CREATE FUNCTION mira_reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'Mira history is append-only';
    END
    $$;
    CREATE TRIGGER history_identity_append_only BEFORE UPDATE OR DELETE ON history_records
      FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();
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
        OLD.history_id IS DISTINCT FROM NEW.history_id OR
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
    DROP TABLE history_records;
    DROP FUNCTION mira_reject_history_change();
    DROP TABLE mira_owners;
