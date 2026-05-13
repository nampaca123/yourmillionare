// Use case: flip an uncertain entry to certain (status=posted, confidence_status=certain). One-line transition, no row move.

import { ConflictError, NotFoundError } from '@ym/shared-errors';
import type { EntriesRepository, EntryRow } from './ports/entries.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class ConfirmEntryUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly entries: EntriesRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    entryId: string;
  }): Promise<EntryRow> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    const existing = await this.entries.findById({
      tenantId: params.tenantId,
      entryId: params.entryId,
    });
    if (!existing) throw new NotFoundError(`Journal entry ${params.entryId} not found`);
    if (existing.confidenceStatus === 'certain') return existing;
    if (existing.confidenceStatus === 'discarded') {
      throw new ConflictError(`Entry ${params.entryId} is discarded and cannot be confirmed`);
    }

    const updated = await this.entries.updateConfidenceStatus({
      tenantId: params.tenantId,
      entryId: params.entryId,
      fromStatus: 'uncertain',
      toStatus: 'certain',
      promoteToPosted: true,
    });
    if (!updated) {
      throw new ConflictError(`Entry ${params.entryId} could not be confirmed (concurrent update?)`);
    }

    const refreshed = await this.entries.findById({
      tenantId: params.tenantId,
      entryId: params.entryId,
    });
    if (!refreshed) throw new NotFoundError(`Journal entry ${params.entryId} vanished after confirm`);
    return refreshed;
  }
}
