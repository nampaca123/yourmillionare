// Use case: mark a pending uncertain draft as discarded (no journal_entry will be created).

import { NotFoundError } from '@ym/shared-errors';
import type { DraftRepository } from './ports/draft.repository.port.js';
import type { VerifyTenantMembershipUseCase } from './verify-tenant-membership.use-case.js';

export interface DiscardUncertainResult {
  readonly rawTransactionId: string;
  readonly status: 'discarded';
}

export class DiscardUncertainUseCase {
  constructor(
    private readonly verifyMembership: VerifyTenantMembershipUseCase,
    private readonly drafts: DraftRepository,
  ) {}

  async execute(params: {
    tenantId: string;
    userId: string;
    cognitoSub: string;
    rawTransactionId: string;
  }): Promise<DiscardUncertainResult> {
    await this.verifyMembership.execute({
      tenantId: params.tenantId,
      userId: params.userId,
      cognitoSub: params.cognitoSub,
    });

    const updated = await this.drafts.markDiscarded({
      tenantId: params.tenantId,
      rawTransactionId: params.rawTransactionId,
    });

    if (!updated) {
      throw new NotFoundError(`Uncertain classification not found for raw transaction ${params.rawTransactionId}`);
    }

    return { rawTransactionId: params.rawTransactionId, status: 'discarded' };
  }
}
