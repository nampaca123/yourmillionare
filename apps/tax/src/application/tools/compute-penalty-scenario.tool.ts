// Agent tool: deterministic Korean tax penalty calculator (신고불성실 + 납부지연 가산세) used by the strategy agent to quote exact penalty figures instead of guessing.

import type { Tool } from '@ym/agent-core';

const NON_FILING_RATE = 0.20;
const UNDER_REPORT_RATE = 0.10;
const UNDER_REPORT_FRAUD_RATE = 0.40;
const LATE_PAYMENT_DAILY_RATE = 0.022 / 100;
const VOLUNTARY_AMENDMENT_DISCOUNT: ReadonlyArray<{ withinMonths: number; rate: number }> = [
  { withinMonths: 1, rate: 0.9 },
  { withinMonths: 3, rate: 0.75 },
  { withinMonths: 6, rate: 0.5 },
  { withinMonths: 12, rate: 0.3 },
  { withinMonths: 24, rate: 0.2 },
];

const FILING_KINDS = ['VAT', 'CORP', 'WH', 'LOCAL_INCOME', 'COMPREHENSIVE_INCOME'] as const;
const PENALTY_TYPES = ['non_filing', 'under_report', 'under_report_fraud'] as const;

type FilingKind = (typeof FILING_KINDS)[number];
type PenaltyType = (typeof PENALTY_TYPES)[number];

const inputSchema = {
  type: 'object' as const,
  required: ['filingKind', 'penaltyType', 'underpaidAmountKrw', 'daysLate'],
  properties: {
    filingKind: { type: 'string', enum: [...FILING_KINDS], description: '신고 종류' },
    penaltyType: { type: 'string', enum: [...PENALTY_TYPES], description: '가산세 유형 (무신고 / 과소신고 / 부정과소신고)' },
    underpaidAmountKrw: { type: 'number', description: '미납 또는 과소 신고된 본세 (KRW, 양수)' },
    daysLate: { type: 'number', description: '신고일 또는 납부일이 법정 기한을 초과한 일수 (0 이상)' },
    voluntaryAmendmentWithinMonths: {
      type: 'number',
      description: '자진 수정 신고 시점 (법정 기한 후 N개월). 미입력 시 감면 0%.',
    },
  },
};

interface ComputePenaltyInput {
  filingKind: FilingKind;
  penaltyType: PenaltyType;
  underpaidAmountKrw: number;
  daysLate: number;
  voluntaryAmendmentWithinMonths?: number;
}

export interface ComputePenaltyResult {
  readonly summary: string;
  readonly filingPenaltyKrw: number;
  readonly latePaymentInterestKrw: number;
  readonly totalKrw: number;
  readonly appliedRate: number;
  readonly voluntaryDiscountRate: number;
  readonly assumptions: ReadonlyArray<string>;
}

const baseFilingRate = (penaltyType: PenaltyType): number => {
  if (penaltyType === 'non_filing') return NON_FILING_RATE;
  if (penaltyType === 'under_report_fraud') return UNDER_REPORT_FRAUD_RATE;
  return UNDER_REPORT_RATE;
};

const lookupVoluntaryDiscount = (months: number | undefined): number => {
  if (months === undefined || months <= 0) return 0;
  for (const bracket of VOLUNTARY_AMENDMENT_DISCOUNT) {
    if (months <= bracket.withinMonths) return bracket.rate;
  }
  return 0;
};

const round = (value: number): number => Math.round(value);

export const buildComputePenaltyTool = (): Tool<ComputePenaltyInput, ComputePenaltyResult> => ({
  name: 'compute_penalty_scenario',
  description:
    '국세기본법상 신고불성실 가산세 + 납부지연 가산세를 계산. 자진 수정 신고 감면(국기법 §48)을 옵션으로 반영. 모든 금액 단위는 KRW.',
  inputSchema,
  execute: async (input: ComputePenaltyInput): Promise<ComputePenaltyResult> => {
    if (input.underpaidAmountKrw < 0 || input.daysLate < 0) {
      throw new Error('underpaidAmountKrw and daysLate must be non-negative');
    }
    const filingRate = baseFilingRate(input.penaltyType);
    const discountRate = lookupVoluntaryDiscount(input.voluntaryAmendmentWithinMonths);
    const filingPenaltyGross = input.underpaidAmountKrw * filingRate;
    const filingPenaltyKrw = round(filingPenaltyGross * (1 - discountRate));
    const latePaymentInterestKrw = round(
      input.underpaidAmountKrw * LATE_PAYMENT_DAILY_RATE * input.daysLate,
    );
    const totalKrw = filingPenaltyKrw + latePaymentInterestKrw;

    const assumptions: string[] = [
      `Filing penalty rate ${filingRate * 100}% (국기법 §47-2/§47-3).`,
      `Late payment interest 0.022%/day (국기법 §47-4, 적용 기간 동안 동일 적용 가정).`,
    ];
    if (discountRate > 0) {
      assumptions.push(
        `Voluntary amendment discount ${discountRate * 100}% (국기법 §48, 수정신고 시점 ${input.voluntaryAmendmentWithinMonths}개월 이내).`,
      );
    }
    if (input.daysLate === 0) {
      assumptions.push('daysLate=0 → 납부지연 가산세 0.');
    }

    return {
      summary: `[${input.filingKind}] 가산세 ${filingPenaltyKrw.toLocaleString('en-US')} + 납부지연 ${latePaymentInterestKrw.toLocaleString('en-US')} = ${totalKrw.toLocaleString('en-US')} KRW`,
      filingPenaltyKrw,
      latePaymentInterestKrw,
      totalKrw,
      appliedRate: filingRate,
      voluntaryDiscountRate: discountRate,
      assumptions,
    };
  },
});
