// In-memory BankAccountRepository for use-case unit tests.

import { randomUUID } from 'crypto';
import { ConflictError } from '@ym/shared-errors';
import type { BankAccount, BankAccountRepository } from '../../src/application/ports/bank-account.repository.port.js';

export class InMemoryBankAccountRepository implements BankAccountRepository {
  private readonly store: BankAccount[] = [];

  async insert(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    accountNumber: string;
    connectedId: string;
  }): Promise<BankAccount> {
    const duplicate = this.store.some(
      (a) =>
        a.tenantId === params.tenantId &&
        a.organization === params.organization &&
        a.accountNumber === params.accountNumber,
    );
    if (duplicate) throw new ConflictError('A bank account with this organization and account number already exists for this tenant.');

    const account: BankAccount = {
      id: randomUUID(),
      tenantId: params.tenantId,
      organization: params.organization,
      accountNumber: params.accountNumber,
      connectedId: params.connectedId,
      isActive: true,
      createdAt: new Date(),
    };
    this.store.push(account);
    return account;
  }
}
