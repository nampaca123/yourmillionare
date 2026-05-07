// Use case: create a tenant and register the caller as owner in one operation.

import type { Tenant } from '../domain/tenant.entity.js';
import { parseBizRegNo, bizRegNoRaw } from '../domain/biz-reg-no.value-object.js';
import type { TenantRepository } from './ports/tenant.repository.port.js';
import type { TenantMemberRepository } from './ports/tenant-member.repository.port.js';
import type { BizRegNoEncryptor } from './ports/biz-reg-no-encryptor.port.js';
import type { BizRegNoHasher } from './ports/biz-reg-no-hasher.port.js';

export interface CreateTenantInput {
  userId: string;
  cognitoSub: string;
  legalName: string;
  displayName: string;
  bizRegNoRaw: string;
}

export interface CreateTenantOutput {
  tenant: Tenant;
}

export class CreateTenantUseCase {
  constructor(
    private readonly tenants: TenantRepository,
    private readonly members: TenantMemberRepository,
    private readonly encryptor: BizRegNoEncryptor,
    private readonly hasher: BizRegNoHasher,
  ) {}

  async execute(input: CreateTenantInput): Promise<CreateTenantOutput> {
    const brn = parseBizRegNo(input.bizRegNoRaw);
    const rawDigits = bizRegNoRaw(brn);

    const [encrypted, hash] = await Promise.all([
      this.encryptor.encrypt(rawDigits),
      this.hasher.hash(rawDigits),
    ]);

    // Repository throws ConflictError on unique constraint violation for biz_reg_no_hash.
    const tenant = await this.tenants.create({
      userId: input.userId,
      cognitoSub: input.cognitoSub,
      legalName: input.legalName,
      displayName: input.displayName,
      bizRegNoEncrypted: encrypted,
      bizRegNoHash: hash,
    });

    await this.members.add({
      tenantId: tenant.id,
      userId: input.userId,
      role: 'owner',
      cognitoSub: input.cognitoSub,
    });

    return { tenant };
  }
}
