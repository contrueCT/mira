-- Up Migration

    -- One technical trigger cursor per Mira, separate from semantic Memory.
    -- Timestamps come from the writer's database clock, never source events.
    CREATE TABLE dreaming_progress (
      mira_id text PRIMARY KEY REFERENCES mira_owners(mira_id),
      last_triggered_at timestamptz NOT NULL,
      idle_since timestamptz NOT NULL,
      consumed_receipt_order bigint NOT NULL CHECK (consumed_receipt_order >= 0),
      checkpoint_version bigint NOT NULL CHECK (checkpoint_version >= 0)
    );

-- Down Migration

    DROP TABLE dreaming_progress;
