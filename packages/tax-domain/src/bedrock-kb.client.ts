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

const RERANK_TOP_K = 5;

// Inference profiles have prefixes like "global.", "us.", "apac." etc. and account-scoped ARNs.
// Plain foundation models use the no-account ARN form.
const isInferenceProfile = (model: string): boolean => /^[a-z]+\./.test(model);

const buildModelArn = (region: string, model: string, accountId: string | undefined): string => {
  if (isInferenceProfile(model) && accountId) {
    return `arn:aws:bedrock:${region}:${accountId}:inference-profile/${model}`;
  }
  return `arn:aws:bedrock:${region}::foundation-model/${model}`;
};

const buildFilter = (input: KbSearchInput): Record<string, unknown> | undefined => {
  // Bedrock KB filter operators lessThanOrEquals / greaterThanOrEquals require numeric values.
  // Our effectiveFrom/effectiveTo are stored as string dates → comparison fails. The model receives
  // asOfDate via the system/user prompt and reasons about effectiveness in its response. We keep
  // only structural filters (lawId / lawType) for narrowing.
  const conditions: Record<string, unknown>[] = [];
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

  constructor(opts?: {
    kbId?: string;
    kbRegion?: string;
    rerankRegion?: string;
    rerankModel?: string;
    genModel?: string;
    accountId?: string;
  }) {
    const kbRegion = opts?.kbRegion ?? process.env.BEDROCK_KB_REGION ?? FALLBACK_KB_REGION;
    const genModel = opts?.genModel ?? process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6';
    const accountId = opts?.accountId ?? process.env.AWS_ACCOUNT_ID;
    this.client = new BedrockAgentRuntimeClient({ region: kbRegion });
    this.kbId = opts?.kbId ?? process.env.BEDROCK_KB_ID ?? '';
    this.genModelArn = buildModelArn(kbRegion, genModel, accountId);
  }

  async search(input: KbSearchInput): Promise<KbSearchResult> {
    if (!this.kbId) {
      throw new BedrockUnavailableError('BEDROCK_KB_ID is not configured');
    }
    const filter = buildFilter(input);
    // Rerank is intentionally omitted: it lives at retrievalConfiguration.rerankingConfiguration in newer SDK shapes
    // but was being passed to the generation model (Claude) via additionalModelRequestFields and 400'd as "Extra inputs are not permitted".
    // For agent-tool usage SEMANTIC retrieve with top-K is sufficient; the agent re-summarizes anyway.
    const command = new RetrieveAndGenerateCommand({
      input: { text: input.query },
      retrieveAndGenerateConfiguration: {
        type: 'KNOWLEDGE_BASE',
        knowledgeBaseConfiguration: {
          knowledgeBaseId: this.kbId,
          modelArn: this.genModelArn,
          retrievalConfiguration: {
            vectorSearchConfiguration: {
              numberOfResults: input.numberOfResults ?? RERANK_TOP_K,
              overrideSearchType: 'SEMANTIC',
              ...(filter ? { filter: filter as never } : {}),
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
