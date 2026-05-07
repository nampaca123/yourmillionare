// EnsureAccountsSeededUseCase: self-healing seed — inserts K-IFRS defaults if none exist.

import { K_IFRS_DEFAULT_ACCOUNTS } from '../domain/seed-accounts.js';
import type { AccountRepository } from './ports/account.repository.port.js';

export class EnsureAccountsSeededUseCase {
  constructor(private readonly accounts: AccountRepository) {}

  async execute(params: { tenantId: string; userId: string }): Promise<void> {
    const count = await this.accounts.countByTenant(params.tenantId, params.userId);
    if (count > 0) return;
    await this.accounts.bulkInsertOnConflictDoNothing(K_IFRS_DEFAULT_ACCOUNTS, params.tenantId, params.userId);
  }
}
