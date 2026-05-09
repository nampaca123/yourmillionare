ALTER TABLE raw_transactions ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_raw_undispatched
  ON raw_transactions(tenant_id, dispatched_at)
  WHERE dispatched_at IS NULL;
