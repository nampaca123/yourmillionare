// Use case: account balance gallery for the F2 view 4.

import type { AccountBalanceCard, ViewsRepository } from './ports/views.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class GetAccountBalancesUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly views: ViewsRepository,
  ) {}

  async execute(params: { tenantId: string; userId: string; cognitoSub: string }): Promise<ReadonlyArray<AccountBalanceCard>> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    return this.views.listAccountBalances({ tenantId: params.tenantId });
  }
}
