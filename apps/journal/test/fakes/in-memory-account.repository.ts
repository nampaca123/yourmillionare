// In-memory AccountRepository for unit tests.

import type { SeedAccount } from '@ym/journal-core';
import type { AccountRepository } from '../../src/application/ports/account.repository.port.js';

export class InMemoryAccountRepository implements AccountRepository {
  private records: Array<SeedAccount & { tenantId: string }> = [];

  async findMissingCodes(tenantId: string, _userId: string, codes: string[]): Promise<string[]> {
    const wanted = [...new Set(codes)];
    const missing = wanted.filter(
      (code) => !this.records.some((r) => r.tenantId === tenantId && r.code === code),
    );
    return missing.sort();
  }

  async countByTenant(tenantId: string, _userId: string): Promise<number> {
    return this.records.filter((r) => r.tenantId === tenantId).length;
  }

  async bulkInsertOnConflictDoNothing(accounts: SeedAccount[], tenantId: string, _userId: string): Promise<void> {
    for (const acc of accounts) {
      const exists = this.records.some((r) => r.tenantId === tenantId && r.code === acc.code);
      if (!exists) this.records.push({ ...acc, tenantId });
    }
  }

  all(): Array<SeedAccount & { tenantId: string }> {
    return [...this.records];
  }
}
