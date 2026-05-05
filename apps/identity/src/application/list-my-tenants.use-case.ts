// Use case: list all tenants the current user belongs to via RLS-enforced SELECT.

import type { Tenant } from '../domain/tenant.entity.js';
import type { TenantRepository } from './ports/tenant.repository.port.js';

export interface ListMyTenantsInput {
  userId: string;
}

export class ListMyTenantsUseCase {
  constructor(private readonly tenants: TenantRepository) {}

  async execute(input: ListMyTenantsInput): Promise<Tenant[]> {
    return this.tenants.findAllByUserId(input.userId);
  }
}
