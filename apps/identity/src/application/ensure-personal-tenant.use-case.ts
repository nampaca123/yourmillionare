// Use case: idempotent personal tenant provision — finds caller's auto-created tenant or creates one.

import type { Tenant } from '../domain/tenant.entity.js';
import type { User } from '../domain/user.entity.js';
import type { ObligationSeedDispatcher } from './ports/obligation-seed-dispatcher.port.js';
import type { TenantRepository } from './ports/tenant.repository.port.js';
import type { TenantMemberRepository } from './ports/tenant-member.repository.port.js';

export class EnsurePersonalTenantUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly members: TenantMemberRepository,
    private readonly seedDispatcher: ObligationSeedDispatcher | null = null,
  ) {}

  async execute(user: User): Promise<Tenant> {
    const existing = await this.tenants.findByCreatedByUserId(user.id, user.cognitoSub);
    if (existing) return existing;

    const tenant = await this.tenants.create({
      userId: user.id,
      cognitoSub: user.cognitoSub,
      legalName: user.email,
      displayName: user.email,
      businessType: 'personal',
      bizRegNoEncrypted: null,
      bizRegNoHash: null,
    });

    await this.members.add({
      tenantId: tenant.id,
      userId: user.id,
      role: 'owner',
      cognitoSub: user.cognitoSub,
    });

    if (this.seedDispatcher) {
      await this.seedDispatcher.seed({ tenantId: tenant.id });
    }

    return tenant;
  }
}
