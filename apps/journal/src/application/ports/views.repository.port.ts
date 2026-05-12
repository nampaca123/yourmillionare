// Port: aggregated read models for the 4 core views (Monthly Summary, Receivables Kanban, Account Balances, Drafts).

export interface MonthlySummary {
  readonly ym: string;
  readonly income: number;
  readonly expense: number;
  readonly netCashBalance: number;
  readonly forecastNextMonth: number;
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
  readonly balance: number;
  readonly currency: string;
}

export interface JournalEntryDraft {
  readonly rawTransactionId: string;
  readonly tenantId: string;
  readonly draftLines: ReadonlyArray<{
    lineNo: number;
    accountCode: string;
    debit: number;
    credit: number;
    memo: string | null;
  }>;
  readonly heuristicConfidence: number | null;
  readonly ruleId: string | null;
  readonly createdAt: string;
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
  listDrafts(input: { tenantId: string }): Promise<ReadonlyArray<JournalEntryDraft>>;
}
