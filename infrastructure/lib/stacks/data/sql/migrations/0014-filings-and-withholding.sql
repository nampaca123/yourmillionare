-- Migration 0014: filing obligations, withholding-tax queue, tax invoices, and penalty simulations. Layer-1 tax operations.

CREATE TYPE filing_kind AS ENUM (
  'VAT_PRELIM',
  'VAT_FINAL',
  'VAT_PREPAYMENT_NOTICE',
  'WH_MONTHLY',
  'WH_SEMIANNUAL',
  'WH_PAYMENT_STATEMENT',
  'CORP_INTERIM',
  'CORP_FINAL',
  'LOCAL_INCOME'
);

CREATE TYPE filing_status AS ENUM ('pending', 'drafted', 'filed', 'skipped');

CREATE TABLE IF NOT EXISTS filing_obligation (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind               filing_kind   NOT NULL,
  period_start       DATE          NOT NULL,
  period_end         DATE          NOT NULL,
  statutory_due_date DATE          NOT NULL,
  business_due_date  DATE          NOT NULL,
  status             filing_status NOT NULL DEFAULT 'pending',
  draft_payload      JSONB,
  draft_s3_key       TEXT,
  filed_at           TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, kind, period_start, period_end),
  CHECK (period_end >= period_start),
  CHECK (business_due_date >= statutory_due_date)
);

CREATE INDEX IF NOT EXISTS idx_filing_due
  ON filing_obligation(tenant_id, business_due_date)
  WHERE status = 'pending';

COMMENT ON TABLE  filing_obligation                  IS 'Per-tenant tax-filing calendar. business_due_date = statutory_due_date rolled forward over weekends/holidays via holiday_cache';
COMMENT ON COLUMN filing_obligation.business_due_date IS 'Effective due date after holiday roll-forward. Drives D-14/D-7/D-3 notifications';
COMMENT ON COLUMN filing_obligation.draft_payload   IS 'Structured JSON for the filing form (별지 boxes). Populated by recompute_filing_draft and rebuilt on transaction edits';

CREATE TABLE IF NOT EXISTS filing_applied_rule (
  filing_obligation_id UUID NOT NULL REFERENCES filing_obligation(id) ON DELETE CASCADE,
  rule_id              UUID NOT NULL REFERENCES tax_rule(id),
  PRIMARY KEY (filing_obligation_id, rule_id)
);

CREATE INDEX IF NOT EXISTS idx_filing_applied_rule_rule ON filing_applied_rule(rule_id);

COMMENT ON TABLE filing_applied_rule IS 'Normalised join: which tax_rule rows fed each filing draft. Replaces UUID[] column for audit and rule-impact analysis';

CREATE TABLE IF NOT EXISTS filing_cited_chunk (
  filing_obligation_id UUID         NOT NULL REFERENCES filing_obligation(id) ON DELETE CASCADE,
  chunk_id             UUID         NOT NULL REFERENCES tax_law_chunk_meta(id),
  rerank_score         NUMERIC(5,4),
  PRIMARY KEY (filing_obligation_id, chunk_id)
);

CREATE INDEX IF NOT EXISTS idx_filing_cited_chunk_chunk ON filing_cited_chunk(chunk_id);

COMMENT ON TABLE filing_cited_chunk IS 'Normalised join: which KB chunks were cited in the filing draft response. Drives the API verification.citedChunks field';

CREATE TYPE withholding_income_type AS ENUM (
  'BUSINESS_INCOME',
  'OTHER_INCOME',
  'EMPLOYMENT',
  'DAILY_EMPLOYMENT',
  'INTEREST',
  'DIVIDEND'
);

CREATE TYPE withholding_status AS ENUM ('pending', 'filed', 'dismissed');

CREATE TYPE withholding_detection AS ENUM ('heuristic', 'bedrock', 'user_manual');

