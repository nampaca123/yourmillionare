// In-memory TenantMemberRepository for unit tests.

import type { TenantMemberRepository } from '../../src/application/ports/tenant-member.repository.port.js';

export class InMemoryTenantMemberRepository implements TenantMemberRepository {
  private members: Array<{ tenantId: string; userId: string }> = [];

  add(tenantId: string, userId: string): void {
    this.members.push({ tenantId, userId });
  }

  async isMember(tenantId: string, userId: string): Promise<boolean> {
    return this.members.some((m) => m.tenantId === tenantId && m.userId === userId);
  }
}
