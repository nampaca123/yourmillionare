// Use case: walk TARGET_LAW_REGISTRY, fetch latest each law from 법제처, upload raw to S3, update sync state.

import { TARGET_LAW_REGISTRY, buildChunks, parseOpenLawDocument, type TargetLawDescriptor } from '@ym/law-corpus-core';
import type { OpenLawClient } from '../infrastructure/outbound/open-law/open-law-go-kr.client.js';
import type { S3LawCorpusRepository } from '../infrastructure/outbound/s3/s3-law-corpus.repository.js';
import type { PgLawSyncStateRepository } from '../infrastructure/outbound/pg/pg-law-sync-state.repository.js';
import type { PgLawChunkMetaRepository } from '../infrastructure/outbound/pg/pg-law-chunk-meta.repository.js';
import { logger } from '../shared/logging/logger.js';

const PUBLIC_LAW_URL = (lawName: string, articleNumber: string): string =>
  `https://www.law.go.kr/법령/${encodeURIComponent(lawName)}/제${articleNumber}조`;

export interface SyncReport {
  readonly attempted: number;
  readonly succeeded: ReadonlyArray<{ lawId: string; mst: string; s3Uri: string; chunkCount: number }>;
  readonly failed: ReadonlyArray<{ lawId: string; reason: string }>;
}

interface OpenLawSearchEnvelope {
  readonly LawSearch?: {
    readonly law?: ReadonlyArray<{
      readonly 법령ID?: string | number;
      readonly 법령일련번호?: string | number;
      readonly 시행일자?: string | number;
    }>;
  };
}

const formatIsoFromYmd = (ymd: string | number | undefined): string | null => {
  if (!ymd) return null;
  const s = String(ymd);
  if (s.length !== 8) return null;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

const extractFirstHit = (
  payload: unknown,
): { mst: string; effectiveFrom: string | null } | null => {
  const env = payload as OpenLawSearchEnvelope;
  const first = env.LawSearch?.law?.[0];
  if (!first) return null;
  const mst = first.법령일련번호 !== undefined ? String(first.법령일련번호) : '';
  if (!mst) return null;
  return { mst, effectiveFrom: formatIsoFromYmd(first.시행일자) };
};

export class SyncLawCorpusUseCase {
  constructor(
    private readonly openLaw: OpenLawClient,
    private readonly s3: S3LawCorpusRepository,
    private readonly state: PgLawSyncStateRepository,
    private readonly chunkMeta: PgLawChunkMetaRepository,
  ) {}

  async execute(): Promise<SyncReport> {
    const succeeded: { lawId: string; mst: string; s3Uri: string; chunkCount: number }[] = [];
    const failed: { lawId: string; reason: string }[] = [];

    for (const law of TARGET_LAW_REGISTRY) {
      try {
        const result = await this.syncOne(law);
        succeeded.push(result);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        logger.error({ lawId: law.lawId, reason }, 'OPEN_LAW sync failed');
        await this.state.recordFailure(law.lawId, law.lawName, law.target, reason);
        failed.push({ lawId: law.lawId, reason });
      }
    }

    return { attempted: TARGET_LAW_REGISTRY.length, succeeded, failed };
  }

  private async syncOne(
    law: TargetLawDescriptor,
  ): Promise<{ lawId: string; mst: string; s3Uri: string; chunkCount: number }> {
    const searchResult = await this.openLaw.search({ target: law.target, query: law.lawName, search: 1, display: 20 });
    const hit = extractFirstHit(searchResult);
    if (!hit) throw new Error(`No hit for ${law.lawName} on OPEN_LAW target=${law.target}`);

    const fullPayload = await this.openLaw.getService({ target: law.target, mst: hit.mst });
    const s3Uri = await this.s3.putRaw({ lawId: law.lawId, mst: hit.mst, payload: fullPayload });

    const document = parseOpenLawDocument(fullPayload, {
      lawId: law.lawId,
      lawName: law.lawName,
      ministry: law.ministry,
      effectiveFrom: hit.effectiveFrom ?? '1900-01-01',
    });
    const chunks = buildChunks(document.articles, {
      lawId: law.lawId,
      lawName: law.lawName,
      lawType: law.lawType,
      ministry: law.ministry,
      mst: hit.mst,
      effectiveFrom: document.metadata.effectiveFromYmd || hit.effectiveFrom || '1900-01-01',
      effectiveTo: null,
      revisionDate: document.metadata.publishedYmd,
      sourceUriBuilder: (lawId, mst, articleNumber) =>
        `s3://${this.s3.bucketName()}/chunks/${lawId}/${mst}/article-${articleNumber}.json`,
    });

    for (const chunk of chunks) {
      await this.s3.putChunk({
        lawId: law.lawId,
        mst: hit.mst,
        articleNumber: chunk.filterable.articleNumber,
        payload: { content: chunk.content, display: chunk.display, filterable: chunk.filterable },
      });
      await this.s3.putChunkMetadata({
        lawId: law.lawId,
        mst: hit.mst,
        articleNumber: chunk.filterable.articleNumber,
        metadata: {
          lawId: chunk.filterable.lawId,
          lawType: chunk.filterable.lawType,
          articleNumber: chunk.filterable.articleNumber,
          effectiveFrom: chunk.filterable.effectiveFrom,
          effectiveTo: chunk.filterable.effectiveTo ?? 'open',
        },
      });
    }

    await this.chunkMeta.closeStaleByLaw({ lawId: law.lawId, currentMst: hit.mst, closedOn: new Date().toISOString().slice(0, 10) });
    await this.chunkMeta.upsertMany(
      chunks.map((c) => ({
        lawId: c.filterable.lawId,
        mst: hit.mst,
        articleNumber: c.filterable.articleNumber,
        paragraph: c.display.paragraph,
        item: c.display.item,
        effectiveFrom: c.filterable.effectiveFrom,
        effectiveTo: c.filterable.effectiveTo,
        s3Uri: c.display.sourceUri,
        publicUrl: PUBLIC_LAW_URL(law.lawName, c.filterable.articleNumber),
        ministry: c.filterable.ministry,
        lawType: c.filterable.lawType,
      })),
    );

    await this.state.upsertOnSuccess({
      lawId: law.lawId,
      lawName: law.lawName,
      targetCode: law.target,
      currentMst: hit.mst,
      effectiveFrom: hit.effectiveFrom,
    });
    logger.info({ lawId: law.lawId, mst: hit.mst, s3Uri, chunkCount: chunks.length }, 'OPEN_LAW sync + chunk ok');
    return { lawId: law.lawId, mst: hit.mst, s3Uri, chunkCount: chunks.length };
  }
}
