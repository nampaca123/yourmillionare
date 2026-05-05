// Unit tests for the CreateTenantUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { CreateTenantUseCase } from '../src/application/create-tenant.use-case.js';
import { ConflictError } from '../src/shared/errors/app-error.js';
import { InvalidBizRegNoError } from '../src/domain/identity.errors.js';
import { InMemoryTenantRepository } from './fakes/in-memory-tenant.repository.js';
import { InMemoryTenantMemberRepository } from './fakes/in-memory-tenant-member.repository.js';
import { FakeBizRegNoEncryptor } from './fakes/fake-biz-reg-no-encryptor.js';
import { FakeBizRegNoHasher } from './fakes/fake-biz-reg-no-hasher.js';

describe('CreateTenantUseCase', () => {
  let useCase: CreateTenantUseCase;
  let tenants: InMemoryTenantRepository;
  let members: InMemoryTenantMemberRepository;

  beforeEach(() => {
    members = new InMemoryTenantMemberRepository();
    tenants = new InMemoryTenantRepository(members);
    useCase = new CreateTenantUseCase(tenants, members, new FakeBizRegNoEncryptor(), new FakeBizRegNoHasher());
  });

  it('should create a tenant and register owner membership when input is valid', async () => {
    const userId = randomUUID();
    const input = { userId, legalName: '테스트법인', displayName: '테스트', bizRegNoRaw: '1234567890' };

    const { tenant } = await useCase.execute(input);

    expect(tenant.id).toBeTruthy();
    expect(members.allFor(userId)).toHaveLength(1);
    expect(members.allFor(userId)[0]?.role).toBe('owner');
  });

  it('should throw ConflictError when the same bizRegNo is registered twice', async () => {
    const userId = randomUUID();
    await useCase.execute({ userId, legalName: 'First', displayName: 'First', bizRegNoRaw: '1234567890' });

    const promise = useCase.execute({ userId, legalName: 'Second', displayName: 'Second', bizRegNoRaw: '1234567890' });

    await expect(promise).rejects.toBeInstanceOf(ConflictError);
  });

  it('should throw InvalidBizRegNoError when the bizRegNo format is wrong', async () => {
    const promise = useCase.execute({
      userId: randomUUID(),
      legalName: 'Bad',
      displayName: 'Bad',
      bizRegNoRaw: 'not-a-number',
    });

    await expect(promise).rejects.toBeInstanceOf(InvalidBizRegNoError);
  });

  it('should register tenant and member in the same logical unit when called once', async () => {
    const userId = randomUUID();

    const { tenant } = await useCase.execute({
      userId,
      legalName: 'Corp',
      displayName: 'Corp',
      bizRegNoRaw: '9876543210',
    });

    const memberRow = members.allFor(userId)[0];
    expect(memberRow?.tenantId).toBe(tenant.id);
  });
});
