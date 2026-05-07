// In-memory AccountRepository for unit tests.

import type { SeedAccount } from '../../src/domain/seed-accounts.js';
import type { AccountRepository } from '../../src/application/ports/account.repository.port.js';

export class InMemoryAccountRepository implements AccountRepository {
  private records: Array<SeedAccount & { tenantId: string }> = [];

  async countByTenant(tenantId: string): Promise<number> {
    return this.records.filter((r) => r.tenantId === tenantId).length;
  }

  async bulkInsertOnConflictDoNothing(accounts: SeedAccount[], tenantId: string): Promise<void> {
    for (const acc of accounts) {
      const exists = this.records.some((r) => r.tenantId === tenantId && r.code === acc.code);
      if (!exists) this.records.push({ ...acc, tenantId });
    }
  }

  all(): Array<SeedAccount & { tenantId: string }> {
    return [...this.records];
  }
}
