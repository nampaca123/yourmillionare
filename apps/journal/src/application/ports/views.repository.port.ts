// Port: aggregated read models for monthly summary, receivables, and account balances. All amounts carry breakdown.

import type { AmountBreakdown } from '@ym/reports-core';

export interface MonthlySummary {
  readonly ym: string;
  readonly income: AmountBreakdown;
  readonly expense: AmountBreakdown;
  readonly netCashBalance: AmountBreakdown;
  readonly forecastNextMonth: AmountBreakdown;
  readonly currency: 'KRW';
}

export type ReceivableStatus = 'PENDING' | 'DUE_SOON' | 'OVERDUE' | 'COLLECTED';

export interface ReceivableCard {
  readonly entryId: string;
  readonly entryDate: string;
  readonly counterparty: string | null;
  readonly amount: number;
  readonly dueDate: string | null;
  readonly daysOverdue: number;
  readonly confidenceStatus: 'certain' | 'uncertain';
}

export interface ReceivablesBoard {
  readonly pending: ReadonlyArray<ReceivableCard>;
  readonly dueSoon: ReadonlyArray<ReceivableCard>;
  readonly overdue: ReadonlyArray<ReceivableCard>;
  readonly collected: ReadonlyArray<ReceivableCard>;
}

export interface AccountBalanceCard {
  readonly accountCode: string;
  readonly accountName: string;
  readonly displayName: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly balance: AmountBreakdown;
  readonly currency: string;
}

export interface ViewsRepository {
  monthlySummary(input: { tenantId: string; ym: string }): Promise<MonthlySummary>;
  listReceivables(input: { tenantId: string; today: string; dueSoonDays: number }): Promise<ReceivablesBoard>;
  updateReceivableStatus(input: {
    tenantId: string;
    entryId: string;
    status: ReceivableStatus;
    collectedAt?: string;
  }): Promise<void>;
  listAccountBalances(input: { tenantId: string }): Promise<ReadonlyArray<AccountBalanceCard>>;
}
