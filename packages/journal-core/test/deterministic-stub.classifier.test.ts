// Unit tests for DeterministicStubClassifier.

import { describe, it, expect } from 'vitest';
import { DeterministicStubClassifier } from '../src/infrastructure/stub/deterministic-stub.classifier.js';

describe('DeterministicStubClassifier', () => {
  it('should return balanced lines using seeded chart codes when amount is positive', async () => {
    const classifier = new DeterministicStubClassifier();

    const result = await classifier.classify({
      date: '2026-05-01',
      amount: 12_000,
      counterparty: 'Shop',
      memo: 'Supplies',
    });

    expect(result.modelId).toContain('stub');
    expect(result.lines).toHaveLength(2);
    const debitSum = result.lines.reduce((s, l) => s + l.debit, 0);
    const creditSum = result.lines.reduce((s, l) => s + l.credit, 0);
    expect(debitSum).toBe(creditSum);
  });
});
