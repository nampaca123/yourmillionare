// Persists tax_law_chunk_meta rows alongside S3 chunk uploads — drives KB filterable metadata + audit joins.

import { withRlsContext } from './pg-rls.context.js';

export interface ChunkMetaInsert {
  readonly lawId: string;
  readonly mst: string;
  readonly articleNumber: string;
  readonly paragraph: string | null;
  readonly item: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly s3Uri: string;
  readonly publicUrl: string | null;
  readonly ministry: string;
  readonly lawType: 'LAW' | 'DECREE' | 'REGULATION' | 'INTERPRETATION' | 'BYLAW';
}

export class PgLawChunkMetaRepository {
  async closeStaleByLaw(input: { lawId: string; currentMst: string; closedOn: string }): Promise<number> {
    return withRlsContext({ isTaxAdmin: true, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<{ id: string }>(
        `UPDATE tax_law_chunk_meta
            SET effective_to = $3::date
          WHERE law_id = $1 AND mst <> $2 AND effective_to IS NULL
       RETURNING id`,
        [input.lawId, input.currentMst, input.closedOn],
      );
      return result.rowCount ?? 0;
    });
  }

  async upsertMany(rows: ReadonlyArray<ChunkMetaInsert>): Promise<number> {
    if (rows.length === 0) return 0;
    return withRlsContext({ isTaxAdmin: true, cognitoSub: 'system' }, async (client) => {
      let count = 0;
      for (const r of rows) {
        await client.query(
          `INSERT INTO tax_law_chunk_meta
             (law_id, mst, article_number, paragraph, item, effective_from, effective_to,
              s3_uri, public_url, ministry, law_type, ingested_at)
           VALUES ($1, $2, $3, $4, $5, $6::date, $7::date, $8, $9, $10, $11, now())
           ON CONFLICT (law_id, mst, article_number, paragraph, item)
           DO UPDATE SET s3_uri = EXCLUDED.s3_uri,
                         public_url = EXCLUDED.public_url,
                         effective_to = EXCLUDED.effective_to,
                         ingested_at = now(),
                         removed_at = NULL`,
          [
            r.lawId,
            r.mst,
            r.articleNumber,
            r.paragraph,
            r.item,
            r.effectiveFrom,
            r.effectiveTo,
            r.s3Uri,
            r.publicUrl,
            r.ministry,
            r.lawType,
          ],
        );
        count += 1;
      }
      return count;
    });
  }
}
