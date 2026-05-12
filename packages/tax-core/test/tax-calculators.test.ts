// Unit tests for the deterministic tax calculators and benefit evaluators.

import { describe, it, expect } from 'vitest';
import {
  computeVatPayable,
  splitGrossIntoSupplyAndVat,
  computePenalty,
  evaluateYouthFounderBenefit,
  evaluateSmeSpecialDeduction,
  evaluateRndTaxCredit,
  evaluateIntegratedIncomeYouthFounder,
  estimateAnnualSavings,
  type CorporationProfileForBenefits,
} from '../src/index.js';

describe('computeVatPayable', () => {
  it('should subtract deductible input VAT from output VAT and add any penalty', () => {
    const result = computeVatPayable(
      [{ supply: 10_000_000, rate: 0.1 }],
      [{ supply: 4_000_000, rate: 0.1 }],
      50_000,
    );

    expect(result.outputVat).toBe(1_000_000);
    expect(result.deductibleInputVat).toBe(400_000);
    expect(result.netPayable).toBe(650_000);
    expect(result.penalty).toBe(50_000);
  });

  it('should split a gross amount into supply + VAT using the standard 10% rate', () => {
    const { supply, vat } = splitGrossIntoSupplyAndVat(11_000, 0.1);

    expect(supply).toBe(10_000);
    expect(vat).toBe(1_000);
  });
});

describe('computePenalty', () => {
  it('should scale late-payment penalty by base × rate × daysLate', () => {
    const result = computePenalty({
      kind: 'LATE_PAYMENT',
      baseAmount: 1_000_000,
      rate: 0.00022,
      daysLate: 30,
    });

    expect(result.grossPenalty).toBe(6_600);
    expect(result.netPenalty).toBe(6_600);
    expect(result.reductionRatio).toBe(0);
  });

  it('should apply the 50% LATE_FILING reduction when amended within 30 days', () => {
    const result = computePenalty({
      kind: 'UNREPORTED',
      baseAmount: 1_000_000,
      rate: 0.2,
      daysLate: 20,
      amendmentType: 'LATE_FILING',
    });

    expect(result.grossPenalty).toBe(200_000);
    expect(result.reductionRatio).toBe(0.5);
    expect(result.netPenalty).toBe(100_000);
  });
});

describe('evaluateYouthFounderBenefit', () => {
  const eligibleProfile: CorporationProfileForBenefits = {
    industryCode: '62010',
    foundedAt: '2025-03-01',
    isYouthFounder: true,
    hqSigungu: 'NON_METRO',
    priorYearCorpTax: 50_000_000,
  };

  it('should mark all four rules met for a youth founder in non-metro IT industry', () => {
    const candidate = evaluateYouthFounderBenefit(eligibleProfile, '2026-05-12');

    expect(candidate.eligible).toBe(true);
    expect(candidate.deductionRate).toBe(1.0);
    expect(candidate.maxYears).toBe(5);
  });

  it('should mark ineligible when industry code falls outside the eligible prefixes', () => {
    const candidate = evaluateYouthFounderBenefit(
      { ...eligibleProfile, industryCode: '47010' },
      '2026-05-12',
    );

    expect(candidate.eligible).toBe(false);
    expect(candidate.rules.find((r) => r.rule.startsWith('Eligible industry'))?.met).toBe(false);
  });

  it('should compute annual savings as priorYearCorpTax × deductionRate when eligible', () => {
    const candidate = evaluateYouthFounderBenefit(eligibleProfile, '2026-05-12');

    const annual = estimateAnnualSavings(eligibleProfile.priorYearCorpTax, candidate);

    expect(annual).toBe(50_000_000);
  });
});

describe('evaluateSmeSpecialDeduction', () => {
  it('should boost rate to 30% for manufacturing SME outside the metropolitan zone', () => {
    const candidate = evaluateSmeSpecialDeduction(
      {
        industryCode: '15000',
        foundedAt: '2024-01-01',
        isYouthFounder: false,
        hqSigungu: 'NON_METRO',
        priorYearCorpTax: 30_000_000,
        priorYearRevenue: 1_000_000_000,
      },
      '2026-05-12',
    );

    expect(candidate.eligible).toBe(true);
    expect(candidate.deductionRate).toBe(0.30);
  });

  it('should fall back to 10% rate inside the metropolitan zone non-manufacturing', () => {
    const candidate = evaluateSmeSpecialDeduction(
      {
        industryCode: '62010',
        foundedAt: '2024-01-01',
        isYouthFounder: false,
        hqSigungu: 'METRO_OVERCROWDED',
        priorYearCorpTax: 30_000_000,
        priorYearRevenue: 1_000_000_000,
      },
      '2026-05-12',
    );

    expect(candidate.deductionRate).toBe(0.10);
  });
});

describe('evaluateRndTaxCredit', () => {
  it('should surface as candidate for SME IT industry but require verification at filing', () => {
    const candidate = evaluateRndTaxCredit(
      {
        industryCode: '62010',
        foundedAt: '2024-01-01',
        isYouthFounder: false,
        hqSigungu: 'NON_METRO',
        priorYearCorpTax: 10_000_000,
        priorYearRevenue: 800_000_000,
      },
      '2026-05-12',
    );

    expect(candidate.eligible).toBe(true);
    expect(candidate.rules.some((r) => r.rule.startsWith('Requires actual R&D'))).toBe(true);
  });
});

describe('evaluateIntegratedIncomeYouthFounder', () => {
  it('should apply the §6의2 personal-income youth-founder rules with same age/industry/region checks', () => {
    const candidate = evaluateIntegratedIncomeYouthFounder(
      {
        industryCode: '62010',
        foundedAt: '2025-03-01',
        isYouthFounder: true,
        hqSigungu: 'NON_METRO',
        priorYearCorpTax: 8_000_000,
      },
      '2026-05-12',
    );

    expect(candidate.eligible).toBe(true);
    expect(candidate.lawArticleRef).toBe('조세특례제한법 §6의2');
  });
});
