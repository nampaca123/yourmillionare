-- Migration 0012: effective-dated tax_rule table with dual approval, audit log, and review queue. Layer 1 of the dynamic-tax-law architecture.

CREATE TABLE IF NOT EXISTS tax_rule (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_kind          VARCHAR(50)  NOT NULL,
  bracket_from       NUMERIC(18,2),
  bracket_to         NUMERIC(18,2),
  rate               NUMERIC(8,6) NOT NULL CHECK (rate >= 0),
  effective_from     DATE         NOT NULL,
  effective_to       DATE,
  legal_basis        TEXT         NOT NULL,
  legal_basis_law_id VARCHAR(20),
  legal_basis_mst    VARCHAR(20),
  source_url         TEXT,
  source_evidence_s3 TEXT,
  approved_at        TIMESTAMPTZ,
  notes              TEXT,
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (
    (bracket_from IS NULL AND bracket_to IS NULL)
    OR (bracket_from IS NOT NULL AND (bracket_to IS NULL OR bracket_to >= bracket_from))
  )
);

CREATE INDEX IF NOT EXISTS idx_tax_rule_lookup
  ON tax_rule(rule_kind, effective_from, effective_to);

CREATE INDEX IF NOT EXISTS idx_tax_rule_pending_review
  ON tax_rule(rule_kind, created_at) WHERE approved_at IS NULL;

COMMENT ON TABLE  tax_rule                    IS 'Effective-dated tax rates for deterministic calculators. Rate-change is INSERT (new row) + UPDATE (close prior effective_to) inside one transaction';
COMMENT ON COLUMN tax_rule.rule_kind          IS 'Discriminator: VAT_STANDARD|VAT_ZERO_RATE|CORP_TAX_BRACKET|WH_BUSINESS_INCOME|WH_OTHER_INCOME|LOCAL_INCOME|PENALTY_LATE_PAY|PENALTY_UNREPORTED|PENALTY_TAX_INVOICE_LATE|...';
COMMENT ON COLUMN tax_rule.bracket_from       IS 'Lower bound (KRW) for progressive brackets (e.g., 0 / 200000000 / 20000000000 for corporate tax). Null for flat rates';
COMMENT ON COLUMN tax_rule.bracket_to         IS 'Upper bound (KRW, exclusive). Null when this is the top bracket';
COMMENT ON COLUMN tax_rule.rate               IS 'Fraction 0..1. 10%=0.100000, 0.022%/day=0.000220. Calculators receive this as an input — they never hardcode rates';
COMMENT ON COLUMN tax_rule.effective_from     IS 'First date this rate applies. For 2026-01-01 corporate tax 1pp hike: effective_from=2026-01-01, prior rows get effective_to=2025-12-31';
COMMENT ON COLUMN tax_rule.effective_to       IS 'Last date this rate applies (inclusive). Null means current/open-ended';
COMMENT ON COLUMN tax_rule.legal_basis        IS 'Human-readable citation, e.g. "법인세법 §55 ①"';
COMMENT ON COLUMN tax_rule.legal_basis_law_id IS 'Joins to tax_law_chunk_meta.law_id (Layer-2 KB)';
COMMENT ON COLUMN tax_rule.legal_basis_mst    IS 'Joins to tax_law_chunk_meta.mst — pins the exact revision used for this rate';
COMMENT ON COLUMN tax_rule.approved_at        IS 'Set by trigger only after 2 distinct admins approve. Responses use NULL=unverified to populate verification.allRulesApproved=false';

CREATE TABLE IF NOT EXISTS tax_rule_approval (
  rule_id           UUID         NOT NULL REFERENCES tax_rule(id) ON DELETE CASCADE,
  approver_user_id  UUID         NOT NULL REFERENCES users(id),
  approved_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  notes             TEXT,
  PRIMARY KEY (rule_id, approver_user_id)
);

COMMENT ON TABLE tax_rule_approval IS 'Dual-approval ledger. Composite PK enforces that the same admin cannot approve twice (DB-level guard)';

CREATE TABLE IF NOT EXISTS tax_rule_change_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id       UUID         NOT NULL,
  actor_user_id UUID         REFERENCES users(id),
  action        VARCHAR(30)  NOT NULL,
  old_value     JSONB,
  new_value     JSONB,
  reason        TEXT,
  changed_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tax_rule_change_log_rule ON tax_rule_change_log(rule_id, changed_at DESC);

