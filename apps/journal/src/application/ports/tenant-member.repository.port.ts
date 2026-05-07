// TenantMemberRepository port: verify user membership in a tenant.

export interface TenantMemberRepository {
  isMember(tenantId: string, userId: string): Promise<boolean>;
}
