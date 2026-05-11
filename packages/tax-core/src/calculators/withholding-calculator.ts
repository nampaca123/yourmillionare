// Pure withholding tax calculator — caller supplies income-tax and local-income rates from tax_rule.

import { roundKrw } from './vat-calculator.js';

const NECESSARY_EXPENSE_RATIO_OTHER_INCOME = 0.6;

export type WithholdingIncomeType =
  | 'BUSINESS_INCOME'
  | 'OTHER_INCOME'
  | 'EMPLOYMENT'
  | 'DAILY_EMPLOYMENT'
  | 'INTEREST'
  | 'DIVIDEND';

export interface WithholdingComputationInput {
  readonly incomeType: WithholdingIncomeType;
  readonly grossAmount: number;
  readonly incomeTaxRate: number;
  readonly localIncomeTaxRate: number;
}

export interface WithholdingComputationResult {
  readonly grossAmount: number;
  readonly taxableBase: number;
  readonly incomeTax: number;
  readonly localIncomeTax: number;
  readonly netPayout: number;
}

export const computeWithholding = (
  input: WithholdingComputationInput,
): WithholdingComputationResult => {
  const taxableBase =
    input.incomeType === 'OTHER_INCOME'
      ? input.grossAmount * (1 - NECESSARY_EXPENSE_RATIO_OTHER_INCOME)
      : input.grossAmount;
  const incomeTax = taxableBase * input.incomeTaxRate;
  const localIncomeTax = incomeTax * input.localIncomeTaxRate;
  const netPayout = input.grossAmount - incomeTax - localIncomeTax;
  return {
    grossAmount: roundKrw(input.grossAmount),
    taxableBase: roundKrw(taxableBase),
    incomeTax: roundKrw(incomeTax),
    localIncomeTax: roundKrw(localIncomeTax),
    netPayout: roundKrw(netPayout),
  };
};
