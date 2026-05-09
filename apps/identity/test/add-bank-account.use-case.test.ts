// Unit tests for AddBankAccountUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenError, ConflictError } from '@ym/shared-errors';
import { AddBankAccountUseCase } from '../src/application/add-bank-account.use-case.js';
import { InMemoryTenantMemberRepository } from './fakes/in-memory-tenant-member.repository.js';
import { InMemoryBankAccountRepository } from './fakes/in-memory-bank-account.repository.js';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const COGNITO_SUB = 'sub-abc';

describe('AddBankAccountUseCase', () => {
  let memberRepo: InMemoryTenantMemberRepository;
  let bankAccountRepo: InMemoryBankAccountRepository;
  let useCase: AddBankAccountUseCase;

  beforeEach(() => {
    memberRepo = new InMemoryTenantMemberRepository();
    bankAccountRepo = new InMemoryBankAccountRepository();
    useCase = new AddBankAccountUseCase(memberRepo, bankAccountRepo);
  });

  it('should return created bank account when user is a tenant member', async () => {
    await memberRepo.add({ tenantId: TENANT_ID, userId: USER_ID, role: 'owner', cognitoSub: COGNITO_SUB });

    const result = await useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      organization: '0088',
      accountNumber: '110-123-456789',
    });

    expect(result.tenantId).toBe(TENANT_ID);
    expect(result.organization).toBe('0088');
    expect(result.accountNumber).toBe('110-123-456789');
    expect(result.isActive).toBe(true);
    expect(result.id).toBeTruthy();
  });

  it('should throw ForbiddenError when user is not a member of the tenant', async () => {
    const promise = useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      organization: '0088',
      accountNumber: '110-123-456789',
    });

    await expect(promise).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('should throw ConflictError when the same account is registered twice', async () => {
    await memberRepo.add({ tenantId: TENANT_ID, userId: USER_ID, role: 'owner', cognitoSub: COGNITO_SUB });
    await useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      organization: '0088',
      accountNumber: '110-123-456789',
    });

    const promise = useCase.execute({
      tenantId: TENANT_ID,
      userId: USER_ID,
      cognitoSub: COGNITO_SUB,
      organization: '0088',
      accountNumber: '110-123-456789',
    });

    await expect(promise).rejects.toBeInstanceOf(ConflictError);
  });
});
