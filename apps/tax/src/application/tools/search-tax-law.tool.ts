// Agent tool: searches the Bedrock Knowledge Base over the Korean tax law corpus and returns answer + citations.

import type { Tool } from '@ym/agent-core';
import { BedrockKbClient, type KbSearchResult } from '@ym/tax-domain';

const inputSchema = {
  type: 'object' as const,
  required: ['query'],
  properties: {
    query: { type: 'string', description: '한국어 법령/판례 검색 질의어 (예: "R&D 세액공제 한도 2026")' },
    asOfDate: { type: 'string', description: '법령 유효일자 (선택, YYYY-MM-DD)' },
  },
};

interface SearchInput {
  query: string;
  asOfDate?: string;
}

export interface SearchToolResult {
  readonly summary: string;
  readonly answer: string;
  readonly citationCount: number;
  readonly citations: ReadonlyArray<{ lawName: string | null; articleNumber: string | null; excerpt: string }>;
}

const buildResult = (kb: KbSearchResult): SearchToolResult => ({
  summary: `${kb.citations.length}개 법령 인용을 찾았습니다.`,
  answer: kb.answer.slice(0, 4000),
  citationCount: kb.citations.length,
  citations: kb.citations.slice(0, 5).map((c) => ({
    lawName: c.lawName,
    articleNumber: c.articleNumber,
    excerpt: c.excerpt.slice(0, 400),
  })),
});

export const buildSearchTaxLawTool = (kbClient: BedrockKbClient): Tool<SearchInput, SearchToolResult> => ({
  name: 'search_tax_law',
  description: '한국 세법 코퍼스(조특법, 법인세법, 부가가치세법 등)에서 인용 가능한 조문/판례를 검색한다. 자연어 질의어를 받고 답변+인용 5개까지 반환.',
  inputSchema,
  execute: async (input) => {
    const result = await kbClient.search({
      query: input.query,
      ...(input.asOfDate ? { asOfDate: input.asOfDate } : {}),
    });
    return buildResult(result);
  },
});
