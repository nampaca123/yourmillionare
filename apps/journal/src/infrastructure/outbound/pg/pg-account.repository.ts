// PostgreSQL AccountRepository: bulk-inserts K-IFRS seed accounts with ON CONFLICT DO NOTHING.

import type { PoolClient } from 'pg';
import type { SeedAccount } from '../../../domain/seed-accounts.js';
import type { AccountRepository } from '../../../application/ports/account.repository.port.js';
import { withRlsContext } from './pg-rls.context.js';

export class PgAccountRepository implements AccountRepository {
  async countByTenant(tenantId: string, userId: string): Promise<number> {
    return withRlsContext({ userId, tenantId }, async (c: PoolClient) => {
      const result = await c.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM accounts WHERE tenant_id = $1',
        [tenantId],
      );
      return parseInt(result.rows[0]?.count ?? '0', 10);
    });
  }

  async bulkInsertOnConflictDoNothing(accounts: SeedAccount[], tenantId: string, userId: string): Promise<void> {
    if (accounts.length === 0) return;
    return withRlsContext({ userId, tenantId }, async (c: PoolClient) => {
      const values = accounts
        .map((_, i) => {
          const base = i * 6;
          return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
        })
        .join(', ');

      const params = accounts.flatMap((a) => [tenantId, a.code, a.name, a.displayName, a.type, a.normalBalance]);

      await c.query(
        `INSERT INTO accounts (tenant_id, code, name, display_name, type, normal_balance)
         VALUES ${values}
         ON CONFLICT (tenant_id, code) DO NOTHING`,
        params,
      );
    });
  }
}
