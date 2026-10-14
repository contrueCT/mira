-- Up Migration

ALTER TABLE wake_run_requests ADD CONSTRAINT wake_run_request_identity UNIQUE (mira_id, wake_id, run_id);

CREATE TABLE wake_live_inputs (
  mira_id text NOT NULL,
  wake_id text NOT NULL,
  run_id uuid NOT NULL,
  input_record_id uuid,
  PRIMARY KEY (mira_id, wake_id),
  UNIQUE (mira_id, input_record_id),
  FOREIGN KEY (mira_id, wake_id, run_id) REFERENCES wake_run_requests(mira_id, wake_id, run_id),
  FOREIGN KEY (mira_id, run_id) REFERENCES wake_runs(mira_id, run_id),
  FOREIGN KEY (mira_id, input_record_id) REFERENCES context_records(mira_id, record_id)
);
CREATE INDEX wake_live_inputs_by_run ON wake_live_inputs(mira_id, run_id);
CREATE FUNCTION mira_guard_live_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Live inputs are append-only'; END IF;
  IF OLD.mira_id IS DISTINCT FROM NEW.mira_id OR OLD.wake_id IS DISTINCT FROM NEW.wake_id OR
     OLD.run_id IS DISTINCT FROM NEW.run_id OR
     (OLD.input_record_id IS NOT NULL AND OLD.input_record_id IS DISTINCT FROM NEW.input_record_id) THEN
    RAISE EXCEPTION 'Live input evidence may only be appended once';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER live_input_evidence_once BEFORE UPDATE OR DELETE ON wake_live_inputs
  FOR EACH ROW EXECUTE FUNCTION mira_guard_live_input();

-- Down Migration

DROP TABLE wake_live_inputs;
DROP FUNCTION mira_guard_live_input();
ALTER TABLE wake_run_requests DROP CONSTRAINT wake_run_request_identity;
