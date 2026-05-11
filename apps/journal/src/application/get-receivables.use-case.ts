// Use case: receivables kanban board (PENDING / DUE_SOON / OVERDUE / COLLECTED).

import type { ReceivablesBoard, ReceivableStatus, ViewsRepository } from './ports/views.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

const DUE_SOON_DAYS = 7;

export class GetReceivablesUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly views: ViewsRepository,
  ) {}

  async execute(params: { tenantId: string; userId: string; cognitoSub: string; today: string }): Promise<ReceivablesBoard> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    return this.views.listReceivables({ tenantId: params.tenantId, today: params.today, dueSoonDays: DUE_SOON_DAYS });
  }
}

export class UpdateReceivableStatusUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly views: ViewsRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    entryId: string;
    status: ReceivableStatus;
    collectedAt?: string;
  }): Promise<void> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    const input: {
      tenantId: string;
      entryId: string;
      status: ReceivableStatus;
      collectedAt?: string;
    } = { tenantId: params.tenantId, entryId: params.entryId, status: params.status };
    if (params.collectedAt !== undefined) input.collectedAt = params.collectedAt;
    await this.views.updateReceivableStatus(input);
  }
}
