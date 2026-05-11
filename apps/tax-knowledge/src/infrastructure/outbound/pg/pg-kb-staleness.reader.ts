// Reads max(last_synced_at) from tax_law_sync_state to power the verification.kbStale flag.

import { getPool } from './pg-pool.client.js';
import type { KbStalenessReader } from '../../../application/search-tax-law.use-case.js';

export class PgKbStalenessReader implements KbStalenessReader {
  async lastSyncedAt(): Promise<string | null> {
    const pool = await getPool();
    const result = await pool.query<{ last_synced_at: Date | null }>(
      `SELECT MAX(last_synced_at) AS last_synced_at FROM tax_law_sync_state`,
    );
    const ts = result.rows[0]?.last_synced_at;
    return ts ? ts.toISOString() : null;
  }
}
