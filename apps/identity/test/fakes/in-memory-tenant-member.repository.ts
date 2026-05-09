// In-memory TenantMemberRepository for use-case unit tests.

import { createTenantMember } from '../../src/domain/tenant-member.entity.js';
import type { TenantMember, TenantRole } from '../../src/domain/tenant-member.entity.js';
import type { TenantMemberRepository } from '../../src/application/ports/tenant-member.repository.port.js';

export class InMemoryTenantMemberRepository implements TenantMemberRepository {
  private readonly store: TenantMember[] = [];

  async add(params: {
    tenantId: string;
    userId: string;
    role: TenantRole;
    cognitoSub: string;
  }): Promise<TenantMember> {
    const member = createTenantMember({
      tenantId: params.tenantId,
      userId: params.userId,
      role: params.role,
    });
    this.store.push(member);
    return member;
  }

  async isMember(params: { tenantId: string; userId: string; cognitoSub: string }): Promise<boolean> {
    return this.store.some((m) => m.tenantId === params.tenantId && m.userId === params.userId);
  }

  allFor(userId: string): TenantMember[] {
    return this.store.filter((m) => m.userId === userId);
  }
}
