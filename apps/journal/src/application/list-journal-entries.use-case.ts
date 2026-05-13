// Use case: lists journal entries for a tenant in a date range (all confidence statuses by default).

import type {
  ConfidenceStatus,
  EntriesRepository,
  EntryRow,
} from './ports/entries.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class ListJournalEntriesUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly entries: EntriesRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    fromDate: string;
    toDate: string;
    limit: number;
    offset: number;
    confidenceStatus?: ConfidenceStatus | 'all';
  }): Promise<ReadonlyArray<EntryRow>> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    return this.entries.list({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
      fromDate: params.fromDate,
      toDate: params.toDate,
      limit: params.limit,
      offset: params.offset,
      confidenceStatus: params.confidenceStatus ?? 'all',
    });
  }
}
