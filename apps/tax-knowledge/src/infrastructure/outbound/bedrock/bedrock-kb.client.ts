// Bedrock Knowledge Base adapter — performs SEMANTIC_HYBRID retrieve with Cohere Rerank cross-region (Tokyo).

import {
  BedrockAgentRuntimeClient,
  RetrieveAndGenerateCommand,
  type RetrieveAndGenerateCommandOutput,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { BedrockUnavailableError } from '@ym/shared-errors';

const FALLBACK_KB_REGION = 'ap-northeast-2';

export interface KbCitation {
  readonly lawId: string | null;
  readonly lawName: string | null;
  readonly articleNumber: string | null;
  readonly paragraph: string | null;
  readonly effectiveFrom: string | null;
  readonly effectiveTo: string | null;
  readonly sourceUri: string | null;
  readonly publicUrl: string | null;
  readonly excerpt: string;
  readonly rerankScore: number | null;
}

export interface KbSearchInput {
  readonly query: string;
  readonly asOfDate?: string;
  readonly lawId?: string;
  readonly lawType?: 'LAW' | 'DECREE' | 'REGULATION' | 'INTERPRETATION' | 'BYLAW';
  readonly numberOfResults?: number;
}

export interface KbSearchResult {
  readonly answer: string;
  readonly citations: ReadonlyArray<KbCitation>;
  readonly sessionId: string | null;
}

const RETRIEVE_TOP_K = 50;
const RERANK_TOP_K = 5;
const MODEL_ARN_TEMPLATE = (region: string, model: string): string => `arn:aws:bedrock:${region}::foundation-model/${model}`;

const buildFilter = (input: KbSearchInput): Record<string, unknown> | undefined => {
  const asOf = input.asOfDate;
  const conditions: Record<string, unknown>[] = [];
  if (asOf) {
    conditions.push({ lessThanOrEquals: { key: 'effectiveFrom', value: asOf } });
    conditions.push({
      orAll: [
        { equals: { key: 'effectiveTo', value: null } },
        { greaterThanOrEquals: { key: 'effectiveTo', value: asOf } },
      ],
    });
  }
  if (input.lawId) conditions.push({ equals: { key: 'lawId', value: input.lawId } });
  if (input.lawType) conditions.push({ equals: { key: 'lawType', value: input.lawType } });
  return conditions.length > 0 ? { andAll: conditions } : undefined;
};

const extractCitations = (response: RetrieveAndGenerateCommandOutput): ReadonlyArray<KbCitation> => {
  const out: KbCitation[] = [];
  for (const cit of response.citations ?? []) {
    for (const ref of cit.retrievedReferences ?? []) {
      const meta = (ref.metadata ?? {}) as Record<string, unknown>;
      out.push({
        lawId: (meta.lawId as string | undefined) ?? null,
        lawName: (meta.lawName as string | undefined) ?? null,
        articleNumber: (meta.articleNumber as string | undefined) ?? null,
        paragraph: (meta.paragraph as string | undefined) ?? null,
        effectiveFrom: (meta.effectiveFrom as string | undefined) ?? null,
        effectiveTo: (meta.effectiveTo as string | undefined) ?? null,
        sourceUri: ref.location?.s3Location?.uri ?? null,
        publicUrl: (meta.publicUrl as string | undefined) ?? null,
        excerpt: ref.content?.text ?? '',
        rerankScore: null,
      });
    }
  }
  return out;
};

export class BedrockKbClient {
  private readonly client: BedrockAgentRuntimeClient;
  private readonly kbId: string;
  private readonly genModelArn: string;
  private readonly rerankModelArn: string;

  constructor(opts?: { kbId?: string; kbRegion?: string; rerankRegion?: string; rerankModel?: string; genModel?: string }) {
    const kbRegion = opts?.kbRegion ?? process.env.BEDROCK_KB_REGION ?? FALLBACK_KB_REGION;
    const rerankRegion = opts?.rerankRegion ?? process.env.BEDROCK_RERANK_REGION ?? 'ap-northeast-1';
    const rerankModel = opts?.rerankModel ?? process.env.BEDROCK_RERANK_MODEL ?? 'cohere.rerank-v3-5:0';
    const genModel = opts?.genModel ?? process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6';
    this.client = new BedrockAgentRuntimeClient({ region: kbRegion });
    this.kbId = opts?.kbId ?? process.env.BEDROCK_KB_ID ?? '';
    this.genModelArn = MODEL_ARN_TEMPLATE(kbRegion, genModel);
    this.rerankModelArn = MODEL_ARN_TEMPLATE(rerankRegion, rerankModel);
  }

  async search(input: KbSearchInput): Promise<KbSearchResult> {
    if (!this.kbId) {
      throw new BedrockUnavailableError('BEDROCK_KB_ID is not configured');
    }
    const filter = buildFilter(input);
    const command = new RetrieveAndGenerateCommand({
      input: { text: input.query },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: this.kbId,
          modelArn: this.genModelArn,
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: input.numberOfResults ?? RETRIEVE_TOP_K,
              overrideSearchType: 'HYBRID',
              ...(filter ? { filter: filter as never } : {}),
            },
          },
          generationConfiguration: {
            additionalModelRequestFields: {
              rerankingConfiguration: {
                type: 'BEDROCK_RERANKING_MODEL',
                bedrockRerankingConfiguration: {
                  modelConfiguration: { modelArn: this.rerankModelArn },
                  numberOfRerankedResults: RERANK_TOP_K,
                },
              },
            },
          },
        },
      },
    });
    const response = await this.client.send(command);
    return {
      answer: response.output?.text ?? '',
      citations: extractCitations(response),
      sessionId: response.sessionId ?? null,
    };
  }
}
