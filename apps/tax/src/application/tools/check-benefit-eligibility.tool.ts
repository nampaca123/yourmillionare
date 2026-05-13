// Agent tool: deterministic eligibility check for Korean SMB tax benefits keyed by corp profile + financial-statement signals supplied by the agent.

import type { Tool } from '@ym/agent-core';

const BENEFIT_CODES = [
  'youth_founder_5y',
  'sme_special_reduction',
  'rnd_credit',
  'integrated_investment_credit',
  'employment_increase_credit',
  'social_insurance_subsidy',
] as const;

type BenefitCode = (typeof BENEFIT_CODES)[number];

const inputSchema = {
  type: 'object' as const,
  required: ['benefitCode', 'context'],
  properties: {
    benefitCode: { type: 'string', enum: [...BENEFIT_CODES], description: '확인할 세제 혜택 코드' },
    context: {
      type: 'object',
      required: ['isYouthFounder', 'businessType', 'foundedOn', 'ytdRevenueKrw'],
      properties: {
        isYouthFounder: { type: 'boolean', description: '청년창업자 여부 (corp_profile.is_youth_founder)' },
        isVentureCertified: { type: 'boolean', description: '벤처기업 인증 여부' },
        businessType: { type: 'string', description: 'corporate | sole_proprietor | personal' },
        foundedOn: { type: 'string', description: 'YYYY-MM-DD' },
        industryCode: { type: 'string', description: 'KSIC 5자리 (예: "62010")' },
        ytdRevenueKrw: { type: 'number', description: 'YTD 매출 (KRW)' },
        ytdRndExpenseKrw: { type: 'number', description: 'YTD 연구개발비 (KRW). 있을 때만.' },
        ytdNewEmployeeCount: { type: 'number', description: '올해 신규 채용 인원' },
        regionTier: { type: 'string', description: 'capital | non_capital | special' },
      },
    },
  },
};

interface CheckBenefitInput {
  benefitCode: BenefitCode;
  context: {
    isYouthFounder: boolean;
    isVentureCertified?: boolean;
    businessType: string;
    foundedOn: string;
    industryCode?: string;
    ytdRevenueKrw: number;
    ytdRndExpenseKrw?: number;
    ytdNewEmployeeCount?: number;
    regionTier?: string;
  };
}

export interface CheckBenefitResult {
  readonly summary: string;
  readonly eligible: boolean;
  readonly reasons: ReadonlyArray<string>;
  readonly estimatedReductionKrw: number | null;
  readonly postCompliance: ReadonlyArray<string>;
  readonly legalBasis: string;
}

