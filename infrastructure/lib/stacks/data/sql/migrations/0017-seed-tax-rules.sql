-- Migration 0017: seed tax_rule with current Korean rates so calculators have data on first deploy.

INSERT INTO tax_rule (rule_kind, bracket_from, bracket_to, rate, effective_from, effective_to, legal_basis, approved_at)
VALUES
  ('VAT_STANDARD',       NULL,             NULL,            0.100000, DATE '2010-01-01', NULL, '부가가치세법 §30 ①', now()),
  ('VAT_ZERO_RATE',      NULL,             NULL,            0.000000, DATE '2010-01-01', NULL, '부가가치세법 §21–24', now()),

  ('CORP_TAX_BRACKET',   0,                200000000,       0.090000, DATE '2024-01-01', NULL, '법인세법 §55 ①', now()),
  ('CORP_TAX_BRACKET',   200000000,        20000000000,     0.190000, DATE '2024-01-01', NULL, '법인세법 §55 ①', now()),
  ('CORP_TAX_BRACKET',   20000000000,      300000000000,    0.210000, DATE '2024-01-01', NULL, '법인세법 §55 ①', now()),
  ('CORP_TAX_BRACKET',   300000000000,     NULL,            0.240000, DATE '2024-01-01', NULL, '법인세법 §55 ①', now()),

  ('WH_BUSINESS_INCOME', NULL,             NULL,            0.030000, DATE '2010-01-01', NULL, '소득세법 §129 ① 5호 — 사업소득 원천징수 3%', now()),
  ('WH_OTHER_INCOME',    NULL,             NULL,            0.200000, DATE '2010-01-01', NULL, '소득세법 §129 ① 6호 — 기타소득 20%', now()),
  ('WH_EMPLOYMENT',      NULL,             NULL,            0.000000, DATE '2010-01-01', NULL, '근로소득 간이세액표 (별도 적용)', now()),
  ('WH_INTEREST',        NULL,             NULL,            0.140000, DATE '2010-01-01', NULL, '소득세법 §129 ① 1호 — 이자소득 14%', now()),
  ('WH_DIVIDEND',        NULL,             NULL,            0.140000, DATE '2010-01-01', NULL, '소득세법 §129 ① 2호 — 배당소득 14%', now()),

  ('LOCAL_INCOME',       NULL,             NULL,            0.100000, DATE '2010-01-01', NULL, '지방세법 §86 — 지방소득세 = 법인세 × 10%', now()),

  ('PENALTY_LATE_PAY',           NULL, NULL, 0.000220, DATE '2022-02-15', NULL, '국세기본법 §47의4 — 납부지연가산세 0.022%/일', now()),
  ('PENALTY_UNREPORTED',         NULL, NULL, 0.200000, DATE '2010-01-01', NULL, '국세기본법 §47의2 — 무신고가산세 20% (일반)', now()),
  ('PENALTY_UNDERREPORTED',      NULL, NULL, 0.100000, DATE '2010-01-01', NULL, '국세기본법 §47의3 — 과소신고가산세 10% (일반)', now()),
  ('PENALTY_TAX_INVOICE_LATE',   NULL, NULL, 0.010000, DATE '2010-01-01', NULL, '부가가치세법 §60 ② — 세금계산서 지연발급 1%', now()),
  ('PENALTY_TAX_INVOICE_NOT_ISSUED', NULL, NULL, 0.020000, DATE '2010-01-01', NULL, '부가가치세법 §60 ② — 세금계산서 미발급 2%', now()),
  ('PENALTY_WITHHOLDING_LATE_PAY', NULL, NULL, 0.030000, DATE '2010-01-01', NULL, '국세기본법 §47의5 — 원천징수납부지연가산세 3% (기본)', now())
ON CONFLICT DO NOTHING;
