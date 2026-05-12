// Deterministic eligibility for 조세특례제한법 §6의2 (개인사업자 청년창업자 종합소득세 감면) — personal income variant for sole proprietors.

import type { BenefitCandidate, BenefitEligibilityRule, CorporationProfileForBenefits } from './youth-founder-eligibility.js';

const YOUTH_MAX_YEARS = 5;
const PERSONAL_DEDUCTION_RATE_NON_METRO = 1.0;
const PERSONAL_DEDUCTION_RATE_METRO = 0.5;
const ELIGIBLE_INDUSTRY_PREFIXES: ReadonlyArray<string> = [
  '58', '59', '60', '61', '62', '63',
  '70', '71', '72',
  '26', '27', '28', '29', '30',
];
const NON_METRO_REGION_CODES: ReadonlySet<string> = new Set(['NON_METRO', 'METRO_NON_OVERCROWDED']);

const yearsBetween = (foundedAt: string, asOfDate: string): number | null => {
  const f = new Date(`${foundedAt}T00:00:00Z`).getTime();
  const a = new Date(`${asOfDate}T00:00:00Z`).getTime();
  if (Number.isNaN(f) || Number.isNaN(a)) return null;
  return (a - f) / (365.25 * 86_400_000);
};

export const evaluateIntegratedIncomeYouthFounder = (
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
    rule: 'Business location outside the Metropolitan Overcrowding zone',
    met: regionMet,
    reason: `hqSigungu=${region || 'unknown'}`,
  });

  const industry = profile.industryCode ?? '';
  const industryMet = ELIGIBLE_INDUSTRY_PREFIXES.some((p) => industry.startsWith(p));
  rules.push({
    rule: 'Eligible industry per 조세특례제한법 §6의2 ②',
    met: industryMet,
    reason: `industryCode=${industry || 'unknown'}`,
  });

  const eligible = rules.every((r) => r.met);
  const deductionRate = regionMet ? PERSONAL_DEDUCTION_RATE_NON_METRO : PERSONAL_DEDUCTION_RATE_METRO;

  return {
    benefitId: 'STX_LAW_ARTICLE_6_2_INTEGRATED_INCOME_YOUTH',
    ruleKind: 'CORP_TAX_REDUCED',
    benefitName: '개인사업자 청년창업 종합소득세 감면 (조세특례제한법 §6의2)',
    lawArticleRef: '조세특례제한법 §6의2',
    applicableForLawId: '001584',
    rules,
    eligible,
    deductionRate,
    maxYears: YOUTH_MAX_YEARS,
  };
};
