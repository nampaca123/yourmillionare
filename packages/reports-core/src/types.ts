// K-IFRS financial statement value objects produced by report builders.

export interface AccountBalanceRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly debit: number;
  readonly credit: number;
  readonly balance: number;
}

export interface LineItem {
  readonly accountCode: string;
  readonly accountName: string;
  readonly amount: number;
}

export interface SectionBlock {
  readonly items: ReadonlyArray<LineItem>;
  readonly subtotal: number;
}

export interface IncomeStatement {
  readonly from: string;
  readonly to: string;
  readonly currency: 'KRW';
  readonly revenue: SectionBlock;
  readonly cogs: SectionBlock;
  readonly grossProfit: number;
  readonly operatingExpenses: SectionBlock;
  readonly operatingIncome: number;
  readonly nonOperating: SectionBlock;
  readonly netIncomeBeforeTax: number;
  readonly incomeTax: number;
  readonly netIncome: number;
  readonly metadata: ReportMetadata;
}

export interface BalanceSheet {
  readonly asOf: string;
  readonly currency: 'KRW';
  readonly assets: { current: SectionBlock; nonCurrent: SectionBlock; total: number };
  readonly liabilities: { current: SectionBlock; nonCurrent: SectionBlock; total: number };
  readonly equity: SectionBlock;
  readonly totalLiabilitiesAndEquity: number;
  readonly metadata: ReportMetadata;
}

export interface CashFlowStatement {
  readonly from: string;
  readonly to: string;
  readonly currency: 'KRW';
  readonly method: 'indirect';
  readonly operating: SectionBlock;
  readonly investing: SectionBlock;
  readonly financing: SectionBlock;
  readonly netChange: number;
  readonly openingCash: number;
  readonly closingCash: number;
  readonly metadata: ReportMetadata;
}

export interface TrialBalance {
  readonly asOf: string;
  readonly currency: 'KRW';
  readonly rows: ReadonlyArray<AccountBalanceRow>;
  readonly totalDebit: number;
  readonly totalCredit: number;
  readonly metadata: ReportMetadata;
}

export interface ReportMetadata {
  readonly generatedAt: string;
  readonly accountingStandard: 'K-IFRS';
  readonly includesUnclassifiedDrafts: boolean;
}
