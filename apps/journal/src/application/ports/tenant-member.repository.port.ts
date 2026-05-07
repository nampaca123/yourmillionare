// TenantMemberRepository port: verify user membership in a tenant.

export interface TenantMemberRepository {
  isMember(params: { tenantId: string; userId: string; cognitoSub: string }): Promise<boolean>;
}
