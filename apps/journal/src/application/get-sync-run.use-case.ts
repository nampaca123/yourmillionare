// Use cases: read sync_run details and lists for the user-facing /sync/runs polling endpoints.

import { NotFoundError } from '@ym/shared-errors';
import type {
  SyncRunDetail,
  SyncRunRepository,
  SyncRunSummary,
} from './ports/sync-run.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class GetSyncRunUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly syncRuns: SyncRunRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    syncRunId: string;
  }): Promise<SyncRunDetail> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    const detail = await this.syncRuns.get({
      tenantId: params.tenantId,
      syncRunId: params.syncRunId,
    });

    if (!detail) {
      throw new NotFoundError(`sync_run ${params.syncRunId} not found for tenant`);
    }

    return detail;
  }
}

export class ListSyncRunsUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly syncRuns: SyncRunRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    limit: number;
  }): Promise<SyncRunSummary[]> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    return this.syncRuns.list({ tenantId: params.tenantId, limit: params.limit });
  }
}

export class GetLatestSyncRunUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly syncRuns: SyncRunRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
  }): Promise<SyncRunDetail | null> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    return this.syncRuns.getLatest({ tenantId: params.tenantId });
  }
}
