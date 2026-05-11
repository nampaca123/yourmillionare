-- Migration 0013: Layer-2 metadata (tax-law sync state + KB chunk index) and dynamic holiday cache.

CREATE TABLE IF NOT EXISTS tax_law_sync_state (
  law_id                  VARCHAR(20)  PRIMARY KEY,
  law_name                VARCHAR(200) NOT NULL,
  target_code             VARCHAR(20)  NOT NULL,
  current_mst             VARCHAR(20),
  effective_from          DATE,
  last_synced_at          TIMESTAMPTZ,
  pending_revision_mst    VARCHAR(20),
  pending_effective_from  DATE,
  consecutive_failures    INTEGER      NOT NULL DEFAULT 0,
  last_failure_at         TIMESTAMPTZ,
  last_failure_reason     TEXT,
  kb_chunk_active         BOOLEAN      NOT NULL DEFAULT TRUE,
  notes                   TEXT
);

COMMENT ON TABLE  tax_law_sync_state                   IS 'One row per tracked law/decree. LegalSyncStateMachine updates current_mst on success, increments consecutive_failures on fetch error (alarm at 3)';
COMMENT ON COLUMN tax_law_sync_state.target_code       IS 'OPEN_LAW DRF target code: law | admrul | ordin | licbyl | etc.';
COMMENT ON COLUMN tax_law_sync_state.current_mst       IS '법령일련번호 of the active revision currently ingested into Bedrock KB';
COMMENT ON COLUMN tax_law_sync_state.pending_revision_mst IS 'New MST detected via lsHstInf/eflaw but not yet activated. Awaits human review (gated by kb_chunk_active)';
COMMENT ON COLUMN tax_law_sync_state.kb_chunk_active   IS 'Activation gate. False = new chunks are ingested but excluded from retrieval until admin toggles via tax_rule_review_request resolution';

CREATE TABLE IF NOT EXISTS tax_law_chunk_meta (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  law_id          VARCHAR(20)  NOT NULL,
  mst             VARCHAR(20)  NOT NULL,
  article_number  VARCHAR(20),
  paragraph       VARCHAR(10),
  item            VARCHAR(10),
  effective_from  DATE         NOT NULL,
  effective_to    DATE,
  s3_uri          TEXT         NOT NULL,
  public_url      TEXT,
  ministry        VARCHAR(50),
  law_type        VARCHAR(20)  NOT NULL CHECK (law_type IN ('LAW', 'DECREE', 'REGULATION', 'INTERPRETATION', 'BYLAW')),
  ingested_at     TIMESTAMPTZ,
  removed_at      TIMESTAMPTZ,
  UNIQUE (law_id, mst, article_number, paragraph, item)
);

CREATE INDEX IF NOT EXISTS idx_chunk_lookup
  ON tax_law_chunk_meta(law_id, effective_from, effective_to)
  WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_chunk_law_type
  ON tax_law_chunk_meta(law_type, effective_from)
  WHERE removed_at IS NULL;

COMMENT ON TABLE  tax_law_chunk_meta             IS 'Bedrock KB chunk registry. KB itself stores vectors in Aurora pgvector; this table mirrors the S3 chunk inventory for joins (filing_cited_chunk, audit)';
COMMENT ON COLUMN tax_law_chunk_meta.s3_uri      IS 'Authoritative source: s3://{kbBucket}/chunks/{law_id}/{mst}/article-{N}.json';
COMMENT ON COLUMN tax_law_chunk_meta.public_url  IS 'Human-clickable 법제처 link, e.g. https://www.law.go.kr/법령/법인세법/제55조';
COMMENT ON COLUMN tax_law_chunk_meta.effective_to IS 'NULL for current revisions. Closed when delHst (폐지) detected or superseded by a newer MST after dual approval';
COMMENT ON COLUMN tax_law_chunk_meta.removed_at  IS 'Soft-delete timestamp for chunks that should no longer be retrievable';

CREATE TABLE IF NOT EXISTS holiday_cache (
  date          DATE         PRIMARY KEY,
  year          INTEGER      NOT NULL,
  name          VARCHAR(100) NOT NULL,
  is_holiday    BOOLEAN      NOT NULL,
  is_substitute BOOLEAN      NOT NULL DEFAULT FALSE,
  synced_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_holiday_year ON holiday_cache(year);

COMMENT ON TABLE  holiday_cache              IS 'Source of truth (SoT) for Korean public holidays. Fed by KASI 특일정보 API yearly cron + quarterly top-up for ad-hoc 임시공휴일';
COMMENT ON COLUMN holiday_cache.is_substitute IS '대체공휴일 flag. Drives roll-forward logic for filing 마감일 that fall on weekends/holidays';

ALTER TABLE tax_law_sync_state  ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_law_chunk_meta  ENABLE ROW LEVEL SECURITY;
ALTER TABLE holiday_cache       ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tax_law_sync_global_select ON tax_law_sync_state;
CREATE POLICY tax_law_sync_global_select ON tax_law_sync_state
  FOR SELECT TO app_user
  USING (TRUE);

DROP POLICY IF EXISTS tax_law_sync_admin_write ON tax_law_sync_state;
CREATE POLICY tax_law_sync_admin_write ON tax_law_sync_state
  FOR ALL TO app_user
  USING      (current_setting('app.is_tax_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_tax_admin', true) = 'true');

DROP POLICY IF EXISTS tax_chunk_global_select ON tax_law_chunk_meta;
CREATE POLICY tax_chunk_global_select ON tax_law_chunk_meta
  FOR SELECT TO app_user
  USING (TRUE);

DROP POLICY IF EXISTS tax_chunk_admin_write ON tax_law_chunk_meta;
CREATE POLICY tax_chunk_admin_write ON tax_law_chunk_meta
  FOR ALL TO app_user
  USING      (current_setting('app.is_tax_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_tax_admin', true) = 'true');

DROP POLICY IF EXISTS holiday_global_select ON holiday_cache;
CREATE POLICY holiday_global_select ON holiday_cache
  FOR SELECT TO app_user
  USING (TRUE);

DROP POLICY IF EXISTS holiday_admin_write ON holiday_cache;
CREATE POLICY holiday_admin_write ON holiday_cache
  FOR ALL TO app_user
  USING      (current_setting('app.is_tax_admin', true) = 'true')
  WITH CHECK (current_setting('app.is_tax_admin', true) = 'true');
