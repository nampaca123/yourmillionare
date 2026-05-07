// AccountRepository port: read/write chart of accounts per tenant.

import type { SeedAccount } from '../../domain/seed-accounts.js';

export interface AccountRepository {
  countByTenant(tenantId: string, userId: string): Promise<number>;
  bulkInsertOnConflictDoNothing(accounts: SeedAccount[], tenantId: string, userId: string): Promise<void>;
}
