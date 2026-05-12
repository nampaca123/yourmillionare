-- Migration 0019: sync_run + sync_run_account tables for diagnostic visibility into manual/scheduled bank sync attempts.

CREATE TABLE IF NOT EXISTS sync_run (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  triggered_by        VARCHAR(20)  NOT NULL CHECK (triggered_by IN ('manual', 'schedule')),
  triggered_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  status              VARCHAR(20)  NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'timed_out')),
  sfn_execution_arn   TEXT,
  total_accounts      INTEGER      NOT NULL DEFAULT 0,
  success_count       INTEGER      NOT NULL DEFAULT 0,
  error_count         INTEGER      NOT NULL DEFAULT 0,
  empty_count         INTEGER      NOT NULL DEFAULT 0,
  user_summary        TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_run_tenant_triggered
  ON sync_run (tenant_id, triggered_at DESC);

COMMENT ON TABLE  sync_run IS 'One row per bank sync attempt (manual or scheduled). Drives /sync/runs polling endpoint to surface async outcomes.';
COMMENT ON COLUMN sync_run.status IS 'queued (inserted) → running (lambda entered) → completed | failed | timed_out (terminal).';
COMMENT ON COLUMN sync_run.user_summary IS 'Human-readable rollup across accounts (e.g., "1 success, 1 needs action"). Surface in UI.';

ALTER TABLE sync_run ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sync_run;
CREATE POLICY tenant_isolation ON sync_run
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));

CREATE TABLE IF NOT EXISTS sync_run_account (
  id                  BIGSERIAL    PRIMARY KEY,
  sync_run_id         UUID         NOT NULL REFERENCES sync_run(id) ON DELETE CASCADE,
  tenant_id           UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization        CHAR(4)      NOT NULL,
  account_number      TEXT,
  outcome             VARCHAR(20)  NOT NULL
    CHECK (outcome IN ('success', 'no_connection', 'codef_error', 'empty_result', 'balance_only')),
  codef_error_code    VARCHAR(20),
  codef_error_message TEXT,
  user_message        TEXT,
  fetched_count       INTEGER      NOT NULL DEFAULT 0,
  balance_updated     BOOLEAN      NOT NULL DEFAULT FALSE,
  recorded_at         TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sync_run_account_run ON sync_run_account (sync_run_id);

COMMENT ON TABLE  sync_run_account IS 'Per-account outcome inside a sync_run. 5 outcomes cover the previously-conflated "0 transactions" silent paths.';
COMMENT ON COLUMN sync_run_account.outcome IS 'success | no_connection | codef_error | empty_result | balance_only.';
COMMENT ON COLUMN sync_run_account.user_message IS 'Pre-mapped Korean user-facing message for codef_error / no_connection (e.g., NH e-농협 조회계좌 등록 안내).';

ALTER TABLE sync_run_account ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sync_run_account;
CREATE POLICY tenant_isolation ON sync_run_account
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));
