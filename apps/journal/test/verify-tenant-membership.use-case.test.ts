// Unit tests for VerifyTenantMembershipUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { VerifyTenantMembershipUseCase } from '../src/application/verify-tenant-membership.use-case.js';
import { InMemoryTenantMemberRepository } from './fakes/in-memory-tenant-member.repository.js';
import { ForbiddenError } from '@ym/shared-errors';

describe('VerifyTenantMembershipUseCase', () => {
  let useCase: VerifyTenantMembershipUseCase;
  let repo: InMemoryTenantMemberRepository;

  beforeEach(() => {
    repo = new InMemoryTenantMemberRepository();
    useCase = new VerifyTenantMembershipUseCase(repo);
  });

  it('should resolve when user is a member of the tenant', async () => {
    repo.add('tenant-1', 'user-1');

    await expect(useCase.execute({ tenantId: 'tenant-1', userId: 'user-1' })).resolves.toBeUndefined();
  });

  it('should throw ForbiddenError when user is not a member', async () => {
    await expect(useCase.execute({ tenantId: 'tenant-1', userId: 'user-1' })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('should throw ForbiddenError when tenant does not exist', async () => {
    repo.add('other-tenant', 'user-1');
    await expect(useCase.execute({ tenantId: 'nonexistent', userId: 'user-1' })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
