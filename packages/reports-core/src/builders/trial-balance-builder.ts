// Trial balance builder — per-account totals with certain/uncertain breakdown; validates Σdebit.certain == Σcredit.certain.

import {
  addBreakdown,
  subtractBreakdown,
  sumBreakdown,
  zeroBreakdown,
  type AccountBalanceRow,
  type AmountBreakdown,
  type TrialBalance,
  type ReportMetadata,
} from '../types.js';

export interface JournalLineAggregate {
  readonly accountCode: string;
  readonly accountName: string;
  readonly normalBalance: 'debit' | 'credit';
  readonly totalDebit: AmountBreakdown;
  readonly totalCredit: AmountBreakdown;
}

const EPSILON_KRW = 1;

export const buildTrialBalance = (
  asOf: string,
  rows: ReadonlyArray<JournalLineAggregate>,
  metadata: ReportMetadata,
): TrialBalance => {
  const accountRows: AccountBalanceRow[] = rows.map((row) => {
    const balance =
      row.normalBalance === 'debit'
        ? subtractBreakdown(row.totalDebit, row.totalCredit)
        : subtractBreakdown(row.totalCredit, row.totalDebit);
    return {
      accountCode: row.accountCode,
      accountName: row.accountName,
      debit: row.totalDebit,
      credit: row.totalCredit,
      balance,
    };
  });
  const totalDebit = sumBreakdown(accountRows.map((r) => r.debit));
  const totalCredit = sumBreakdown(accountRows.map((r) => r.credit));

  if (Math.abs(totalDebit.certain - totalCredit.certain) > EPSILON_KRW) {
    throw new Error(
      `Trial balance certain side out of balance: Σdebit.certain=${totalDebit.certain}, Σcredit.certain=${totalCredit.certain}`,
    );
  }
  return { asOf, currency: 'KRW', rows: accountRows, totalDebit, totalCredit, metadata };
};

export { addBreakdown, zeroBreakdown };
