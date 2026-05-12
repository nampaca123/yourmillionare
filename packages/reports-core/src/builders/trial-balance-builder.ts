// Trial balance builder — groups raw journal-line aggregates into per-account totals and validates Σdebit == Σcredit.

import type { AccountBalanceRow, TrialBalance, ReportMetadata } from '../types.js';

export interface JournalLineAggregate {
  readonly accountCode: string;
  readonly accountName: string;
  readonly normalBalance: 'debit' | 'credit';
  readonly totalDebit: number;
  readonly totalCredit: number;
}

const EPSILON_KRW = 1;

export const buildTrialBalance = (
  asOf: string,
  rows: ReadonlyArray<JournalLineAggregate>,
  metadata: ReportMetadata,
): TrialBalance => {
  const accountRows: AccountBalanceRow[] = rows.map((row) => {
    const balance =
      row.normalBalance === 'debit' ? row.totalDebit - row.totalCredit : row.totalCredit - row.totalDebit;
    return {
      accountCode: row.accountCode,
      accountName: row.accountName,
      debit: row.totalDebit,
      credit: row.totalCredit,
      balance,
    };
  });
  const totalDebit = accountRows.reduce((sum, r) => sum + r.debit, 0);
  const totalCredit = accountRows.reduce((sum, r) => sum + r.credit, 0);
  if (Math.abs(totalDebit - totalCredit) > EPSILON_KRW) {
    throw new Error(`Trial balance out of balance: Σdebit=${totalDebit}, Σcredit=${totalCredit}`);
  }
  return { asOf, currency: 'KRW', rows: accountRows, totalDebit, totalCredit, metadata };
};