CREATE TABLE IF NOT EXISTS withholding_payment (
  id                UUID                    PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID                    NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payee_label       TEXT                    NOT NULL,
  payee_biz_no      VARCHAR(20),
  income_type       withholding_income_type NOT NULL,
  gross_amount      NUMERIC(18,2)           NOT NULL CHECK (gross_amount > 0),
  income_tax        NUMERIC(18,2)           NOT NULL CHECK (income_tax >= 0),
  local_income_tax  NUMERIC(18,2)           NOT NULL CHECK (local_income_tax >= 0),
  payment_date      DATE                    NOT NULL,
  filing_due_date   DATE                    NOT NULL,
  source_ref_id    UUID                    REFERENCES raw_transactions(id),
  status            withholding_status      NOT NULL DEFAULT 'pending',
  detected_by       withholding_detection   NOT NULL DEFAULT 'heuristic',
  filed_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ             NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_withholding_pending
  ON withholding_payment(tenant_id, filing_due_date)
  WHERE status = 'pending';

COMMENT ON TABLE  withholding_payment             IS '원천세 queue. Outbound transfers detected as 사업소득 (3.3%) etc. are auto-inserted by the heuristic classifier and reviewed by user before file';
COMMENT ON COLUMN withholding_payment.filing_due_date IS 'Payment-date + 1 month, 10th day. Rolls forward via holiday_cache';

CREATE TYPE tax_invoice_direction AS ENUM ('SALE', 'PURCHASE');

CREATE TABLE IF NOT EXISTS tax_invoice (
  id                    UUID                  PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID                  NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  direction             tax_invoice_direction NOT NULL,
  supplier_biz_no       VARCHAR(20),
  buyer_biz_no          VARCHAR(20),
  supply_amount         NUMERIC(18,2)         NOT NULL CHECK (supply_amount >= 0),
  vat_amount            NUMERIC(18,2)         NOT NULL CHECK (vat_amount >= 0),
  written_date          DATE                  NOT NULL,
  issued_at             TIMESTAMPTZ,
  transmitted_at        TIMESTAMPTZ,
  doc_type              VARCHAR(30)           NOT NULL,
  is_zero_rate          BOOLEAN               NOT NULL DEFAULT FALSE,
  zero_rate_evidence_s3 TEXT,
  is_deductible         BOOLEAN               NOT NULL DEFAULT TRUE,
  non_deductible_reason VARCHAR(50),
  external_id           VARCHAR(255),
  raw_payload           JSONB,
  CHECK (NOT is_zero_rate OR zero_rate_evidence_s3 IS NOT NULL),
  UNIQUE (tenant_id, direction, supplier_biz_no, buyer_biz_no, written_date, supply_amount, external_id)
);

CREATE INDEX IF NOT EXISTS idx_tax_invoice_tenant_date
  ON tax_invoice(tenant_id, direction, written_date);

COMMENT ON TABLE  tax_invoice                       IS 'CODEF 전자세금계산서 통합 + supplemental docs (사업용신용카드, 현금영수증). Locked by is_zero_rate CHECK: 영세율 requires evidence S3 attachment';
COMMENT ON COLUMN tax_invoice.doc_type             IS '전자세금계산서|사업용신용카드|지출증빙현금영수증|수입세금계산서';
COMMENT ON COLUMN tax_invoice.non_deductible_reason IS 'When is_deductible=FALSE: 접대비|비영업용승용차|면세사업매입|필요적기재사항누락';

CREATE TYPE penalty_kind AS ENUM (
  'LATE_PAYMENT',
  'UNREPORTED',
  'UNDERREPORTED',
  'ZERO_RATE_VIOLATION',
  'TAX_INVOICE_LATE_ISSUE',
  'TAX_INVOICE_NOT_ISSUED',
  'WITHHOLDING_LATE_PAYMENT'
);

CREATE TABLE IF NOT EXISTS penalty_calculation (
  id                   UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID          NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  filing_obligation_id UUID          REFERENCES filing_obligation(id),
  kind                 penalty_kind  NOT NULL,
  base_amount          NUMERIC(18,2) NOT NULL CHECK (base_amount >= 0),
  rate                 NUMERIC(8,6)  NOT NULL CHECK (rate >= 0),
  rule_id              UUID          REFERENCES tax_rule(id),
  days_late            INTEGER       NOT NULL DEFAULT 0 CHECK (days_late >= 0),
  computed_amount      NUMERIC(18,2) NOT NULL CHECK (computed_amount >= 0),
  computed_at          TIMESTAMPTZ   NOT NULL DEFAULT now(),
  as_of_date           DATE          NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_penalty_tenant
  ON penalty_calculation(tenant_id, computed_at DESC);

COMMENT ON TABLE penalty_calculation IS 'Recomputed on each filing draft refresh. Always treated as an estimate — disclaimers enforced by API layer';

ALTER TABLE filing_obligation    ENABLE ROW LEVEL SECURITY;
ALTER TABLE filing_applied_rule  ENABLE ROW LEVEL SECURITY;
ALTER TABLE filing_cited_chunk   ENABLE ROW LEVEL SECURITY;
ALTER TABLE withholding_payment  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_invoice          ENABLE ROW LEVEL SECURITY;
ALTER TABLE penalty_calculation  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON filing_obligation;
CREATE POLICY tenant_isolation ON filing_obligation
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));

DROP POLICY IF EXISTS filing_applied_rule_isolation ON filing_applied_rule;
CREATE POLICY filing_applied_rule_isolation ON filing_applied_rule
  FOR ALL TO app_user
  USING (
    EXISTS (
      SELECT 1 FROM filing_obligation fo
      WHERE fo.id = filing_applied_rule.filing_obligation_id
        AND fo.tenant_id = app_uuid_from_setting('app.current_tenant_id')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM filing_obligation fo
      WHERE fo.id = filing_applied_rule.filing_obligation_id
        AND fo.tenant_id = app_uuid_from_setting('app.current_tenant_id')
    )
  );

DROP POLICY IF EXISTS filing_cited_chunk_isolation ON filing_cited_chunk;
CREATE POLICY filing_cited_chunk_isolation ON filing_cited_chunk
  FOR ALL TO app_user
  USING (
    EXISTS (
      SELECT 1 FROM filing_obligation fo
      WHERE fo.id = filing_cited_chunk.filing_obligation_id
        AND fo.tenant_id = app_uuid_from_setting('app.current_tenant_id')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM filing_obligation fo
      WHERE fo.id = filing_cited_chunk.filing_obligation_id
        AND fo.tenant_id = app_uuid_from_setting('app.current_tenant_id')
    )
  );

DROP POLICY IF EXISTS tenant_isolation ON withholding_payment;
CREATE POLICY tenant_isolation ON withholding_payment
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));

DROP POLICY IF EXISTS tenant_isolation ON tax_invoice;
CREATE POLICY tenant_isolation ON tax_invoice
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));

DROP POLICY IF EXISTS tenant_isolation ON penalty_calculation;
CREATE POLICY tenant_isolation ON penalty_calculation
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));
