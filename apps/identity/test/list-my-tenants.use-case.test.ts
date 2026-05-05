// Unit tests for the ListMyTenantsUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { ListMyTenantsUseCase } from '../src/application/list-my-tenants.use-case.js';
import { InMemoryTenantRepository } from './fakes/in-memory-tenant.repository.js';
import { InMemoryTenantMemberRepository } from './fakes/in-memory-tenant-member.repository.js';

describe('ListMyTenantsUseCase', () => {
  let useCase: ListMyTenantsUseCase;
  let tenants: InMemoryTenantRepository;
  let members: InMemoryTenantMemberRepository;

  beforeEach(() => {
    members = new InMemoryTenantMemberRepository();
    tenants = new InMemoryTenantRepository(members);
    useCase = new ListMyTenantsUseCase(tenants);
  });

  it('should return an empty array when the user has no tenants', async () => {
    const result = await useCase.execute({ userId: randomUUID() });

    expect(result).toHaveLength(0);
  });

  it('should return all tenants the user belongs to when memberships exist', async () => {
    const userId = randomUUID();
    const t1 = await tenants.create({ legalName: 'A', displayName: 'A', bizRegNoEncrypted: Buffer.from('a'), bizRegNoHash: Buffer.from('hash-a') });
    const t2 = await tenants.create({ legalName: 'B', displayName: 'B', bizRegNoEncrypted: Buffer.from('b'), bizRegNoHash: Buffer.from('hash-b') });
    await members.add({ tenantId: t1.id, userId, role: 'owner' });
    await members.add({ tenantId: t2.id, userId, role: 'owner' });

    const result = await useCase.execute({ userId });

    expect(result).toHaveLength(2);
  });

  it('should not return tenants that belong to a different user', async () => {
    const userA = randomUUID();
    const userB = randomUUID();
    const t = await tenants.create({ legalName: 'A', displayName: 'A', bizRegNoEncrypted: Buffer.from('a'), bizRegNoHash: Buffer.from('hash-x') });
    await members.add({ tenantId: t.id, userId: userA, role: 'owner' });

    const result = await useCase.execute({ userId: userB });

    expect(result).toHaveLength(0);
  });
});
