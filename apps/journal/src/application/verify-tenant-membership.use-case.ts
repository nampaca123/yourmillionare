// VerifyTenantMembershipUseCase: confirms user belongs to the requested tenant; throws 403 if not.

import { ForbiddenError } from '@ym/shared-errors';
import type { TenantMemberRepository } from './ports/tenant-member.repository.port.js';

export class VerifyTenantMembershipUseCase {
  constructor(private readonly members: TenantMemberRepository) {}

  async execute(params: { tenantId: string; userId: string; cognitoSub: string }): Promise<void> {
    const member = await this.members.isMember(params);
    if (!member) throw new ForbiddenError('User is not a member of this tenant.');
  }
}
