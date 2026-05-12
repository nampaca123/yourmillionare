// Deterministic eligibility for 조세특례제한법 §7 (중소기업 특별세액감면) — SME special deduction.

import type { BenefitCandidate, BenefitEligibilityRule, CorporationProfileForBenefits } from './youth-founder-eligibility.js';

const SME_MAX_YEARS = 999;
const REVENUE_CEILING_KRW = 5_000_000_000;
const NON_METRO_REGION_CODES: ReadonlySet<string> = new Set(['NON_METRO', 'METRO_NON_OVERCROWDED']);

const ELIGIBLE_INDUSTRY_PREFIXES: ReadonlyArray<string> = [
  '10', '11', '12', '13', '14', '15', '16', '17', '18', '19',
  '20', '21', '22', '23', '24', '25', '26', '27', '28', '29', '30', '31', '32', '33',
  '49', '50', '51', '52',
  '58', '59', '60', '61', '62', '63',
  '70', '71', '72', '73', '74',
];

const computeDeductionRate = (regionMet: boolean, industryCode: string): number => {
  const isManufacturing = /^(1[0-9]|2[0-9]|3[0-3])/.test(industryCode);
  if (regionMet && isManufacturing) return 0.30;
  if (regionMet) return 0.20;
  if (isManufacturing) return 0.20;
  return 0.10;
};

export interface SmeBenefitInput extends CorporationProfileForBenefits {
  readonly priorYearRevenue?: number | null;
}

export const evaluateSmeSpecialDeduction = (
  profile: SmeBenefitInput,
  _asOfDate: string,
): BenefitCandidate => {
  const rules: BenefitEligibilityRule[] = [];

  const revenue = profile.priorYearRevenue ?? null;
  const revenueOk = revenue === null ? false : revenue > 0 && revenue <= REVENUE_CEILING_KRW;
  rules.push({
    rule: `Prior-year revenue under KRW ${REVENUE_CEILING_KRW.toLocaleString()}`,
    met: revenueOk,
    reason: revenue === null ? 'priorYearRevenue missing' : `priorYearRevenue=${revenue}`,
  });

  const industry = profile.industryCode ?? '';
  const industryMet = ELIGIBLE_INDUSTRY_PREFIXES.some((p) => industry.startsWith(p));
  rules.push({
    rule: 'Eligible SME industry per 조세특례제한법 §7 ①',
    met: industryMet,
    reason: `industryCode=${industry || 'unknown'}`,
  });

  const region = profile.hqSigungu ?? '';
  const regionMet = NON_METRO_REGION_CODES.has(region);
  rules.push({
    rule: 'HQ outside the Metropolitan Overcrowding zone (수도권 과밀억제권역 외) — boosts rate',
    met: regionMet,
    reason: `hqSigungu=${region || 'unknown'}`,
  });

  const eligible = revenueOk && industryMet;
  const deductionRate = computeDeductionRate(regionMet, industry);

  return {
    benefitId: 'STX_LAW_ARTICLE_7_SME_SPECIAL',
    ruleKind: 'CORP_TAX_REDUCED',
    benefitName: '중소기업 특별세액감면 (조세특례제한법 §7 ①)',
    lawArticleRef: '조세특례제한법 §7 ①',
    applicableForLawId: '001584',
    rules,
    eligible,
    deductionRate,
    maxYears: SME_MAX_YEARS,
  };
};
