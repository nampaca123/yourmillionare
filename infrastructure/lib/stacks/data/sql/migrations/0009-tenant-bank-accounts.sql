CREATE TABLE tenant_bank_accounts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  organization   CHAR(4)     NOT NULL,
  account_number VARCHAR(50) NOT NULL,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, organization, account_number)
);

ALTER TABLE tenant_bank_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON tenant_bank_accounts
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));

CREATE POLICY system_select ON tenant_bank_accounts
  FOR SELECT TO app_user
  USING (current_setting('app.cognito_sub', true) = 'system');
