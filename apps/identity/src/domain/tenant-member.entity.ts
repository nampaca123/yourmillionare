// TenantMember entity: N:M mapping between users and tenants with a role.

export type TenantRole = 'owner' | 'admin' | 'viewer';

export interface TenantMember {
  readonly tenantId: string;
  readonly userId: string;
  readonly role: TenantRole;
  readonly joinedAt: Date;
}

export const createTenantMember = (
  params: Omit<TenantMember, 'joinedAt' | 'role'> & Partial<Pick<TenantMember, 'role' | 'joinedAt'>>,
): TenantMember => ({
  tenantId: params.tenantId,
  userId: params.userId,
  role: params.role ?? 'owner',
  joinedAt: params.joinedAt ?? new Date(),
});