const yearsSince = (foundedOn: string): number => {
  const founded = new Date(foundedOn);
  const now = new Date();
  return (now.getTime() - founded.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
};

const SME_REVENUE_CAP_KRW = 80_000_000_000;
const YOUTH_FOUNDER_WINDOW_YEARS = 5;
const YOUTH_FOUNDER_NON_CAPITAL_RATE = 1.0;
const YOUTH_FOUNDER_CAPITAL_RATE = 0.5;
const RND_CREDIT_RATE_SME = 0.25;
const EMPLOYMENT_INCREASE_AMOUNT_PER_HEAD = 13_000_000;
const SOCIAL_INSURANCE_SUBSIDY_PER_HEAD = 1_200_000;

const checkYouthFounder = (ctx: CheckBenefitInput['context']): CheckBenefitResult => {
  const reasons: string[] = [];
  let eligible = ctx.isYouthFounder;
  if (!eligible) reasons.push('corp_profile.is_youth_founder=false → 청년창업감면 대상 아님.');
  const years = yearsSince(ctx.foundedOn);
  if (eligible && years > YOUTH_FOUNDER_WINDOW_YEARS) {
    eligible = false;
    reasons.push(`설립 후 ${years.toFixed(1)}년 경과 → 5년 한도 초과.`);
  }
  const rate = ctx.regionTier === 'non_capital' || ctx.regionTier === 'special'
    ? YOUTH_FOUNDER_NON_CAPITAL_RATE
    : YOUTH_FOUNDER_CAPITAL_RATE;
  if (eligible) {
    reasons.push(
      `${rate * 100}% 감면 적용 (${ctx.regionTier === 'non_capital' || ctx.regionTier === 'special' ? '비수도권' : '수도권'}).`,
    );
  }
  const corporateTaxRateEstimate = 0.10;
  const estimatedTaxableIncome = Math.max(0, ctx.ytdRevenueKrw * 0.1);
  const estimatedReductionKrw = eligible
    ? Math.round(estimatedTaxableIncome * corporateTaxRateEstimate * rate)
    : 0;

  return {
    summary: eligible
      ? `청년창업감면 적용 가능 (${rate * 100}%, 추정 절감 ${estimatedReductionKrw.toLocaleString('en-US')} KRW/year)`
      : '청년창업감면 부적격',
    eligible,
    reasons,
    estimatedReductionKrw: eligible ? estimatedReductionKrw : null,
    postCompliance: eligible
      ? [
          '감면 후 5년간 폐업·합병·법인전환 시 감면세액 일부 추징.',
          '대표자 변경(공동대표·승계 등) 시 자격 재검토 필요.',
        ]
      : [],
    legalBasis: '조세특례제한법 §6 ①',
  };
};

const checkSmeSpecialReduction = (ctx: CheckBenefitInput['context']): CheckBenefitResult => {
  const reasons: string[] = [];
  const eligible = ctx.ytdRevenueKrw <= SME_REVENUE_CAP_KRW;
  if (!eligible) {
    reasons.push(`YTD 매출 ${ctx.ytdRevenueKrw.toLocaleString('en-US')} > 800억 → 중소기업 한도 초과.`);
  } else {
    reasons.push('중소기업 매출 한도 충족.');
  }
  return {
    summary: eligible ? '중소기업 특별세액 감면 검토 가능 (업종별 5~30% 감면)' : '중소기업 특별감면 부적격',
    eligible,
    reasons,
    estimatedReductionKrw: null,
    postCompliance: ['업종별 감면율은 KSIC 코드와 지역에 따라 달라짐. search_tax_law로 정확한 조항 확인 필요.'],
    legalBasis: '조세특례제한법 §7',
  };
};

const checkRndCredit = (ctx: CheckBenefitInput['context']): CheckBenefitResult => {
  const rndExpense = ctx.ytdRndExpenseKrw ?? 0;
  const eligible = rndExpense > 0;
  const estimatedReductionKrw = eligible ? Math.round(rndExpense * RND_CREDIT_RATE_SME) : 0;
  return {
    summary: eligible
      ? `R&D 세액공제 25% 적용 가능 (추정 ${estimatedReductionKrw.toLocaleString('en-US')} KRW)`
      : 'R&D 비용 0 → 적용 불가',
    eligible,
    reasons: eligible
      ? [`YTD R&D 비용 ${rndExpense.toLocaleString('en-US')} × 25% = 추정 공제액.`]
      : ['ytdRndExpenseKrw=0 또는 미입력.'],
    estimatedReductionKrw: eligible ? estimatedReductionKrw : null,
    postCompliance: ['연구개발비 명세서 + 증빙 필수. 자체 R&D vs 위탁 R&D 구분 필요.'],
    legalBasis: '조세특례제한법 §10',
  };
};

const checkInvestmentCredit = (ctx: CheckBenefitInput['context']): CheckBenefitResult => ({
  summary: '통합투자세액공제는 실제 자산 투자 명세가 필요해 정확한 판정 불가. search_tax_law + 세무사 확인 권장.',
  eligible: ctx.ytdRevenueKrw > 0,
  reasons: ['투자 자산 증빙이 컨텍스트에 없음 → 정확한 자격은 별도 확인 필요.'],
  estimatedReductionKrw: null,
  postCompliance: ['투자자산 사후관리 5년 (양도·임대 시 추징).'],
  legalBasis: '조세특례제한법 §24',
});

const checkEmploymentIncrease = (ctx: CheckBenefitInput['context']): CheckBenefitResult => {
  const newCount = ctx.ytdNewEmployeeCount ?? 0;
  const eligible = newCount > 0;
  const estimatedReductionKrw = eligible ? newCount * EMPLOYMENT_INCREASE_AMOUNT_PER_HEAD : 0;
  return {
    summary: eligible
      ? `고용증대세제 적용 가능 (신규 ${newCount}명 × ${EMPLOYMENT_INCREASE_AMOUNT_PER_HEAD.toLocaleString('en-US')} = 추정 ${estimatedReductionKrw.toLocaleString('en-US')} KRW)`
      : '신규 채용 0명 → 부적격',
    eligible,
    reasons: eligible
      ? [`ytdNewEmployeeCount=${newCount}, 1인당 1,300만원 추정 (실제 금액은 청년/장년/일반 분류에 따라 다름).`]
      : ['신규 채용 인원 정보 없음 또는 0.'],
    estimatedReductionKrw: eligible ? estimatedReductionKrw : null,
    postCompliance: ['공제 후 2~3년간 신규 채용 인원 유지 필수. 미달 시 추징.'],
    legalBasis: '조세특례제한법 §29-7',
  };
};

const checkSocialInsuranceSubsidy = (ctx: CheckBenefitInput['context']): CheckBenefitResult => {
  const newCount = ctx.ytdNewEmployeeCount ?? 0;
  const eligible = newCount > 0;
  const estimatedReductionKrw = eligible ? newCount * SOCIAL_INSURANCE_SUBSIDY_PER_HEAD : 0;
  return {
    summary: eligible
      ? `사회보험료 세액공제 추정 ${estimatedReductionKrw.toLocaleString('en-US')} KRW`
      : '신규 채용 0명 → 부적격',
    eligible,
    reasons: eligible
      ? [`신규 ${newCount}명 × 추정 1.2M/년 (실제는 보험료 납부액의 50~100%).`]
      : ['신규 채용 인원 정보 없음 또는 0.'],
    estimatedReductionKrw: eligible ? estimatedReductionKrw : null,
    postCompliance: ['고용보험 가입 + 6개월 이상 고용 유지 필수.'],
    legalBasis: '조세특례제한법 §30-4',
  };
};

const evaluators: Record<BenefitCode, (ctx: CheckBenefitInput['context']) => CheckBenefitResult> = {
  youth_founder_5y: checkYouthFounder,
  sme_special_reduction: checkSmeSpecialReduction,
  rnd_credit: checkRndCredit,
  integrated_investment_credit: checkInvestmentCredit,
  employment_increase_credit: checkEmploymentIncrease,
  social_insurance_subsidy: checkSocialInsuranceSubsidy,
};

export const buildCheckBenefitEligibilityTool = (): Tool<CheckBenefitInput, CheckBenefitResult> => ({
  name: 'check_benefit_eligibility',
  description:
    '한국 SMB 세제 혜택의 자격을 deterministic 룰로 판정 (청년창업감면, R&D 세액공제, 중소기업 특별감면, 통합투자세액공제, 고용증대세제, 사회보험료 감면). 매출/인건비/R&D비용 등 raw 재무 수치는 호출자가 직접 입력. 결과는 적용 가능성 + 추정 절감액 + 사후관리 의무.',
  inputSchema,
  execute: async (input: CheckBenefitInput): Promise<CheckBenefitResult> => {
    const evaluator = evaluators[input.benefitCode];
    if (!evaluator) {
      throw new Error(`Unknown benefit code: ${input.benefitCode}`);
    }
    return evaluator(input.context);
  },
});
