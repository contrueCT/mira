-- Up Migration

ALTER TABLE subagents ADD CONSTRAINT subagent_stream_identity UNIQUE (child_id, stream_id);
DROP TRIGGER subagent_turn_immutable ON subagent_turns;
ALTER TABLE subagent_turns ADD COLUMN stream_id text;
UPDATE subagent_turns t SET stream_id=s.stream_id FROM subagents s WHERE s.child_id=t.child_id;
ALTER TABLE subagent_turns ALTER COLUMN stream_id SET NOT NULL;
ALTER TABLE subagent_turns ADD CONSTRAINT task_turn_stream FOREIGN KEY (child_id,stream_id) REFERENCES subagents(child_id,stream_id);
ALTER TABLE subagent_turns ADD CONSTRAINT task_turn_identity UNIQUE (turn_id,child_id,parent_mira_id);
ALTER TABLE subagent_turns ADD COLUMN input_record_id uuid;
ALTER TABLE subagent_turns ADD COLUMN final_record_id uuid;
ALTER TABLE subagent_turns ADD CONSTRAINT task_input_record FOREIGN KEY (stream_id,input_record_id) REFERENCES context_records(mira_id,record_id);
ALTER TABLE subagent_turns ADD CONSTRAINT task_final_record FOREIGN KEY (stream_id,final_record_id) REFERENCES context_records(mira_id,record_id);
ALTER TABLE subagent_turns ADD CONSTRAINT task_final_requires_input CHECK (final_record_id IS NULL OR input_record_id IS NOT NULL);

-- One immutable namespace owns every parent call, regardless of its admission route.
CREATE TABLE subagent_calls (
  parent_mira_id text NOT NULL,
  call_id text NOT NULL,
  child_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('turn','live')),
  created_at text NOT NULL,
  association_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  PRIMARY KEY (parent_mira_id,call_id),
  UNIQUE (parent_mira_id,call_id,child_id,turn_id,kind),
  FOREIGN KEY (parent_mira_id,call_id) REFERENCES tool_executions(mira_id,call_id),
  FOREIGN KEY (turn_id,child_id,parent_mira_id) REFERENCES subagent_turns(turn_id,child_id,parent_mira_id) DEFERRABLE INITIALLY DEFERRED
);
INSERT INTO subagent_calls(parent_mira_id,call_id,child_id,turn_id,kind,created_at)
  SELECT parent_mira_id,call_id,child_id,turn_id,'turn',created_at FROM subagent_turns ORDER BY association_order;
ALTER TABLE subagent_turns ADD COLUMN call_kind text GENERATED ALWAYS AS ('turn'::text) STORED;
ALTER TABLE subagent_turns ADD CONSTRAINT task_turn_call FOREIGN KEY (parent_mira_id,call_id,child_id,turn_id,call_kind)
  REFERENCES subagent_calls(parent_mira_id,call_id,child_id,turn_id,kind);
CREATE INDEX subagent_calls_by_child ON subagent_calls(parent_mira_id,child_id,association_order);
CREATE TRIGGER subagent_call_immutable BEFORE UPDATE OR DELETE ON subagent_calls
  FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();

