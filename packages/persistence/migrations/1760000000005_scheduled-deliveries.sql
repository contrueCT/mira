-- Up Migration

    -- Only opaque one-shot deliveries. The existing fenced Mira writer owns
    -- mutations and atomic publication into the ordinary Event/Wake queue.
    CREATE TABLE scheduled_deliveries (
      mira_id text NOT NULL REFERENCES mira_owners(mira_id),
      owner_id text NOT NULL CHECK (length(owner_id) > 0),
      schedule_key text NOT NULL CHECK (length(schedule_key) > 0),
      version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'enqueued', 'cancelled', 'expired')),
      due_at timestamptz NOT NULL,
      expires_at timestamptz CHECK (expires_at >= due_at),
      input json NOT NULL,
      created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      updated_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
      PRIMARY KEY (mira_id, owner_id, schedule_key)
    );
    CREATE INDEX scheduled_deliveries_pending_due ON scheduled_deliveries(mira_id, owner_id, due_at) WHERE status = 'pending';

-- Down Migration

    DROP TABLE scheduled_deliveries;
