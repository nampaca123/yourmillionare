// In-memory TenantRepository for use-case unit tests.

import { randomUUID } from 'crypto';
import type { Tenant } from '../../src/domain/tenant.entity.js';
import { createTenant } from '../../src/domain/tenant.entity.js';
import type {
  TenantRepository,
  CreateTenantParams,
} from '../../src/application/ports/tenant.repository.port.js';
import type { BizRegNo } from '../../src/domain/biz-reg-no.value-object.js';
import { ConflictError } from '../../src/shared/errors/app-error.js';
import type { InMemoryTenantMemberRepository } from './in-memory-tenant-member.repository.js';

export class InMemoryTenantRepository implements TenantRepository {
  private readonly store = new Map<string, Tenant>();
  private readonly hashIndex = new Map<string, string>();

  constructor(private readonly memberRepo?: InMemoryTenantMemberRepository) {}

  async create(params: CreateTenantParams): Promise<Tenant> {
    const hashKey = params.bizRegNoHash.toString('hex');
    if (this.hashIndex.has(hashKey)) {
      throw new ConflictError('A tenant with this business registration number already exists');
    }
    const id = randomUUID();
    const tenant = createTenant({
      id,
      bizRegNo: '' as BizRegNo,
      legalName: params.legalName,
      displayName: params.displayName,
      foundedOn: undefined,
      regionCode: undefined,
    });
    this.store.set(id, tenant);
    this.hashIndex.set(hashKey, id);
    return tenant;
  }

  async findAllByUserId(userId: string): Promise<Tenant[]> {
    if (!this.memberRepo) return [];
    const memberTenantIds = this.memberRepo
      .allFor(userId)
      .map((m) => m.tenantId);
    return memberTenantIds
      .map((tid) => this.store.get(tid))
      .filter((t): t is Tenant => t !== undefined);
  }

  seed(tenant: Tenant): void {
    this.store.set(tenant.id, tenant);
  }
}
