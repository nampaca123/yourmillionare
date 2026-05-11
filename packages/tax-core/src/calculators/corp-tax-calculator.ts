// Pure progressive corporate tax calculator — bracket rows are injected from effective-dated tax_rule.

import { roundKrw } from './vat-calculator.js';

export interface CorpTaxBracket {
  readonly bracketFrom: number;
  readonly bracketTo: number | null;
  readonly rate: number;
  readonly ruleId: string;
}

export interface CorpTaxResult {
  readonly taxableIncome: number;
  readonly computedTax: number;
  readonly perBracket: ReadonlyArray<{ ruleId: string; rate: number; portion: number; tax: number }>;
}

export const computeCorporateTax = (
  taxableIncome: number,
  brackets: ReadonlyArray<CorpTaxBracket>,
): CorpTaxResult => {
  if (taxableIncome <= 0) {
    return { taxableIncome: roundKrw(taxableIncome), computedTax: 0, perBracket: [] };
  }
  const sorted = [...brackets].sort((a, b) => a.bracketFrom - b.bracketFrom);
  const perBracket: { ruleId: string; rate: number; portion: number; tax: number }[] = [];
  let totalTax = 0;
  for (const bracket of sorted) {
    if (taxableIncome <= bracket.bracketFrom) break;
    const upper = bracket.bracketTo ?? taxableIncome;
    const portion = Math.max(0, Math.min(taxableIncome, upper) - bracket.bracketFrom);
    if (portion <= 0) continue;
    const tax = portion * bracket.rate;
    totalTax += tax;
    perBracket.push({ ruleId: bracket.ruleId, rate: bracket.rate, portion: roundKrw(portion), tax: roundKrw(tax) });
  }
  return {
    taxableIncome: roundKrw(taxableIncome),
    computedTax: roundKrw(totalTax),
    perBracket,
  };
};
