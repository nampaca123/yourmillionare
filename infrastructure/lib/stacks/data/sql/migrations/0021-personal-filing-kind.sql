-- Migration 0021: add COMPREHENSIVE_INCOME (종합소득세) to filing_kind enum so personal tenants get auto-generated annual obligation.

ALTER TYPE filing_kind ADD VALUE IF NOT EXISTS 'COMPREHENSIVE_INCOME';

COMMENT ON TYPE filing_kind IS 'Filing kinds: VAT (corp/sole_proprietor), WH (withholding, employer), CORP (법인세), LOCAL_INCOME (지방소득세), COMPREHENSIVE_INCOME (개인 종합소득세, 매년 5월 31일).';
