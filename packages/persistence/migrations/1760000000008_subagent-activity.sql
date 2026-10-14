-- Up Migration
ALTER TABLE subagent_turns ADD COLUMN started_at text;
ALTER TABLE subagent_turns ADD COLUMN activity jsonb NOT NULL DEFAULT '{"current":null,"events":[],"dropped":0,"updatedAt":null}'::jsonb;
ALTER TABLE subagent_turns ADD CONSTRAINT subagent_activity_bounded CHECK (octet_length(activity::text) <= 131072);

-- Down Migration
ALTER TABLE subagent_turns DROP CONSTRAINT subagent_activity_bounded;
ALTER TABLE subagent_turns DROP COLUMN activity;
ALTER TABLE subagent_turns DROP COLUMN started_at;
