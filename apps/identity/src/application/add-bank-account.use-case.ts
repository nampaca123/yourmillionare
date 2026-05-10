// AddBankAccountUseCase: confirms a previously-discovered account, attaching the cached connectedId.

import { ForbiddenError, ValidationError } from '@ym/shared-errors';
import type { TenantMemberRepository } from './ports/tenant-member.repository.port.js';
import type { BankAccountRepository, BankAccount } from './ports/bank-account.repository.port.js';
import type { BankConnectionRepository } from './ports/bank-connection.repository.port.js';

export class AddBankAccountUseCase {
  constructor(
    private readonly members: TenantMemberRepository,
    private readonly bankAccounts: BankAccountRepository,
    private readonly connections: BankConnectionRepository,
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

    const connection = await this.connections.findByOrganization({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
      organization: params.organization,
    });
    if (!connection) {
      throw new ValidationError(
        'No bank connection found for this organization. Connect bank first via POST /tenants/{tenantId}/bank-connections',
      );
    }

    return this.bankAccounts.insert({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
      organization: params.organization,
      accountNumber: params.accountNumber,
      connectedId: connection.connectedId,
    });
  }
}
