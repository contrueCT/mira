-- Up Migration

    -- One continuous Mira per slot. A reset to "从头开始" starts a new life with
    -- a new mira_id; every older life keeps its append-only rows untouched and
    -- is archived, never deleted (ADR 0047). This is not a conversation list:
    -- exactly one life per slot is active.
    CREATE TABLE mira_lives (
      mira_id text PRIMARY KEY REFERENCES mira_owners(mira_id),
      slot text NOT NULL CHECK (length(slot) > 0),
      generation integer NOT NULL CHECK (generation >= 0),
      created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      reset_id text CHECK (reset_id IS NULL OR length(reset_id) > 0),
      archived_at timestamptz,
      archive_path text,
      reset_reason text,
      UNIQUE (slot, generation),
      UNIQUE (mira_id, slot, generation),
      UNIQUE (reset_id),
      CHECK ((generation = 0) = (reset_id IS NULL)),
      CHECK (archive_path IS NULL OR archived_at IS NOT NULL)
    );
    CREATE TABLE mira_active_life (
      slot text PRIMARY KEY,
      mira_id text NOT NULL UNIQUE,
      generation integer NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      FOREIGN KEY (mira_id, slot, generation) REFERENCES mira_lives(mira_id, slot, generation)
    );
    -- The historical single local Mira becomes generation 0 of slot 'mira'.
    -- Other slots register lazily at their first reset.
    INSERT INTO mira_lives(mira_id, slot, generation) SELECT mira_id, mira_id, 0 FROM mira_owners WHERE mira_id = 'mira';
    INSERT INTO mira_active_life(slot, mira_id, generation) SELECT mira_id, mira_id, 0 FROM mira_lives WHERE mira_id = 'mira';

-- Down Migration

    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM mira_lives WHERE generation > 0) THEN
        RAISE EXCEPTION 'Refusing to drop Mira lives: a reset created later generations; restore and migrate their data manually';
      END IF;
    END
    $$;
    DROP TABLE mira_active_life;
    DROP TABLE mira_lives;
