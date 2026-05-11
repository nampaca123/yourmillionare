// Use case: list heuristic drafts awaiting Bedrock classification (PLAN.md §1.4 5-second promise).

import type { JournalEntryDraft, ViewsRepository } from './ports/views.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export class ListDraftsUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly views: ViewsRepository,
  ) {}

  async execute(params: { tenantId: string; userId: string; cognitoSub: string }): Promise<ReadonlyArray<JournalEntryDraft>> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });
    return this.views.listDrafts({ tenantId: params.tenantId });
  }
}
