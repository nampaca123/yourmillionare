// AddBankAccountUseCase: verifies tenant membership and registers a bank account for CODEF collection.

import { ForbiddenError } from '@ym/shared-errors';
import type { TenantMemberRepository } from './ports/tenant-member.repository.port.js';
import type { BankAccountRepository, BankAccount } from './ports/bank-account.repository.port.js';

export class AddBankAccountUseCase {
  constructor(
    private readonly members: TenantMemberRepository,
    private readonly bankAccounts: BankAccountRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    organization: string;
    accountNumber: string;
  }): Promise<BankAccount> {
    const member = await this.members.isMember({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    if (!member) throw new ForbiddenError('User is not a member of this tenant.');

    return this.bankAccounts.insert({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
      organization: params.organization,
      accountNumber: params.accountNumber,
    });
  }
}