COMMENT ON TABLE tax_rule_change_log IS 'Append-only audit trail for tax_rule INSERT/UPDATE/EFFECTIVE_TO_SET/APPROVE/REJECT actions. Actor is set from app.current_user_id GUC';

CREATE TABLE IF NOT EXISTS tax_rule_review_request (
  id                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_kind          VARCHAR(50),
  triggered_by       VARCHAR(20)  NOT NULL CHECK (triggered_by IN ('lsHstInf', 'eflaw', 'delHst', 'manual')),
  detected_at        TIMESTAMPTZ  NOT NULL DEFAULT now(),
  legal_basis_law_id VARCHAR(20),
  legal_basis_mst    VARCHAR(20),
  status             VARCHAR(20)  NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  resolved_rule_id   UUID         REFERENCES tax_rule(id),
  resolved_at        TIMESTAMPTZ,
  notes              TEXT
);

CREATE INDEX IF NOT EXISTS idx_tax_rule_review_pending
  ON tax_rule_review_request(detected_at DESC) WHERE status = 'pending';

COMMENT ON TABLE tax_rule_review_request IS 'Tax-law-sync detected events that require human review (lsHstInf/eflaw/delHst). Gates kb_chunk_active activation until resolved';

CREATE OR REPLACE FUNCTION fn_tax_rule_audit()
RETURNS TRIGGER AS $$
DECLARE
  actor UUID;
BEGIN
  actor := app_uuid_from_setting('app.current_user_id');
  IF TG_OP = 'INSERT' THEN
    INSERT INTO tax_rule_change_log (rule_id, actor_user_id, action, new_value)
    VALUES (NEW.id, actor, 'INSERT', to_jsonb(NEW));
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO tax_rule_change_log (rule_id, actor_user_id, action, old_value, new_value)
    VALUES (NEW.id, actor, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW));
    NEW.updated_at := now();
    RETURN NEW;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tax_rule_audit ON tax_rule;
CREATE TRIGGER trg_tax_rule_audit
  BEFORE INSERT OR UPDATE ON tax_rule
  FOR EACH ROW
  EXECUTE FUNCTION fn_tax_rule_audit();

CREATE OR REPLACE FUNCTION fn_tax_rule_dual_approval()
RETURNS TRIGGER AS $$
DECLARE
  approver_count INTEGER;
  target_rule_id UUID;
BEGIN
  target_rule_id := NEW.rule_id;
  SELECT COUNT(DISTINCT approver_user_id)
    INTO approver_count
    FROM tax_rule_approval
   WHERE rule_id = target_rule_id;
  IF approver_count >= 2 THEN
    UPDATE tax_rule
       SET approved_at = now()
     WHERE id = target_rule_id AND approved_at IS NULL;
    INSERT INTO tax_rule_change_log (rule_id, actor_user_id, action, reason)
    VALUES (target_rule_id, NEW.approver_user_id, 'APPROVE', 'Second distinct approver reached');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tax_rule_dual_approval ON tax_rule_approval;
CREATE TRIGGER trg_tax_rule_dual_approval
  AFTER INSERT ON tax_rule_approval
  FOR EACH ROW
  EXECUTE FUNCTION fn_tax_rule_dual_approval();

ALTER TABLE tax_rule                ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rule_approval       ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rule_change_log     ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rule_review_request ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_rule_global_select ON tax_rule;
CREATE POLICY tax_rule_global_select ON tax_rule
  FOR SELECT TO app_user
  USING (TRUE);

DROP POLICY IF EXISTS tax_rule_admin_write ON tax_rule;
CREATE POLICY tax_rule_admin_write ON tax_rule
  FOR ALL TO app_user
  USING      (current_setting('app.is_tax_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_tax_admin', true) = 'true');

DROP POLICY IF EXISTS tax_rule_approval_admin_only ON tax_rule_approval;
CREATE POLICY tax_rule_approval_admin_only ON tax_rule_approval
  FOR ALL TO app_user
  USING      (current_setting('app.is_tax_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_tax_admin', true) = 'true');

DROP POLICY IF EXISTS tax_rule_change_log_admin_select ON tax_rule_change_log;
CREATE POLICY tax_rule_change_log_admin_select ON tax_rule_change_log
  FOR SELECT TO app_user
  USING (current_setting('app.is_tax_admin', true) = 'true');

DROP POLICY IF EXISTS tax_rule_review_request_admin_only ON tax_rule_review_request;
CREATE POLICY tax_rule_review_request_admin_only ON tax_rule_review_request
  FOR ALL TO app_user
  USING      (current_setting('app.is_tax_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_tax_admin', true) = 'true');
