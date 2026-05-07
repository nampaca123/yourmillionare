// Port: tenant persistence operations.

import type { Tenant } from '../../domain/tenant.entity.js';

export interface CreateTenantParams {
  userId: string;
  cognitoSub: string;
  legalName: string;
  displayName: string;
  bizRegNoEncrypted: Buffer;
  bizRegNoHash: Buffer;
}

export interface TenantRepository {
  // Returns tenant only if successful; throws ConflictError on duplicate bizRegNoHash.
  create(params: CreateTenantParams): Promise<Tenant>;
  findAllByUserId(userId: string): Promise<Tenant[]>;
}
