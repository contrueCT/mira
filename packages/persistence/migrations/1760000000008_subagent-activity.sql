-- Up Migration
ALTER TABLE subagent_turns ADD COLUMN association_order bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE subagent_turns ADD CONSTRAINT subagent_association_order_unique UNIQUE (association_order);
ALTER TABLE subagent_turns ADD COLUMN started_at text;
ALTER TABLE subagent_turns ADD COLUMN activity jsonb NOT NULL DEFAULT '{"current":null,"events":[],"dropped":0,"updatedAt":null}'::jsonb;
ALTER TABLE subagent_turns ADD CONSTRAINT subagent_activity_bounded CHECK (octet_length(activity::text) <= 131072);

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

-- Down Migration
CREATE OR REPLACE FUNCTION mira_protect_subagent_turn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status NOT IN ('queued','running') OR
     NEW.turn_id <> OLD.turn_id OR NEW.child_id <> OLD.child_id OR
     NEW.parent_mira_id <> OLD.parent_mira_id OR NEW.call_id <> OLD.call_id OR
     NEW.sequence <> OLD.sequence OR NEW.instruction <> OLD.instruction OR NEW.created_at <> OLD.created_at
  THEN RAISE EXCEPTION 'Subagent turn identity and terminal evidence are immutable'; END IF;
  RETURN NEW;
END
$$;
ALTER TABLE subagent_turns DROP CONSTRAINT subagent_association_order_unique;
ALTER TABLE subagent_turns DROP COLUMN association_order;
ALTER TABLE subagent_turns DROP CONSTRAINT subagent_activity_bounded;
ALTER TABLE subagent_turns DROP COLUMN activity;
ALTER TABLE subagent_turns DROP COLUMN started_at;
