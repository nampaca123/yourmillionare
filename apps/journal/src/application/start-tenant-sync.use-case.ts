// Use case: enforce tenant membership, create a sync_run row, then trigger ManualSyncStateMachine with the runId.

import type { SyncDispatcher } from './ports/sync-dispatcher.port.js';
import type { SyncRunRepository } from './ports/sync-run.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class StartTenantSyncUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly dispatcher: SyncDispatcher,
    private readonly syncRuns: SyncRunRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    idempotencyKey?: string;
  }): Promise<{ syncRunId: string; executionArn: string; startDate: string; status: 'queued' }> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    const syncRunId = await this.syncRuns.create({
      tenantId: params.tenantId,
      triggeredBy: 'manual',
    });

    const dispatchInput: { tenantId: string; syncRunId: string; idempotencyKey?: string } = {
      tenantId: params.tenantId,
      syncRunId,
    };
    if (params.idempotencyKey !== undefined) {
      dispatchInput.idempotencyKey = params.idempotencyKey;
    }

    const result = await this.dispatcher.start(dispatchInput);

    if (result.executionArn) {
      await this.syncRuns.setExecutionArn({
        tenantId: params.tenantId,
        syncRunId,
        executionArn: result.executionArn,
      });
    }

    return { syncRunId, executionArn: result.executionArn, startDate: result.startDate, status: 'queued' };
  }
}
