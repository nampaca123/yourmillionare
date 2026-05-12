// Use case: discover tax benefits applicable to a corporation. Per aws-agentic-ai guidance: rule engine BEFORE KB retrieve, DDB entry-guard, deterministic article ordering.

import {
  estimateAnnualSavings,
  evaluateYouthFounderBenefit,
  evaluateSmeSpecialDeduction,
  evaluateRndTaxCredit,
  evaluateIntegratedIncomeYouthFounder,
  type BenefitCandidate,
  type CorporationProfileForBenefits,
} from '@ym/tax-core';
import type { BedrockKbClient, KbCitation } from '../infrastructure/outbound/bedrock/bedrock-kb.client.js';
import type { DdbBenefitsCacheAdapter } from '../infrastructure/outbound/ddb/ddb-benefits-cache.adapter.js';

const DISCLAIMER = '본 산정은 추정치이며 실제 적용은 세무사 확인이 필요합니다.';

export type TenantType = 'personal' | 'corporation';

export interface FindBenefitsInput {
  readonly tenantId: string;
  readonly asOfDate: string;
  readonly tenantType: TenantType;
  readonly profile: CorporationProfileForBenefits & { readonly priorYearRevenue?: number | null };
}

export interface BenefitResult {
  readonly benefitId: string;
  readonly benefitName: string;
  readonly lawArticle: string;
  readonly eligibility: {
    readonly verified: boolean;
    readonly rules: ReadonlyArray<{ rule: string; met: boolean; reason: string }>;
  };
  readonly estimatedSavings: { amount: number; currency: 'KRW'; basis: string };
  readonly confidence: number;
  readonly citations: ReadonlyArray<KbCitation>;
  readonly requiresVerification: boolean;
}

export interface FindBenefitsResponse {
  readonly benefits: ReadonlyArray<BenefitResult>;
  readonly asOfDate: string;
  readonly totalEstimatedSavings: { amount: number; currency: 'KRW' };
  readonly disclaimer: string;
  readonly verification: {
    readonly cacheHit: boolean;
    readonly kbStale: boolean;
    readonly lastSyncedAt: string | null;
  };
}

const PROFILE_BASED_CONFIDENCE = 0.85;
const KB_RESULT_LIMIT = 20;
const HORIZON_YEARS_FOR_OPEN_ENDED = 5;

const kbQueryFor = (candidate: BenefitCandidate, profile: CorporationProfileForBenefits): string =>
  `${candidate.benefitName} 적용 요건. 업종 ${profile.industryCode ?? 'unknown'} / 본점 ${profile.hqSigungu ?? 'unknown'} / 창업 ${profile.foundedAt ?? 'unknown'}`;

const summarizeRate = (candidate: BenefitCandidate): string => {
  const pct = `${(candidate.deductionRate * 100).toFixed(0)}%`;
  const horizon = candidate.maxYears >= 100 ? '연 단위 반복 적용' : `${candidate.maxYears}년`;
  return `${pct} 감면 × ${horizon}`;
};

const horizonYears = (candidate: BenefitCandidate): number =>
  candidate.maxYears >= 100 ? HORIZON_YEARS_FOR_OPEN_ENDED : candidate.maxYears;

export class FindApplicableBenefitsUseCase {
  constructor(
    private readonly kb: BedrockKbClient | null,
    private readonly cache: DdbBenefitsCacheAdapter<FindBenefitsResponse>,
    private readonly lastSyncedAt: () => Promise<string | null>,
  ) {}

  private async fetchCitations(
    candidate: BenefitCandidate,
    profile: CorporationProfileForBenefits,
    asOfDate: string,
  ): Promise<ReadonlyArray<KbCitation>> {
    if (!this.kb || !candidate.eligible) return [];
    try {
      const result = await this.kb.search({
        query: kbQueryFor(candidate, profile),
        asOfDate,
        lawId: candidate.applicableForLawId,
        numberOfResults: KB_RESULT_LIMIT,
      });
      return [...result.citations].sort((a, b) => (a.articleNumber ?? '').localeCompare(b.articleNumber ?? ''));
    } catch {
      return [];
    }
  }

  private buildBenefit(
    candidate: BenefitCandidate,
    citations: ReadonlyArray<KbCitation>,
    priorYearCorpTax: number | null,
  ): BenefitResult {
    const annualSavings = estimateAnnualSavings(priorYearCorpTax, candidate);
    const totalSavings = annualSavings * horizonYears(candidate);
    return {
      benefitId: candidate.benefitId,
      benefitName: candidate.benefitName,
      lawArticle: candidate.lawArticleRef,
      eligibility: { verified: candidate.eligible, rules: candidate.rules },
      estimatedSavings: {
        amount: totalSavings,
        currency: 'KRW',
        basis: `${summarizeRate(candidate)} (prior_year_corp_tax 기준)`,
      },
      confidence: candidate.eligible ? PROFILE_BASED_CONFIDENCE : 0,
      citations,
      requiresVerification: true,
    };
  }

  async execute(input: FindBenefitsInput): Promise<FindBenefitsResponse> {
    const profileHash = this.cache.hashProfile(input.profile);
    const cached = await this.cache.get(input.tenantId, profileHash, input.asOfDate);
    if (cached) {
      return { ...cached.payload, verification: { ...cached.payload.verification, cacheHit: true } };
    }

    const candidates: ReadonlyArray<BenefitCandidate> = input.tenantType === 'personal'
      ? [evaluateIntegratedIncomeYouthFounder(input.profile, input.asOfDate)]
      : [
          evaluateYouthFounderBenefit(input.profile, input.asOfDate),
          evaluateSmeSpecialDeduction(input.profile, input.asOfDate),
          evaluateRndTaxCredit(input.profile, input.asOfDate),
        ];

    const benefits = await Promise.all(
      candidates.map(async (candidate) => {
        const citations = await this.fetchCitations(candidate, input.profile, input.asOfDate);
        return this.buildBenefit(candidate, citations, input.profile.priorYearCorpTax);
      }),
    );

    const lastSyncedAt = await this.lastSyncedAt();
    const STALE_MS = 30 * 86_400_000;
    const kbStale = lastSyncedAt ? Date.now() - new Date(lastSyncedAt).getTime() > STALE_MS : true;

    const response: FindBenefitsResponse = {
      benefits,
      asOfDate: input.asOfDate,
      totalEstimatedSavings: {
        amount: benefits.reduce((s, b) => s + b.estimatedSavings.amount, 0),
        currency: 'KRW',
      },
      disclaimer: DISCLAIMER,
      verification: { cacheHit: false, kbStale, lastSyncedAt },
    };

    await this.cache.put(input.tenantId, profileHash, input.asOfDate, response);
    return response;
  }
}
