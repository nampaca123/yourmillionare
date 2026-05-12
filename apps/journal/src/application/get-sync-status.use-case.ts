// Use case: report tenant ingestion progress for the frontend status pill.

import type { SyncStateRepository, SyncStateSnapshot } from './ports/sync-state.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export type SyncStatusLabel = 'idle' | 'fetching' | 'classifying' | 'done';

const inferStatus = (snap: SyncStateSnapshot): SyncStatusLabel => {
  if (snap.dispatched === 0 && snap.classified === 0 && snap.undispatched === 0) return 'idle';
  if (snap.undispatched > 0) return 'fetching';
  if (snap.classified < snap.dispatched) return 'classifying';
  return 'done';
};

export class GetSyncStatusUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly repo: SyncStateRepository,
  ) {}

  async execute(params: { tenantId: string; userId: string; cognitoSub: string }): Promise<SyncStateSnapshot & { status: SyncStatusLabel }> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    const snap = await this.repo.snapshot({ tenantId: params.tenantId });
    return { ...snap, status: inferStatus(snap) };
  }
}
