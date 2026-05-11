// Per-tenant ingestion progress reader against raw_transactions + journal_entries.

import { withRlsContext } from './pg-rls.context.js';
import type {
  SyncStateRepository,
  SyncStateSnapshot,
} from '../../../application/ports/sync-state.repository.port.js';

interface CountRow {
  undispatched: string;
  dispatched: string;
  classified: string;
  last_fetched_at: Date | null;
  last_classified_at: Date | null;
}

export class PgSyncStateRepository implements SyncStateRepository {
  async snapshot({ tenantId }: { tenantId: string }): Promise<SyncStateSnapshot> {
    return withRlsContext({ tenantId, cognitoSub: 'system' }, async (client) => {
      const result = await client.query<CountRow>(
        `SELECT
           COALESCE(SUM(CASE WHEN rt.dispatched_at IS NULL THEN 1 ELSE 0 END), 0) AS undispatched,
           COALESCE(SUM(CASE WHEN rt.dispatched_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS dispatched,
           COALESCE((
             SELECT COUNT(DISTINCT source_ref_id) FROM journal_entries
             WHERE tenant_id = $1 AND source_ref_id IS NOT NULL
           ), 0) AS classified,
           MAX(rt.fetched_at) AS last_fetched_at,
           (SELECT MAX(created_at) FROM journal_entries WHERE tenant_id = $1) AS last_classified_at
         FROM raw_transactions rt
         WHERE rt.tenant_id = $1`,
        [tenantId],
      );
      const row = result.rows[0];
      return {
        undispatched: Number.parseInt(row?.undispatched ?? '0', 10),
        dispatched: Number.parseInt(row?.dispatched ?? '0', 10),
        classified: Number.parseInt(row?.classified ?? '0', 10),
        lastFetchedAt: row?.last_fetched_at ? row.last_fetched_at.toISOString() : null,
        lastClassifiedAt: row?.last_classified_at ? row.last_classified_at.toISOString() : null,
      };
    });
  }
}
