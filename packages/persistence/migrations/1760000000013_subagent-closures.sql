-- Up Migration

-- ADR 0052: Mira explicitly closed a child it no longer needs. Append-only;
-- the child's registry, turns and transcript stay untouched and readable.
-- A closed child accepts no further instructions.
CREATE TABLE subagent_closures (
  child_id uuid PRIMARY KEY,
  parent_mira_id text NOT NULL,
  call_id text NOT NULL,
  closed_at text NOT NULL,
  FOREIGN KEY (child_id, parent_mira_id) REFERENCES subagents(child_id, parent_mira_id),
  UNIQUE (parent_mira_id, call_id)
);
CREATE TRIGGER subagent_closure_immutable BEFORE UPDATE OR DELETE ON subagent_closures
  FOR EACH ROW EXECUTE FUNCTION mira_reject_history_change();

-- Down Migration

DROP TABLE subagent_closures;
