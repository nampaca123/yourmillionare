// Use case: read-only monthly summary for the F2 view 2 card.

import type { MonthlySummary, ViewsRepository } from './ports/views.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class GetMonthlySummaryUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly views: ViewsRepository,
  ) {}

  async execute(params: { tenantId: string; userId: string; cognitoSub: string; ym: string }): Promise<MonthlySummary> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    return this.views.monthlySummary({ tenantId: params.tenantId, ym: params.ym });
  }
}
