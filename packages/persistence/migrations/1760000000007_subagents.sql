-- Up Migration
CREATE TABLE subagents (
  child_id uuid PRIMARY KEY,
  parent_mira_id text NOT NULL REFERENCES mira_owners(mira_id),
  stream_id text NOT NULL UNIQUE,
  spawn_call_id text NOT NULL,
  created_at text NOT NULL,
  spec json NOT NULL,
  UNIQUE (parent_mira_id, spawn_call_id),
  UNIQUE (child_id, parent_mira_id),
  FOREIGN KEY (parent_mira_id, spawn_call_id) REFERENCES tool_executions(mira_id, call_id)
);
CREATE TABLE subagent_turns (
  turn_id uuid PRIMARY KEY,
  child_id uuid NOT NULL,
  parent_mira_id text NOT NULL REFERENCES mira_owners(mira_id),
  call_id text NOT NULL,
  sequence integer NOT NULL CHECK (sequence > 0),
  instruction text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','completed','interrupted','cancelled','failed')),
  created_at text NOT NULL,
  finished_at text,
  result json,
  UNIQUE (parent_mira_id, call_id),
  UNIQUE (child_id, sequence),
  FOREIGN KEY (child_id, parent_mira_id) REFERENCES subagents(child_id, parent_mira_id),
  FOREIGN KEY (parent_mira_id, call_id) REFERENCES tool_executions(mira_id, call_id),
  CHECK ((status IN ('queued','running') AND finished_at IS NULL AND result IS NULL)
      OR (status NOT IN ('queued','running') AND finished_at IS NOT NULL AND result IS NOT NULL))
);
CREATE UNIQUE INDEX subagent_one_running ON subagent_turns(child_id) WHERE status = 'running';

CREATE FUNCTION mira_protect_subagent_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('queued','running') OR
     NEW.turn_id <> OLD.turn_id OR NEW.child_id <> OLD.child_id OR
     NEW.parent_mira_id <> OLD.parent_mira_id OR NEW.call_id <> OLD.call_id OR
     NEW.sequence <> OLD.sequence OR NEW.instruction <> OLD.instruction OR NEW.created_at <> OLD.created_at
  THEN RAISE EXCEPTION 'Subagent turn identity and terminal evidence are immutable'; END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER subagent_identity_immutable BEFORE UPDATE OR DELETE ON subagents
  FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();
CREATE TRIGGER subagent_turn_immutable BEFORE UPDATE ON subagent_turns
  FOR EACH ROW EXECUTE FUNCTION mira_protect_subagent_turn();
CREATE TRIGGER subagent_turn_no_delete BEFORE DELETE ON subagent_turns
  FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();

-- Down Migration
DROP TABLE subagent_turns;
DROP TABLE subagents;
DROP FUNCTION mira_protect_subagent_turn();
