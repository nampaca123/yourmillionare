// Use case: list all pending uncertain classifications for a tenant (across all sync_runs).

import type { UncertainItem, UncertainRepository } from './ports/uncertain.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

const DEFAULT_LIMIT = 200;

export class ListUncertainUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly uncertain: UncertainRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    limit?: number;
  }): Promise<ReadonlyArray<UncertainItem>> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    return this.uncertain.list({ tenantId: params.tenantId, limit: params.limit ?? DEFAULT_LIMIT });
  }
}
