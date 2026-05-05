// Port: tenant-member join-table persistence operations.

import type { TenantMember, TenantRole } from '../../domain/tenant-member.entity.js';

export interface TenantMemberRepository {
  add(params: { tenantId: string; userId: string; role: TenantRole }): Promise<TenantMember>;
}
