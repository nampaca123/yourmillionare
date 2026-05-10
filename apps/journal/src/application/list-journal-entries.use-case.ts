// Use case: lists journal entries for a tenant in a date range, after verifying membership.

import type { JournalRepository, JournalEntrySummary } from '@ym/journal-core';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class ListJournalEntriesUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly journals: JournalRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    fromDate: string;
    toDate: string;
    limit: number;
    offset: number;
  }): Promise<JournalEntrySummary[]> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    return this.journals.list(params);
  }
}
