// Port: tenant persistence operations.

import type { Tenant, BusinessType } from '../../domain/tenant.entity.js';

export interface CreateTenantParams {
  userId: string;
  cognitoSub: string;
  legalName: string;
  displayName: string;
  businessType: BusinessType;
  bizRegNoEncrypted: Buffer | null;
  bizRegNoHash: Buffer | null;
}

export interface TenantRepository {
  // Returns tenant only if successful; throws ConflictError on duplicate bizRegNoHash.
  create(params: CreateTenantParams): Promise<Tenant>;
  findAllByUserId(userId: string): Promise<Tenant[]>;
  findByCreatedByUserId(userId: string, cognitoSub: string): Promise<Tenant | null>;
}
