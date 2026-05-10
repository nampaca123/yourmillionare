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

interface StoredTenant {
  tenant: Tenant;
  createdByUserId: string;
}

export class InMemoryTenantRepository implements TenantRepository {
  private readonly store = new Map<string, StoredTenant>();
  private readonly hashIndex = new Map<string, string>();

  constructor(private readonly memberRepo?: InMemoryTenantMemberRepository) {}

  async create(params: CreateTenantParams): Promise<Tenant> {
    if (params.bizRegNoHash) {
      const hashKey = params.bizRegNoHash.toString('hex');
      if (this.hashIndex.has(hashKey)) {
        throw new ConflictError('A tenant with this business registration number already exists');
      }
      this.hashIndex.set(hashKey, '');
    }
    const id = randomUUID();
    const tenant = createTenant({
      id,
      bizRegNo: '' as BizRegNo,
      legalName: params.legalName,
      displayName: params.displayName,
      businessType: params.businessType,
      foundedOn: undefined,
      regionCode: undefined,
    });
    this.store.set(id, { tenant, createdByUserId: params.userId });
    if (params.bizRegNoHash) {
      this.hashIndex.set(params.bizRegNoHash.toString('hex'), id);
    }
    return tenant;
  }

  async findAllByUserId(userId: string): Promise<Tenant[]> {
    if (!this.memberRepo) return [];
    const memberTenantIds = this.memberRepo
      .allFor(userId)
      .map((m) => m.tenantId);
    return memberTenantIds
      .map((tid) => this.store.get(tid)?.tenant)
      .filter((t): t is Tenant => t !== undefined);
  }

  async findByCreatedByUserId(userId: string): Promise<Tenant | null> {
    for (const entry of this.store.values()) {
      if (entry.createdByUserId === userId && entry.tenant.businessType === 'personal') {
        return entry.tenant;
      }
    }
    return null;
  }

  seed(tenant: Tenant, createdByUserId = ''): void {
    this.store.set(tenant.id, { tenant, createdByUserId });
  }
}
