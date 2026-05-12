// Deterministic eligibility rule engine for 조세특례제한법 §6 (창업중소기업 등에 대한 세액감면) — 청년창업자 path.

import type { RuleKind } from '../types.js';

const YOUTH_MAX_YEARS = 5;
const YOUTH_DEDUCTION_RATE_NON_METRO = 1.0;
const YOUTH_DEDUCTION_RATE_METRO = 0.5;
const ELIGIBLE_INDUSTRY_PREFIXES: ReadonlyArray<string> = [
  '58', '59', '60', '61', '62', '63',
  '70', '71', '72',
  '26', '27', '28', '29', '30',
];
const NON_METRO_REGION_CODES: ReadonlySet<string> = new Set(['NON_METRO', 'METRO_NON_OVERCROWDED']);

export interface CorporationProfileForBenefits {
  readonly industryCode: string | null;
  readonly foundedAt: string | null;
  readonly isYouthFounder: boolean;
  readonly hqSigungu: string | null;
  readonly priorYearCorpTax: number | null;
}

export interface BenefitEligibilityRule {
  readonly rule: string;
  readonly met: boolean;
  readonly reason: string;
}

export interface BenefitCandidate {
  readonly benefitId: string;
  readonly ruleKind: RuleKind;
  readonly benefitName: string;
  readonly lawArticleRef: string;
  readonly applicableForLawId: string;
  readonly rules: ReadonlyArray<BenefitEligibilityRule>;
  readonly eligible: boolean;
  readonly deductionRate: number;
  readonly maxYears: number;
}

const yearsBetween = (foundedAt: string, asOfDate: string): number | null => {
  const f = new Date(`${foundedAt}T00:00:00Z`).getTime();
  const a = new Date(`${asOfDate}T00:00:00Z`).getTime();
  if (Number.isNaN(f) || Number.isNaN(a)) return null;
  return (a - f) / (365.25 * 86_400_000);
};

export const evaluateYouthFounderBenefit = (
  profile: CorporationProfileForBenefits,
  asOfDate: string,
): BenefitCandidate => {
  const rules: BenefitEligibilityRule[] = [];

  const ageOk = profile.foundedAt
    ? (yearsBetween(profile.foundedAt, asOfDate) ?? Number.POSITIVE_INFINITY) <= YOUTH_MAX_YEARS
    : false;
  rules.push({
    rule: `Founded within ${YOUTH_MAX_YEARS} years`,
    met: ageOk,
    reason: profile.foundedAt ? `foundedAt=${profile.foundedAt}, asOf=${asOfDate}` : 'foundedAt missing',
  });

  rules.push({
    rule: 'Youth founder (15–34 years old at founding)',
    met: profile.isYouthFounder,
    reason: `isYouthFounder=${profile.isYouthFounder}`,
  });

  const region = profile.hqSigungu ?? '';
  const regionMet = NON_METRO_REGION_CODES.has(region);
  rules.push({
    rule: 'HQ outside the Metropolitan Overcrowding zone (수도권 과밀억제권역 외)',
    met: regionMet,
    reason: `hqSigungu=${region || 'unknown'}`,
  });

  const industry = profile.industryCode ?? '';
  const industryMet = ELIGIBLE_INDUSTRY_PREFIXES.some((p) => industry.startsWith(p));
  rules.push({
    rule: 'Eligible industry per 조세특례제한법 §6 ③',
    met: industryMet,
    reason: `industryCode=${industry || 'unknown'}`,
  });

  const eligible = rules.every((r) => r.met);
  const deductionRate = regionMet ? YOUTH_DEDUCTION_RATE_NON_METRO : YOUTH_DEDUCTION_RATE_METRO;

  return {
    benefitId: 'STX_LAW_ARTICLE_6_PARAGRAPH_1_YOUTH',
    ruleKind: 'CORP_TAX_REDUCED',
    benefitName: '청년창업중소기업 등에 대한 세액감면 (조세특례제한법 §6 ①)',
    lawArticleRef: '조세특례제한법 §6 ①',
    applicableForLawId: '001584',
    rules,
    eligible,
    deductionRate,
    maxYears: YOUTH_MAX_YEARS,
  };
};

export const estimateAnnualSavings = (
  priorYearCorpTax: number | null,
  candidate: BenefitCandidate,
): number => {
  if (!candidate.eligible || !priorYearCorpTax || priorYearCorpTax <= 0) return 0;
  return Math.round(priorYearCorpTax * candidate.deductionRate);
};
