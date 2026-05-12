// Use case: enforce tenant membership then trigger ManualSyncStateMachine for a single tenant.

import type { SyncDispatcher } from './ports/sync-dispatcher.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class StartTenantSyncUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly dispatcher: SyncDispatcher,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    idempotencyKey?: string;
  }): Promise<{ executionArn: string; startDate: string; status: 'RUNNING' }> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    const dispatchInput: { tenantId: string; idempotencyKey?: string } = { tenantId: params.tenantId };
    if (params.idempotencyKey !== undefined) {
      dispatchInput.idempotencyKey = params.idempotencyKey;
    }
    const result = await this.dispatcher.start(dispatchInput);
    return { ...result, status: 'RUNNING' };
  }
}
