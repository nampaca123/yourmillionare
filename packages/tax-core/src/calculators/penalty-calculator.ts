// Pure penalty calculator covering late payment, unreported/underreported, zero-rate violation, and tax-invoice penalties.

import { roundKrw } from './vat-calculator.js';

const REDUCTION_TABLE_LATE_FILING: ReadonlyArray<{ withinDays: number; ratio: number }> = [
  { withinDays: 30, ratio: 0.5 },
  { withinDays: 90, ratio: 0.3 },
  { withinDays: 180, ratio: 0.2 },
];

const REDUCTION_TABLE_AMENDED_FILING: ReadonlyArray<{ withinDays: number; ratio: number }> = [
  { withinDays: 180, ratio: 0.9 },
  { withinDays: 365, ratio: 0.75 },
];

export type PenaltyKind =
  | 'LATE_PAYMENT'
  | 'UNREPORTED'
  | 'UNDERREPORTED'
  | 'ZERO_RATE_VIOLATION'
  | 'TAX_INVOICE_LATE_ISSUE'
  | 'TAX_INVOICE_NOT_ISSUED'
  | 'WITHHOLDING_LATE_PAYMENT';

export interface PenaltyInput {
  readonly kind: PenaltyKind;
  readonly baseAmount: number;
  readonly rate: number;
  readonly daysLate: number;
  readonly amendmentType?: 'LATE_FILING' | 'AMENDED_FILING';
}

export interface PenaltyResult {
  readonly grossPenalty: number;
  readonly reductionRatio: number;
  readonly netPenalty: number;
}

export const computePenalty = (input: PenaltyInput): PenaltyResult => {
  const gross =
    input.kind === 'LATE_PAYMENT' || input.kind === 'WITHHOLDING_LATE_PAYMENT'
      ? input.baseAmount * input.rate * input.daysLate
      : input.baseAmount * input.rate;
  const reductionRatio = resolveReduction(input);
  const net = gross * (1 - reductionRatio);
  return {
    grossPenalty: roundKrw(gross),
    reductionRatio,
    netPenalty: roundKrw(net),
  };
};

const resolveReduction = (input: PenaltyInput): number => {
  if (!input.amendmentType) return 0;
  const table =
    input.amendmentType === 'LATE_FILING'
      ? REDUCTION_TABLE_LATE_FILING
      : REDUCTION_TABLE_AMENDED_FILING;
  for (const tier of table) {
    if (input.daysLate <= tier.withinDays) return tier.ratio;
  }
  return 0;
};
