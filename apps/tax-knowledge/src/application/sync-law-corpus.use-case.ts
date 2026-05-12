// Use case: walk TARGET_LAW_REGISTRY, fetch latest each law from 법제처, upload raw to S3, update sync state.

import { TARGET_LAW_REGISTRY, type TargetLawDescriptor } from '@ym/law-corpus-core';
import type { OpenLawClient } from '../infrastructure/outbound/open-law/open-law-go-kr.client.js';
import type { S3LawCorpusRepository } from '../infrastructure/outbound/s3/s3-law-corpus.repository.js';
import type { PgLawSyncStateRepository } from '../infrastructure/outbound/pg/pg-law-sync-state.repository.js';
import { logger } from '../shared/logging/logger.js';

export interface SyncReport {
  readonly attempted: number;
  readonly succeeded: ReadonlyArray<{ lawId: string; mst: string; s3Uri: string }>;
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
  ) {}

  async execute(): Promise<SyncReport> {
    const succeeded: { lawId: string; mst: string; s3Uri: string }[] = [];
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

  private async syncOne(law: TargetLawDescriptor): Promise<{ lawId: string; mst: string; s3Uri: string }> {
    const searchResult = await this.openLaw.search({ target: law.target, query: law.lawName, display: 5 });
    const hit = extractFirstHit(searchResult);
    if (!hit) throw new Error(`No hit for ${law.lawName} on OPEN_LAW target=${law.target}`);

    const fullPayload = await this.openLaw.getService({ target: law.target, mst: hit.mst });
    const s3Uri = await this.s3.putRaw({ lawId: law.lawId, mst: hit.mst, payload: fullPayload });
    await this.state.upsertOnSuccess({
      lawId: law.lawId,
      lawName: law.lawName,
      targetCode: law.target,
      currentMst: hit.mst,
      effectiveFrom: hit.effectiveFrom,
    });
    logger.info({ lawId: law.lawId, mst: hit.mst, s3Uri }, 'OPEN_LAW sync ok');
    return { lawId: law.lawId, mst: hit.mst, s3Uri };
  }
}
