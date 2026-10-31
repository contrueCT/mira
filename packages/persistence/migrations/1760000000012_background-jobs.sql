-- Up Migration

-- Backgrounded foreground tool calls (ADR 0049). A job is an append-only
-- `tool.background.started` event; its single result event (settled or lost)
-- has the derived ID ["tool-background-result","<jobId>"]. Startup finds the
-- started events that still lack a result without scanning all of History.
CREATE INDEX life_events_background_started ON life_events (mira_id) WHERE (event->>'type') = 'tool.background.started';

-- Down Migration

DROP INDEX life_events_background_started;
