// Barrel export for @ym/tax-core.

export type { RuleKind, FilingKind, TaxRule, RateLookupContext, AppliedRate } from './types.js';
export { RULE_KINDS, FILING_KINDS, TaxRuleNotFoundError } from './types.js';

export type { VatLineInput, VatComputationResult } from './calculators/vat-calculator.js';
export { computeVatPayable, splitGrossIntoSupplyAndVat, roundKrw } from './calculators/vat-calculator.js';

export type {
  WithholdingIncomeType,
  WithholdingComputationInput,
  WithholdingComputationResult,
} from './calculators/withholding-calculator.js';
export { computeWithholding } from './calculators/withholding-calculator.js';

export type { CorpTaxBracket, CorpTaxResult } from './calculators/corp-tax-calculator.js';
export { computeCorporateTax } from './calculators/corp-tax-calculator.js';

export type { PenaltyKind, PenaltyInput, PenaltyResult } from './calculators/penalty-calculator.js';
export { computePenalty } from './calculators/penalty-calculator.js';

export type { HolidayCalendar } from './holiday-roller.js';
export { rollForwardToBusinessDay, subtractBusinessDays } from './holiday-roller.js';

export type {
  CorporationProfileForBenefits,
  BenefitEligibilityRule,
  BenefitCandidate,
} from './benefits/youth-founder-eligibility.js';
export { evaluateYouthFounderBenefit, estimateAnnualSavings } from './benefits/youth-founder-eligibility.js';
