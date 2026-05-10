-- Migration 0010: personal-tenant support + bank-connection table.
-- Note: ALTER TYPE ADD VALUE must run outside a transaction (Postgres requirement).
-- Apply this migration in two psql invocations or split if your runner wraps in a tx.

ALTER TABLE tenants ALTER COLUMN biz_reg_no_encrypted DROP NOT NULL;
ALTER TABLE tenants ALTER COLUMN biz_reg_no_hash      DROP NOT NULL;

ALTER TYPE business_type ADD VALUE IF NOT EXISTS 'personal';

ALTER TABLE tenant_bank_accounts ADD COLUMN IF NOT EXISTS connected_id VARCHAR(100);

CREATE TABLE IF NOT EXISTS tenant_bank_connections (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization  CHAR(4)      NOT NULL,
  connected_id  VARCHAR(100) NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization)
);

ALTER TABLE tenant_bank_connections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_bank_connections;
CREATE POLICY tenant_isolation ON tenant_bank_connections
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));

DROP POLICY IF EXISTS system_select ON tenant_bank_connections;
CREATE POLICY system_select ON tenant_bank_connections
  FOR SELECT TO app_user
  USING (current_setting('app.cognito_sub', true) = 'system');
