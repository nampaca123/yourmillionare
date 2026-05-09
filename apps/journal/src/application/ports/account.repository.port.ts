// AccountRepository port: read/write chart of accounts per tenant.

import type { SeedAccount } from '@ym/journal-core';

export interface AccountRepository {
  countByTenant(tenantId: string, userId: string): Promise<number>;
  bulkInsertOnConflictDoNothing(accounts: SeedAccount[], tenantId: string, userId: string): Promise<void>;
  findMissingCodes(tenantId: string, userId: string, codes: string[]): Promise<string[]>;
}
