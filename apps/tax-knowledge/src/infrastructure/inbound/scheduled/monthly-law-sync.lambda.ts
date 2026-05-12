// Lambda entry: monthly OPEN_LAW corpus sync. Fetches latest revisions for the 6 tax laws + uploads raw JSON to S3.

import { OpenLawClient } from '../../outbound/open-law/open-law-go-kr.client.js';
import { S3LawCorpusRepository } from '../../outbound/s3/s3-law-corpus.repository.js';
import { PgLawSyncStateRepository } from '../../outbound/pg/pg-law-sync-state.repository.js';
import { SyncLawCorpusUseCase } from '../../../application/sync-law-corpus.use-case.js';

export const handler = async (): Promise<{ ok: boolean; attempted: number; succeededCount: number; failedCount: number }> => {
  const oc = process.env.OPEN_LAW_OC ?? '';
  const bucket = process.env.LEGAL_KB_BUCKET ?? '';
  const openLaw = new OpenLawClient({ oc });
  const s3 = new S3LawCorpusRepository({ bucket });
  const state = new PgLawSyncStateRepository();
  const useCase = new SyncLawCorpusUseCase(openLaw, s3, state);
  const report = await useCase.execute();
  return {
    ok: report.failed.length === 0,
    attempted: report.attempted,
    succeededCount: report.succeeded.length,
    failedCount: report.failed.length,
  };
};
