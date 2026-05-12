-- Migration 0011: extend tenants with corporation-profile fields, add doc/FX columns to raw_transactions, and receivable kanban columns to journal_entries.
-- Note: ALTER TYPE ADD VALUE must run outside a transaction (Postgres requirement).

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS industry_code           VARCHAR(10);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_youth_founder        BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_venture_certified    BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS is_external_audit       BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS vat_prepayment_recipient BOOLEAN    NOT NULL DEFAULT FALSE;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS withholding_cadence     VARCHAR(20) NOT NULL DEFAULT 'MONTHLY'
  CHECK (withholding_cadence IN ('MONTHLY', 'SEMIANNUAL'));
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prior_year_corp_tax     NUMERIC(18,2);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS prior_year_revenue      NUMERIC(18,2);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS profile_updated_at      TIMESTAMPTZ;

COMMENT ON COLUMN tenants.industry_code            IS 'Korea standard industry code (KSIC). Drives 조특법 eligibility for §6 youth/regional incentives';
COMMENT ON COLUMN tenants.is_youth_founder         IS '청년창업자 (만 15~34세). 조특법 §6 ① reduced/exempt rate eligibility flag';
COMMENT ON COLUMN tenants.is_venture_certified    IS '벤처기업 확인 (벤처기업협회). 조특법 §6-2 등 추가 감면 자격 여부';
COMMENT ON COLUMN tenants.is_external_audit       IS 'External audit obligation. Affects disclosure scope and 외감대상 thresholds';
COMMENT ON COLUMN tenants.vat_prepayment_recipient IS 'Small corporation receiving NTS 예정고지 (직전 공급가액 < 1.5억). Skips 예정신고 to avoid duplicate filing';
COMMENT ON COLUMN tenants.withholding_cadence     IS 'Withholding tax filing cadence: MONTHLY (default) or SEMIANNUAL (≤20 employees, NTS approval required)';
COMMENT ON COLUMN tenants.prior_year_corp_tax     IS 'Prior fiscal year corporate tax. Drives 중간예납 전기기준법 (½ of prior 산출세액) for upcoming interim filing';
COMMENT ON COLUMN tenants.prior_year_revenue      IS 'Prior fiscal year revenue. Drives 외감대상 / 일반과세 thresholds';

ALTER TABLE raw_transactions ADD COLUMN IF NOT EXISTS doc_type            VARCHAR(30);
ALTER TABLE raw_transactions ADD COLUMN IF NOT EXISTS counterparty_biz_no VARCHAR(20);
ALTER TABLE raw_transactions ADD COLUMN IF NOT EXISTS fx_rate             NUMERIC(14,6);

COMMENT ON COLUMN raw_transactions.doc_type            IS 'Evidence type: 전자세금계산서|사업용신용카드|지출증빙현금영수증|수입세금계산서|일반. Drives VAT deduction eligibility';
COMMENT ON COLUMN raw_transactions.counterparty_biz_no IS 'Korean BRN of the counterparty (10 digits). Required for 전자세금계산서 reconciliation and 사업소득 detection';
COMMENT ON COLUMN raw_transactions.fx_rate             IS 'IAS 21 transaction-date FX rate (1 fcy = fx_rate × KRW). Null when fcy_currency is null';

CREATE TYPE receivable_status AS ENUM ('PENDING', 'DUE_SOON', 'OVERDUE', 'COLLECTED');

ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS receivable_status       receivable_status;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS receivable_due_date     DATE;
ALTER TABLE journal_entries ADD COLUMN IF NOT EXISTS receivable_counterparty TEXT;

CREATE INDEX IF NOT EXISTS idx_journal_entries_receivable
  ON journal_entries(tenant_id, receivable_status, receivable_due_date)
  WHERE receivable_status IS NOT NULL;

COMMENT ON COLUMN journal_entries.receivable_status       IS 'Kanban view of 매출채권. NULL when the entry has no AR line';
COMMENT ON COLUMN journal_entries.receivable_due_date     IS 'Expected collection date. Drives DUE_SOON (within 7d) and OVERDUE transitions';
COMMENT ON COLUMN journal_entries.receivable_counterparty IS 'Display label for the kanban card (payer name)';

CREATE TABLE IF NOT EXISTS journal_entry_draft (
  raw_transaction_id   UUID PRIMARY KEY REFERENCES raw_transactions(id) ON DELETE CASCADE,
  tenant_id            UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  draft_lines          JSONB        NOT NULL,
  heuristic_confidence NUMERIC(4,3) CHECK (heuristic_confidence IS NULL OR heuristic_confidence BETWEEN 0 AND 1),
  rule_id              VARCHAR(50),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_journal_entry_draft_tenant ON journal_entry_draft(tenant_id);

COMMENT ON TABLE  journal_entry_draft IS 'Heuristic 1st-pass classification (counterparty regex + amount band). Overwritten by Bedrock classifier on the same raw_transaction_id';
COMMENT ON COLUMN journal_entry_draft.rule_id IS 'Identifier of the heuristic rule that produced this draft (e.g., counterparty:^스타벅스)';

ALTER TABLE journal_entry_draft ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON journal_entry_draft;
CREATE POLICY tenant_isolation ON journal_entry_draft
  FOR ALL TO app_user
  USING      (tenant_id = app_uuid_from_setting('app.current_tenant_id'))
  WITH CHECK (tenant_id = app_uuid_from_setting('app.current_tenant_id'));
