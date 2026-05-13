// Unit tests for the trial-balance builder — verifies per-account roll-up + Σdebit.certain==Σcredit.certain invariant.

import { describe, it, expect } from 'vitest';
import {
  buildTrialBalance,
  type AmountBreakdown,
  type JournalLineAggregate,
  type ReportMetadata,
} from '../src/index.js';

const metadata: ReportMetadata = {
  generatedAt: '2026-05-12T00:00:00Z',
  accountingStandard: 'K-IFRS',
  uncertainEntryCount: 0,
  note: '',
};

const b = (certain: number, uncertain = 0): AmountBreakdown => ({
  certain,
  uncertain,
  total: certain + uncertain,
});

describe('buildTrialBalance', () => {
  it('should aggregate journal lines into AccountBalanceRow with normal-balance-aware balance sign', () => {
    const rows: JournalLineAggregate[] = [
      { accountCode: '1002', accountName: '보통예금', normalBalance: 'debit', totalDebit: b(100_000), totalCredit: b(30_000) },
      { accountCode: '4001', accountName: '매출',     normalBalance: 'credit', totalDebit: b(0),       totalCredit: b(70_000) },
    ];

    const result = buildTrialBalance('2026-05-31', rows, metadata);

    expect(result.totalDebit.certain).toBe(100_000);
    expect(result.totalCredit.certain).toBe(100_000);
    expect(result.rows[0]?.balance.certain).toBe(70_000);
    expect(result.rows[1]?.balance.certain).toBe(70_000);
  });

  it('should throw when Σdebit.certain differs from Σcredit.certain beyond the 1 KRW epsilon', () => {
    const rows: JournalLineAggregate[] = [
      { accountCode: '1002', accountName: '보통예금', normalBalance: 'debit',  totalDebit: b(100_000), totalCredit: b(0) },
      { accountCode: '4001', accountName: '매출',     normalBalance: 'credit', totalDebit: b(0),       totalCredit: b(95_000) },
    ];

    expect(() => buildTrialBalance('2026-05-31', rows, metadata)).toThrow(/out of balance/);
  });

  it('should tolerate uncertain imbalance because uncertain is opt-in transparency, not an accounting invariant', () => {
    const rows: JournalLineAggregate[] = [
      { accountCode: '1002', accountName: '보통예금', normalBalance: 'debit',  totalDebit: b(100_000, 50_000), totalCredit: b(0, 0) },
      { accountCode: '4001', accountName: '매출',     normalBalance: 'credit', totalDebit: b(0, 0),            totalCredit: b(100_000, 30_000) },
    ];

    const result = buildTrialBalance('2026-05-31', rows, metadata);

    expect(result.totalDebit.certain).toBe(100_000);
    expect(result.totalCredit.certain).toBe(100_000);
    expect(result.totalDebit.uncertain).toBe(50_000);
    expect(result.totalCredit.uncertain).toBe(30_000);
  });
});
