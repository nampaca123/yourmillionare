// Unit tests for ClassifyTransactionUseCase.

import { describe, it, expect, beforeEach } from 'vitest';
import { ClassifyTransactionUseCase } from '../src/application/classify-transaction.use-case.js';
import { FakeTransactionClassifier } from './fakes/fake-transaction-classifier.js';
import { InMemoryJournalRepository } from './fakes/in-memory-journal.repository.js';
import { InMemoryCostCounter } from './fakes/in-memory-cost-counter.js';
import { RateLimitError } from '@ym/shared-errors';

const TODAY = '2026-05-07';
const INPUT = { date: TODAY, amount: 50000, counterparty: 'KT', memo: '통신비' };

describe('ClassifyTransactionUseCase', () => {
  let useCase: ClassifyTransactionUseCase;
  let classifier: FakeTransactionClassifier;
  let journals: InMemoryJournalRepository;
  let costs: InMemoryCostCounter;

  beforeEach(() => {
    classifier = new FakeTransactionClassifier();
    journals = new InMemoryJournalRepository();
    costs = new InMemoryCostCounter();
    useCase = new ClassifyTransactionUseCase(classifier, journals, costs, 3);
  });

  it('should persist a journal entry when within daily limit', async () => {
    const entry = await useCase.execute({ tenantId: 'tenant-1', userId: 'user-1', input: INPUT });

    expect(entry.id).toBeDefined();
    expect(entry.aiConfidence).toBe(0.95);
    expect(journals.all()).toHaveLength(1);
  });

  it('should throw RateLimitError when daily limit is exceeded', async () => {
    for (let i = 0; i < 3; i++) {
      await useCase.execute({ tenantId: 'tenant-1', userId: 'user-1', input: { ...INPUT, memo: `memo-${i}` } });
    }

    await expect(
      useCase.execute({ tenantId: 'tenant-1', userId: 'user-1', input: INPUT }),
    ).rejects.toBeInstanceOf(RateLimitError);
  });

  it('should not count toward limit for a different user', async () => {
    for (let i = 0; i < 3; i++) {
      await useCase.execute({ tenantId: 'tenant-1', userId: 'user-1', input: { ...INPUT, memo: `memo-${i}` } });
    }

    await expect(
      useCase.execute({ tenantId: 'tenant-1', userId: 'user-2', input: INPUT }),
    ).resolves.toBeDefined();
  });
});
