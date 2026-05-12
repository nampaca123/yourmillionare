// Unit tests for the trial-balance builder — verifies per-account roll-up + Σdebit==Σcredit invariant.

import { describe, it, expect } from 'vitest';
import { buildTrialBalance, type JournalLineAggregate, type ReportMetadata } from '../src/index.js';

const metadata: ReportMetadata = {
  generatedAt: '2026-05-12T00:00:00Z',
  accountingStandard: 'K-IFRS',
  includesUnclassifiedDrafts: false,
};

describe('buildTrialBalance', () => {
  it('should aggregate journal lines into AccountBalanceRow with normal-balance-aware balance sign', () => {
    const rows: JournalLineAggregate[] = [
      { accountCode: '1002', accountName: '보통예금', normalBalance: 'debit', totalDebit: 100_000, totalCredit: 30_000 },
      { accountCode: '4001', accountName: '매출', normalBalance: 'credit', totalDebit: 0, totalCredit: 70_000 },
    ];

    const result = buildTrialBalance('2026-05-31', rows, metadata);

    expect(result.totalDebit).toBe(100_000);
    expect(result.totalCredit).toBe(100_000);
    expect(result.rows[0]?.balance).toBe(70_000);
    expect(result.rows[1]?.balance).toBe(70_000);
  });

  it('should throw when Σdebit differs from Σcredit beyond the 1 KRW epsilon', () => {
    const rows: JournalLineAggregate[] = [
      { accountCode: '1002', accountName: '보통예금', normalBalance: 'debit', totalDebit: 100_000, totalCredit: 0 },
      { accountCode: '4001', accountName: '매출', normalBalance: 'credit', totalDebit: 0, totalCredit: 95_000 },
    ];

    expect(() => buildTrialBalance('2026-05-31', rows, metadata)).toThrow(/out of balance/);
  });

  it('should accept a 1 KRW rounding gap (within epsilon)', () => {
    const rows: JournalLineAggregate[] = [
      { accountCode: '1002', accountName: '보통예금', normalBalance: 'debit', totalDebit: 100_000, totalCredit: 0 },
      { accountCode: '4001', accountName: '매출', normalBalance: 'credit', totalDebit: 0, totalCredit: 99_999 },
    ];

    const result = buildTrialBalance('2026-05-31', rows, metadata);

    expect(result.totalDebit - result.totalCredit).toBe(1);
  });
});
