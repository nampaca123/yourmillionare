CREATE TABLE ai_decisions (
  entry_id          UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  tenant_id         UUID NOT NULL,
  model             VARCHAR(50) NOT NULL,
  input_tokens      INT,
  output_tokens     INT,
  confidence        NUMERIC(4, 3),
  user_corrected    BOOLEAN NOT NULL DEFAULT FALSE,
  corrected_at      TIMESTAMPTZ,
  correction_diff   JSONB,
  PRIMARY KEY (entry_id)
);

ALTER TABLE ai_decisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON ai_decisions FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));
