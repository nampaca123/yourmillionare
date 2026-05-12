// Deterministic eligibility for 조세특례제한법 §10 (연구 및 인력개발비 세액공제) — R&D tax credit (SME preferential rate).

import type { BenefitCandidate, BenefitEligibilityRule, CorporationProfileForBenefits } from './youth-founder-eligibility.js';

const SME_RND_DEDUCTION_RATE = 0.25;
const RND_MAX_YEARS = 999;
const REVENUE_CEILING_KRW = 5_000_000_000;

const RND_LIKELY_INDUSTRY_PREFIXES: ReadonlyArray<string> = [
  '21',
  '26', '27', '28', '29', '30',
  '58', '59', '60', '61', '62', '63',
  '70', '71', '72',
];

export interface RndBenefitInput extends CorporationProfileForBenefits {
  readonly priorYearRevenue?: number | null;
}

export const evaluateRndTaxCredit = (
  profile: RndBenefitInput,
  _asOfDate: string,
): BenefitCandidate => {
  const rules: BenefitEligibilityRule[] = [];

  const revenue = profile.priorYearRevenue ?? null;
  const smeRevenue = revenue !== null && revenue > 0 && revenue <= REVENUE_CEILING_KRW;
  rules.push({
    rule: `SME revenue threshold (under KRW ${REVENUE_CEILING_KRW.toLocaleString()})`,
    met: smeRevenue,
    reason: revenue === null ? 'priorYearRevenue missing' : `priorYearRevenue=${revenue}`,
  });

  const industry = profile.industryCode ?? '';
  const industryMet = RND_LIKELY_INDUSTRY_PREFIXES.some((p) => industry.startsWith(p));
  rules.push({
    rule: 'Industry typically incurs R&D expense (per 조세특례제한법 별표6)',
    met: industryMet,
    reason: `industryCode=${industry || 'unknown'}`,
  });

  rules.push({
    rule: 'Requires actual R&D expenditure in current period (verified at filing time)',
    met: false,
    reason: 'Verification deferred to filing draft — surface as candidate only.',
  });

  const eligible = smeRevenue && industryMet;

  return {
    benefitId: 'STX_LAW_ARTICLE_10_RND_CREDIT_SME',
    ruleKind: 'CORP_TAX_REDUCED',
    benefitName: '연구·인력개발비 세액공제 — 중소기업 우대 (조세특례제한법 §10)',
    lawArticleRef: '조세특례제한법 §10',
    applicableForLawId: '001584',
    rules,
    eligible,
    deductionRate: SME_RND_DEDUCTION_RATE,
    maxYears: RND_MAX_YEARS,
  };
};
