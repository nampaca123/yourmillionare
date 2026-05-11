// Use case: search Korean tax law via Bedrock KB and return citations + disclaimer.

import type { BedrockKbClient, KbSearchInput, KbSearchResult } from '../infrastructure/outbound/bedrock/bedrock-kb.client.js';

export interface SearchTaxLawResponse {
  readonly answer: string;
  readonly citations: KbSearchResult['citations'];
  readonly disclaimer: string;
  readonly asOfDate: string | null;
  readonly verification: {
    readonly kbStale: boolean;
    readonly lastSyncedAt: string | null;
    readonly cacheHit: boolean;
  };
}

const DISCLAIMER = '본 답변은 AI 기반 추정치이며 실제 적용은 세무사 검토가 필요합니다.';
const STALE_DAYS = 30;

export interface KbStalenessReader {
  lastSyncedAt(): Promise<string | null>;
}

export class SearchTaxLawUseCase {
  constructor(
    private readonly kb: BedrockKbClient,
    private readonly stalenessReader: KbStalenessReader,
  ) {}

  async execute(input: KbSearchInput): Promise<SearchTaxLawResponse> {
    const [result, lastSyncedAt] = await Promise.all([this.kb.search(input), this.stalenessReader.lastSyncedAt()]);
    const kbStale = lastSyncedAt
      ? Date.now() - new Date(lastSyncedAt).getTime() > STALE_DAYS * 86_400_000
      : true;
    return {
      answer: result.answer,
      citations: result.citations,
      disclaimer: DISCLAIMER,
      asOfDate: input.asOfDate ?? null,
      verification: { kbStale, lastSyncedAt, cacheHit: false },
    };
  }
}
