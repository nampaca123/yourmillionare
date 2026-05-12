// Reads/writes tax_law_sync_state — current MST per tracked law + failure tracking.

import { getPool } from './pg-pool.client.js';
import { withRlsContext } from './pg-rls.context.js';

export interface LawSyncStateRow {
  readonly lawId: string;
  readonly lawName: string;
  readonly targetCode: string;
  readonly currentMst: string | null;
  readonly effectiveFrom: string | null;
  readonly lastSyncedAt: string | null;
  readonly consecutiveFailures: number;
  readonly kbChunkActive: boolean;
}

export class PgLawSyncStateRepository {
  async findOne(lawId: string): Promise<LawSyncStateRow | null> {
    const pool = await getPool();
    const res = await pool.query<{
      law_id: string;
      law_name: string;
      target_code: string;
      current_mst: string | null;
      effective_from: string | null;
      last_synced_at: Date | null;
      consecutive_failures: number;
      kb_chunk_active: boolean;
    }>(
      `SELECT law_id, law_name, target_code, current_mst, effective_from::text,
              last_synced_at, consecutive_failures, kb_chunk_active
         FROM tax_law_sync_state WHERE law_id = $1`,
      [lawId],
    );
    const row = res.rows[0];
    if (!row) return null;
    return {
      lawId: row.law_id,
      lawName: row.law_name,
      targetCode: row.target_code,
      currentMst: row.current_mst,
      effectiveFrom: row.effective_from,
      lastSyncedAt: row.last_synced_at ? row.last_synced_at.toISOString() : null,
      consecutiveFailures: row.consecutive_failures,
      kbChunkActive: row.kb_chunk_active,
    };
  }

  async upsertOnSuccess(input: {
    lawId: string;
    lawName: string;
    targetCode: string;
    currentMst: string;
    effectiveFrom: string | null;
  }): Promise<void> {
    await withRlsContext({ isTaxAdmin: true, cognitoSub: 'system' }, async (client) => {
      await client.query(
        `INSERT INTO tax_law_sync_state (law_id, law_name, target_code, current_mst, effective_from, last_synced_at, consecutive_failures)
         VALUES ($1, $2, $3, $4, $5::date, now(), 0)
         ON CONFLICT (law_id) DO UPDATE
           SET law_name = EXCLUDED.law_name,
               target_code = EXCLUDED.target_code,
               current_mst = EXCLUDED.current_mst,
               effective_from = EXCLUDED.effective_from,
               last_synced_at = now(),
               consecutive_failures = 0,
               last_failure_at = NULL,
               last_failure_reason = NULL`,
        [input.lawId, input.lawName, input.targetCode, input.currentMst, input.effectiveFrom],
      );
    });
  }

  async recordFailure(lawId: string, lawName: string, targetCode: string, reason: string): Promise<void> {
    await withRlsContext({ isTaxAdmin: true, cognitoSub: 'system' }, async (client) => {
      await client.query(
        `INSERT INTO tax_law_sync_state (law_id, law_name, target_code, consecutive_failures, last_failure_at, last_failure_reason)
         VALUES ($1, $2, $3, 1, now(), $4)
         ON CONFLICT (law_id) DO UPDATE
           SET consecutive_failures = tax_law_sync_state.consecutive_failures + 1,
               last_failure_at = now(),
               last_failure_reason = EXCLUDED.last_failure_reason`,
        [lawId, lawName, targetCode, reason],
      );
    });
  }
}
