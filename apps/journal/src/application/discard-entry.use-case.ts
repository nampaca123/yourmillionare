// Use case: mark an uncertain entry as discarded. Row is kept for audit, just confidence_status flips.

import { ConflictError, NotFoundError } from '@ym/shared-errors';
import type { EntriesRepository, EntryRow } from './ports/entries.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class DiscardEntryUseCase {
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
    if (existing.confidenceStatus === 'discarded') return existing;
    if (existing.confidenceStatus === 'certain') {
      throw new ConflictError(
        `Entry ${params.entryId} is certain; discarding is for uncertain entries only`,
      );
    }

    const updated = await this.entries.updateConfidenceStatus({
      tenantId: params.tenantId,
      entryId: params.entryId,
      fromStatus: 'uncertain',
      toStatus: 'discarded',
      promoteToPosted: false,
    });
    if (!updated) {
      throw new ConflictError(`Entry ${params.entryId} could not be discarded`);
    }

    const refreshed = await this.entries.findById({
      tenantId: params.tenantId,
      entryId: params.entryId,
    });
    if (!refreshed) throw new NotFoundError(`Journal entry ${params.entryId} vanished after discard`);
    return refreshed;
  }
}