CREATE TABLE subagent_live_inputs (
  parent_mira_id text NOT NULL,
  call_id text NOT NULL,
  child_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  stream_id text NOT NULL,
  call_kind text GENERATED ALWAYS AS ('live'::text) STORED,
  instruction text NOT NULL,
  created_at text NOT NULL,
  receipt_order bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  input_record_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','consumed','interrupted','cancelled','failed')),
  PRIMARY KEY (parent_mira_id,call_id),
  UNIQUE (stream_id,input_record_id),
  FOREIGN KEY (parent_mira_id,call_id,child_id,turn_id,call_kind) REFERENCES subagent_calls(parent_mira_id,call_id,child_id,turn_id,kind),
  FOREIGN KEY (child_id,stream_id) REFERENCES subagents(child_id,stream_id),
  FOREIGN KEY (stream_id,input_record_id) REFERENCES context_records(mira_id,record_id),
  CHECK ((status='consumed' AND input_record_id IS NOT NULL) OR (status<>'consumed' AND input_record_id IS NULL))
);
CREATE INDEX task_live_inputs_by_turn ON subagent_live_inputs(stream_id,turn_id,receipt_order);
CREATE INDEX task_live_inputs_pending ON subagent_live_inputs(child_id,receipt_order) WHERE status='pending';
CREATE FUNCTION mira_guard_task_live_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR OLD.status<>'pending' OR
     NEW.parent_mira_id IS DISTINCT FROM OLD.parent_mira_id OR NEW.call_id IS DISTINCT FROM OLD.call_id OR
     NEW.child_id IS DISTINCT FROM OLD.child_id OR NEW.turn_id IS DISTINCT FROM OLD.turn_id OR
     NEW.stream_id IS DISTINCT FROM OLD.stream_id OR NEW.instruction IS DISTINCT FROM OLD.instruction OR
     NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.receipt_order IS DISTINCT FROM OLD.receipt_order
  THEN RAISE EXCEPTION 'Task live input identity and terminal evidence are immutable'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER task_live_input_evidence_once BEFORE UPDATE OR DELETE ON subagent_live_inputs
  FOR EACH ROW EXECUTE FUNCTION mira_guard_task_live_input();
CREATE OR REPLACE FUNCTION mira_protect_subagent_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('queued','running') OR
     NEW.turn_id <> OLD.turn_id OR NEW.child_id <> OLD.child_id OR
     NEW.parent_mira_id <> OLD.parent_mira_id OR NEW.call_id <> OLD.call_id OR
     NEW.sequence <> OLD.sequence OR NEW.instruction <> OLD.instruction OR NEW.created_at <> OLD.created_at OR
     NEW.association_order <> OLD.association_order OR NEW.stream_id <> OLD.stream_id OR
     (OLD.input_record_id IS NOT NULL AND NEW.input_record_id IS DISTINCT FROM OLD.input_record_id) OR
     (OLD.final_record_id IS NOT NULL AND NEW.final_record_id IS DISTINCT FROM OLD.final_record_id)
  THEN RAISE EXCEPTION 'Subagent turn identity and terminal evidence are immutable'; END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER subagent_turn_immutable BEFORE UPDATE ON subagent_turns
  FOR EACH ROW EXECUTE FUNCTION mira_protect_subagent_turn();

-- Down Migration

DROP TABLE subagent_live_inputs;
DROP FUNCTION mira_guard_task_live_input();
ALTER TABLE subagent_turns DROP CONSTRAINT task_turn_call;
ALTER TABLE subagent_turns DROP COLUMN call_kind;
DROP TABLE subagent_calls;
CREATE OR REPLACE FUNCTION mira_protect_subagent_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('queued','running') OR
     NEW.turn_id <> OLD.turn_id OR NEW.child_id <> OLD.child_id OR
     NEW.parent_mira_id <> OLD.parent_mira_id OR NEW.call_id <> OLD.call_id OR
     NEW.sequence <> OLD.sequence OR NEW.instruction <> OLD.instruction OR NEW.created_at <> OLD.created_at OR
     NEW.association_order <> OLD.association_order
  THEN RAISE EXCEPTION 'Subagent turn identity and terminal evidence are immutable'; END IF;
  RETURN NEW;
END
$$;
ALTER TABLE subagent_turns DROP CONSTRAINT task_final_requires_input;
ALTER TABLE subagent_turns DROP COLUMN input_record_id;
ALTER TABLE subagent_turns DROP COLUMN final_record_id;
ALTER TABLE subagent_turns DROP CONSTRAINT task_turn_identity;
ALTER TABLE subagent_turns DROP COLUMN stream_id;
ALTER TABLE subagents DROP CONSTRAINT subagent_stream_identity;
