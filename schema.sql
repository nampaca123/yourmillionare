-- ============================================================
--  aws-accountant — Aurora PostgreSQL 스키마 (MVP)
--  회계기준: K-IFRS 정합 (IAS 21 외화 처리 포함)
--  대상 DB: Aurora Serverless v2 PostgreSQL 15+
-- ============================================================
--  설계 원칙
--    1. 복식부기 무결성  : per-entry SUM(debit)=SUM(credit) (DEFERRABLE 제약 트리거)
--    2. 멀티테넌시       : tenant_id가 모든 영속 테이블에 존재. RLS 정책은 별도 마이그레이션
--    3. 외화 처리        : K-IFRS IAS 21 — 거래일 환율 인식 + 결산일 마감환율 재측정
--    4. CODEF 멱등성     : (tenant_id, source, external_id) UNIQUE
--    5. AI 추적성        : ai_confidence·ai_model 보관, 사용자 정정은 reversed_by 체인
--
--  MVP 제외 (향후 마이그레이션)
--    - tax_events     (세금 캘린더, Phase 1)
--    - notifications  (운영 이벤트)
--    - ai_decisions   (reversed_by 체인으로 우회)
--    - 화면 캐시      (DynamoDB로 별도 처리)
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ============================================================
--  1. users — Cognito 사용자 1:1
-- ============================================================
CREATE TABLE users (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub  VARCHAR(255) NOT NULL UNIQUE,
  email        VARCHAR(255) NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  users             IS 'Cognito sub과 1:1 매핑되는 사용자 마스터';
COMMENT ON COLUMN users.cognito_sub IS 'Cognito User Pool의 sub (불변, 외부 식별자)';


-- ============================================================
--  2. user_profiles — 표시·취향 (가변)
-- ============================================================
CREATE TABLE user_profiles (
  user_id            UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name       VARCHAR(100),
  kakao_user_id      VARCHAR(100),
  notification_hour  SMALLINT    NOT NULL DEFAULT 9
                       CHECK (notification_hour BETWEEN 0 AND 23),
  locale             VARCHAR(10) NOT NULL DEFAULT 'ko-KR',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE user_profiles IS '표시명·알림·로케일. PIPA 삭제 요청 시 본 테이블 위주로 처리';


-- ============================================================
--  3. tenants — 법인/개인사업자
-- ============================================================
CREATE TYPE business_type AS ENUM ('corporate', 'sole_proprietor');
CREATE TYPE tax_type      AS ENUM ('general', 'simplified', 'tax_exempt');

CREATE TABLE tenants (
  id                       UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  biz_reg_no_encrypted     BYTEA         NOT NULL,
  biz_reg_no_hash          BYTEA         NOT NULL UNIQUE,
  legal_name               VARCHAR(200)  NOT NULL,
  display_name             VARCHAR(100)  NOT NULL,
  business_type            business_type NOT NULL DEFAULT 'corporate',
  tax_type                 tax_type      NOT NULL DEFAULT 'general',
  fiscal_year_start_month  SMALLINT      NOT NULL DEFAULT 1
                             CHECK (fiscal_year_start_month BETWEEN 1 AND 12),
  functional_currency      CHAR(3)       NOT NULL DEFAULT 'KRW',
  founded_on               DATE,
  region_code              VARCHAR(20),
  created_at               TIMESTAMPTZ   NOT NULL DEFAULT now()
);

COMMENT ON TABLE  tenants                      IS '법인/개인사업자 단위. 청년창업 세액감면 판정은 founded_on + region_code';
COMMENT ON COLUMN tenants.biz_reg_no_encrypted IS '사업자등록번호. 앱 레이어에서 KMS DEK + pgcrypto로 암호화 후 저장';
COMMENT ON COLUMN tenants.biz_reg_no_hash      IS '결정적 HMAC. 중복 검사용 (별도 키 사용 권장)';
COMMENT ON COLUMN tenants.functional_currency  IS 'K-IFRS IAS 21 기능통화. 한국 법인은 보통 KRW';
COMMENT ON COLUMN tenants.region_code          IS '예: SEOUL_OVERCROWDED, METRO_NON_OVERCROWDED, NON_METRO. 감면율 산정 키';


-- ============================================================
--  4. tenant_members — 사용자 ↔ 테넌트 N:M
-- ============================================================
CREATE TYPE tenant_role AS ENUM ('owner', 'admin', 'viewer');

CREATE TABLE tenant_members (
  tenant_id  UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id    UUID        NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  role       tenant_role NOT NULL DEFAULT 'admin',
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX idx_tenant_members_user ON tenant_members(user_id);

COMMENT ON TABLE tenant_members IS '공동대표 다수가 한 법인 데이터를 공유하는 케이스 지원';


-- ============================================================
--  5. accounts — 계정과목 (테넌트별)
-- ============================================================
CREATE TYPE account_type   AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');
CREATE TYPE normal_balance AS ENUM ('debit', 'credit');

CREATE TABLE accounts (
  tenant_id       UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code            VARCHAR(10)    NOT NULL,
  name            VARCHAR(100)   NOT NULL,
  display_name    VARCHAR(100)   NOT NULL,
  type            account_type   NOT NULL,
  normal_balance  normal_balance NOT NULL,
  is_current      BOOLEAN,
  currency        CHAR(3)        NOT NULL DEFAULT 'KRW',
  parent_code     VARCHAR(10),
  is_active       BOOLEAN        NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_code) REFERENCES accounts(tenant_id, code)
);

CREATE INDEX idx_accounts_type ON accounts(tenant_id, type) WHERE is_active;

COMMENT ON TABLE  accounts              IS '테넌트별 계정과목. K-IFRS 표시 분류는 type + is_current 조합으로 도출';
COMMENT ON COLUMN accounts.name         IS '정식 회계 명칭 (예: ''현금'')';
COMMENT ON COLUMN accounts.display_name IS '사용자 노출 명칭 (예: ''통장에 있는 돈'')';
COMMENT ON COLUMN accounts.is_current   IS '자산/부채에만 의미. 유동/비유동 분류 (K-IFRS IAS 1)';
COMMENT ON COLUMN accounts.currency     IS '외화 계좌면 USD 등. 결산 시 마감환율 재측정 대상 (IAS 21)';


-- ============================================================
--  6. journal_entries / journal_lines — 분개 (복식부기 핵심)
-- ============================================================
CREATE TYPE journal_source AS ENUM (
  'codef_bank',
  'codef_card',
  'codef_fx',
  'codef_hometax',
  'codef_tax_invoice',
  'fx_revaluation',
  'manual'
);

CREATE TYPE journal_status AS ENUM ('draft', 'posted', 'reversed');

CREATE TABLE journal_entries (
  id              UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_date      DATE           NOT NULL,
  posting_date    DATE           NOT NULL,
  source          journal_source NOT NULL,
  source_ref_id   UUID,
  description     TEXT,
  status          journal_status NOT NULL DEFAULT 'posted',
  ai_confidence   NUMERIC(4,3)   CHECK (ai_confidence IS NULL OR ai_confidence BETWEEN 0 AND 1),
  ai_model        VARCHAR(50),
  reversed_by     UUID           REFERENCES journal_entries(id),
  created_at      TIMESTAMPTZ    NOT NULL DEFAULT now(),
  created_by      UUID           REFERENCES users(id)
);

CREATE INDEX idx_journal_entries_tenant_date ON journal_entries(tenant_id, entry_date);
CREATE INDEX idx_journal_entries_source_ref  ON journal_entries(source_ref_id) WHERE source_ref_id IS NOT NULL;

COMMENT ON TABLE  journal_entries               IS '분개 헤더. 사용자 정정은 reversed_by 체인으로 감사 추적 (in-place edit 금지)';
COMMENT ON COLUMN journal_entries.entry_date    IS '거래 발생일자';
COMMENT ON COLUMN journal_entries.posting_date  IS '장부 기록일 (소급 분개 시 entry_date < posting_date)';
COMMENT ON COLUMN journal_entries.source_ref_id IS 'raw_transactions.id (있을 때). 1 raw → N entries 가능 (할부 등)';

CREATE TABLE journal_lines (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id      UUID          NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  tenant_id     UUID          NOT NULL,
  line_no       SMALLINT      NOT NULL,
  account_code  VARCHAR(10)   NOT NULL,
  debit         NUMERIC(18,2) NOT NULL DEFAULT 0,
  credit        NUMERIC(18,2) NOT NULL DEFAULT 0,
  fcy_currency  CHAR(3),
  fcy_amount    NUMERIC(18,2),
  fx_rate       NUMERIC(14,6),
  memo          TEXT,
  CHECK (debit  >= 0 AND credit >= 0),
  CHECK ((debit > 0 AND credit = 0) OR (debit = 0 AND credit > 0)),
  CHECK (
    (fcy_currency IS NULL AND fcy_amount IS NULL AND fx_rate IS NULL)
    OR (fcy_currency IS NOT NULL AND fcy_amount IS NOT NULL AND fx_rate IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, account_code) REFERENCES accounts(tenant_id, code),
  UNIQUE (entry_id, line_no)
);

CREATE INDEX idx_journal_lines_account ON journal_lines(tenant_id, account_code);

COMMENT ON TABLE  journal_lines              IS '분개 라인. 외화 거래는 fcy_* 3컬럼이 모두 NOT NULL (CHECK 강제)';
COMMENT ON COLUMN journal_lines.debit        IS 'KRW(기능통화) 환산 차변. 외화 라인도 KRW로 환산해서 보관';
COMMENT ON COLUMN journal_lines.credit       IS 'KRW(기능통화) 환산 대변';
COMMENT ON COLUMN journal_lines.fcy_amount   IS '외화 원금액. KRW = fcy_amount * fx_rate';
COMMENT ON COLUMN journal_lines.fx_rate      IS '거래시점 환율 (외화 1단위당 KRW). IAS 21 거래일 환율';

-- 분개 무결성: per-entry SUM(debit) = SUM(credit), 트랜잭션 끝에 검증
CREATE OR REPLACE FUNCTION fn_assert_journal_balanced()
RETURNS TRIGGER AS $$
DECLARE
  total_debit  NUMERIC;
  total_credit NUMERIC;
  eid          UUID;
BEGIN
  eid := COALESCE(NEW.entry_id, OLD.entry_id);
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO total_debit, total_credit
    FROM journal_lines WHERE entry_id = eid;
  IF total_debit <> total_credit THEN
    RAISE EXCEPTION '분개 % 차변/대변 불일치: 차변=%, 대변=%', eid, total_debit, total_credit;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_assert_journal_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION fn_assert_journal_balanced();


-- ============================================================
--  7. raw_transactions — CODEF 원응답 + 멱등성
-- ============================================================
CREATE TABLE raw_transactions (
  id            UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID           NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source        journal_source NOT NULL,
  external_id   VARCHAR(255)   NOT NULL,
  occurred_at   TIMESTAMPTZ    NOT NULL,
  amount        NUMERIC(18,2)  NOT NULL,
  fcy_currency  CHAR(3),
  fcy_amount    NUMERIC(18,2),
  counterparty  VARCHAR(200),
  raw_payload   JSONB          NOT NULL,
  fetched_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, source, external_id)
);

CREATE INDEX idx_raw_tx_tenant_time ON raw_transactions(tenant_id, occurred_at DESC);

COMMENT ON TABLE  raw_transactions             IS 'CODEF 원응답 보관. (tenant_id, source, external_id) UNIQUE로 폴링 멱등성 보장';
COMMENT ON COLUMN raw_transactions.amount      IS 'KRW 환산 금액. 외화 거래는 raw_payload의 환율로 환산해서 저장';
COMMENT ON COLUMN raw_transactions.raw_payload IS 'CODEF 응답 원문. 분개 재생성·디버깅·감사 대비';


-- ============================================================
--  8. fx_observations — 환율 (테넌트 무관 공유)
-- ============================================================
CREATE TYPE fx_rate_type AS ENUM ('closing', 'transaction', 'tt_buy', 'tt_sell', 'cash_buy', 'cash_sell');

CREATE TABLE fx_observations (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  observed_on     DATE          NOT NULL,
  base_currency   CHAR(3)       NOT NULL DEFAULT 'KRW',
  quote_currency  CHAR(3)       NOT NULL,
  rate            NUMERIC(14,6) NOT NULL CHECK (rate > 0),
  rate_type       fx_rate_type  NOT NULL DEFAULT 'closing',
  source          VARCHAR(50)   NOT NULL,
  fetched_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  UNIQUE (observed_on, base_currency, quote_currency, rate_type, source)
);

CREATE INDEX idx_fx_latest ON fx_observations(quote_currency, rate_type, observed_on DESC);

COMMENT ON TABLE  fx_observations             IS 'ECOS 매매기준율 + 시중은행 고시환율. closing은 IAS 21 마감환율 재측정에 사용';
COMMENT ON COLUMN fx_observations.rate        IS '1 quote_currency = rate × base_currency. 예: USD→KRW이면 rate=1339.500000';
COMMENT ON COLUMN fx_observations.rate_type   IS 'closing: 매매기준율. tt_buy/sell: 전신환. cash_buy/sell: 현찰';
