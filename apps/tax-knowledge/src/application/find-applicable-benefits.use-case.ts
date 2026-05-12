// Use case: discover tax benefits applicable to a corporation. Per aws-agentic-ai guidance: rule engine BEFORE KB retrieve, DDB entry-guard, deterministic article ordering.

import {
  estimateAnnualSavings,
  evaluateYouthFounderBenefit,
  type CorporationProfileForBenefits,
} from '@ym/tax-core';
import type { BedrockKbClient, KbCitation } from '../infrastructure/outbound/bedrock/bedrock-kb.client.js';
import type { DdbBenefitsCacheAdapter } from '../infrastructure/outbound/ddb/ddb-benefits-cache.adapter.js';

const DISCLAIMER = '본 산정은 추정치이며 실제 적용은 세무사 확인이 필요합니다.';

export interface FindBenefitsInput {
  readonly tenantId: string;
  readonly asOfDate: string;
  readonly profile: CorporationProfileForBenefits;
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

const KB_QUERY_TEMPLATE = (profile: CorporationProfileForBenefits): string =>
  `청년창업자 ${profile.isYouthFounder ? '예' : '아니오'} / 업종 ${profile.industryCode ?? 'unknown'} / 본점 ${profile.hqSigungu ?? 'unknown'} / 창업 ${profile.foundedAt ?? 'unknown'} — 적용 가능한 조세특례제한법 §6 청년창업감면 조건`;

const PROFILE_BASED_CONFIDENCE = 0.85;

export class FindApplicableBenefitsUseCase {
  constructor(
    private readonly kb: BedrockKbClient | null,
    private readonly cache: DdbBenefitsCacheAdapter<FindBenefitsResponse>,
    private readonly lastSyncedAt: () => Promise<string | null>,
  ) {}

  async execute(input: FindBenefitsInput): Promise<FindBenefitsResponse> {
    const profileHash = this.cache.hashProfile(input.profile);
    const cached = await this.cache.get(input.tenantId, profileHash, input.asOfDate);
    if (cached) {
      return { ...cached.payload, verification: { ...cached.payload.verification, cacheHit: true } };
    }

    const candidate = evaluateYouthFounderBenefit(input.profile, input.asOfDate);
    const annualSavings = estimateAnnualSavings(input.profile.priorYearCorpTax, candidate);
    const totalSavings = annualSavings * candidate.maxYears;

    let citations: ReadonlyArray<KbCitation> = [];
    if (this.kb && candidate.eligible) {
      try {
        const result = await this.kb.search({
          query: KB_QUERY_TEMPLATE(input.profile),
          asOfDate: input.asOfDate,
          lawId: candidate.applicableForLawId,
          numberOfResults: 20,
        });
        citations = [...result.citations].sort((a, b) => (a.articleNumber ?? '').localeCompare(b.articleNumber ?? ''));
      } catch {
        citations = [];
      }
    }

    const benefits: BenefitResult[] = [
      {
        benefitId: candidate.benefitId,
        benefitName: candidate.benefitName,
        lawArticle: candidate.lawArticleRef,
        eligibility: { verified: candidate.eligible, rules: candidate.rules },
        estimatedSavings: {
          amount: totalSavings,
          currency: 'KRW',
          basis: `${(candidate.deductionRate * 100).toFixed(0)}% 감면 × ${candidate.maxYears}년 (prior_year_corp_tax 기준)`,
        },
        confidence: candidate.eligible ? PROFILE_BASED_CONFIDENCE : 0,
        citations,
        requiresVerification: true,
      },
    ];

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
