// Shared types and constants for deterministic tax calculations and filing identifiers.

export const RULE_KINDS = [
  'VAT_STANDARD',
  'VAT_ZERO_RATE',
  'VAT_EXEMPT',
  'CORP_TAX_BRACKET',
  'CORP_TAX_REDUCED',
  'WH_BUSINESS_INCOME',
  'WH_OTHER_INCOME',
  'WH_EMPLOYMENT',
  'WH_DAILY',
  'WH_INTEREST',
  'WH_DIVIDEND',
  'LOCAL_INCOME',
  'PENALTY_LATE_PAY',
  'PENALTY_UNREPORTED',
  'PENALTY_UNDERREPORTED',
  'PENALTY_ZERO_RATE_VIOLATION',
  'PENALTY_TAX_INVOICE_LATE',
  'PENALTY_TAX_INVOICE_NOT_ISSUED',
  'PENALTY_WITHHOLDING_LATE_PAY',
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];

export const FILING_KINDS = [
  'VAT_PRELIM',
  'VAT_FINAL',
  'VAT_PREPAYMENT_NOTICE',
  'WH_MONTHLY',
  'WH_SEMIANNUAL',
  'WH_PAYMENT_STATEMENT',
  'CORP_INTERIM',
  'CORP_FINAL',
  'LOCAL_INCOME',
] as const;

export type FilingKind = (typeof FILING_KINDS)[number];

export interface TaxRule {
  readonly id: string;
  readonly ruleKind: RuleKind;
  readonly bracketFrom: number | null;
  readonly bracketTo: number | null;
  readonly rate: number;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly legalBasis: string;
  readonly legalBasisLawId: string | null;
  readonly legalBasisMst: string | null;
  readonly sourceUrl: string | null;
  readonly approvedAt: string | null;
}

export interface RateLookupContext {
  readonly asOfDate: string;
  readonly ruleKind: RuleKind;
  readonly taxableAmount?: number;
}

export interface AppliedRate {
  readonly rate: number;
  readonly ruleId: string;
  readonly legalBasis: string;
  readonly sourceUrl: string | null;
  readonly approved: boolean;
}

export class TaxRuleNotFoundError extends Error {
  constructor(public readonly context: RateLookupContext) {
    super(`No tax rule found for kind=${context.ruleKind} asOfDate=${context.asOfDate}`);
    this.name = 'TaxRuleNotFoundError';
  }
}
