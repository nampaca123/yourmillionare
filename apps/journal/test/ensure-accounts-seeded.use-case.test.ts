// Unit tests for EnsureAccountsSeededUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { EnsureAccountsSeededUseCase } from '../src/application/ensure-accounts-seeded.use-case.js';
import { InMemoryAccountRepository } from './fakes/in-memory-account.repository.js';
import { K_IFRS_DEFAULT_ACCOUNTS } from '../src/domain/seed-accounts.js';

describe('EnsureAccountsSeededUseCase', () => {
  let useCase: EnsureAccountsSeededUseCase;
  let repo: InMemoryAccountRepository;

  beforeEach(() => {
    repo = new InMemoryAccountRepository();
    useCase = new EnsureAccountsSeededUseCase(repo);
  });

  it('should insert 30 accounts when tenant has none', async () => {
    await useCase.execute({ tenantId: 'tenant-1', userId: 'user-1' });

    expect(repo.all()).toHaveLength(K_IFRS_DEFAULT_ACCOUNTS.length);
  });

  it('should skip insertion when accounts already exist', async () => {
    await useCase.execute({ tenantId: 'tenant-1', userId: 'user-1' });
    await useCase.execute({ tenantId: 'tenant-1', userId: 'user-1' });

    expect(repo.all()).toHaveLength(K_IFRS_DEFAULT_ACCOUNTS.length);
  });

  it('should be race-safe via ON CONFLICT — concurrent inserts do not double the count', async () => {
    await Promise.all([
      useCase.execute({ tenantId: 'tenant-1', userId: 'user-1' }),
      useCase.execute({ tenantId: 'tenant-1', userId: 'user-1' }),
    ]);

    const count = repo.all().filter((r) => r.tenantId === 'tenant-1').length;
    expect(count).toBe(K_IFRS_DEFAULT_ACCOUNTS.length);
  });
});
