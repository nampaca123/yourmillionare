// K-IFRS financial statement value objects produced by report builders.
// Every numeric carries a {certain, uncertain, total} breakdown so the API never hides AI-suggested data.

export interface AmountBreakdown {
  readonly certain: number;
  readonly uncertain: number;
  readonly total: number;
}

export const zeroBreakdown = (): AmountBreakdown => ({ certain: 0, uncertain: 0, total: 0 });

export const addBreakdown = (a: AmountBreakdown, b: AmountBreakdown): AmountBreakdown => ({
  certain: a.certain + b.certain,
  uncertain: a.uncertain + b.uncertain,
  total: a.total + b.total,
});

export const subtractBreakdown = (a: AmountBreakdown, b: AmountBreakdown): AmountBreakdown => ({
  certain: a.certain - b.certain,
  uncertain: a.uncertain - b.uncertain,
  total: a.total - b.total,
});

export const sumBreakdown = (parts: ReadonlyArray<AmountBreakdown>): AmountBreakdown =>
  parts.reduce(addBreakdown, zeroBreakdown());

export interface AccountBalanceRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly debit: AmountBreakdown;
  readonly credit: AmountBreakdown;
  readonly balance: AmountBreakdown;
}

export interface LineItem {
  readonly accountCode: string;
  readonly accountName: string;
  readonly amount: AmountBreakdown;
}

export interface SectionBlock {
  readonly items: ReadonlyArray<LineItem>;
  readonly subtotal: AmountBreakdown;
}

export interface IncomeStatement {
  readonly from: string;
  readonly to: string;
  readonly currency: 'KRW';
  readonly revenue: SectionBlock;
  readonly cogs: SectionBlock;
  readonly grossProfit: AmountBreakdown;
  readonly operatingExpenses: SectionBlock;
  readonly operatingIncome: AmountBreakdown;
  readonly nonOperating: SectionBlock;
  readonly netIncomeBeforeTax: AmountBreakdown;
  readonly incomeTax: AmountBreakdown;
  readonly netIncome: AmountBreakdown;
  readonly metadata: ReportMetadata;
}

export interface BalanceSheet {
  readonly asOf: string;
  readonly currency: 'KRW';
  readonly assets: { current: SectionBlock; nonCurrent: SectionBlock; total: AmountBreakdown };
  readonly liabilities: { current: SectionBlock; nonCurrent: SectionBlock; total: AmountBreakdown };
  readonly equity: SectionBlock;
  readonly totalLiabilitiesAndEquity: AmountBreakdown;
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
  readonly netChange: AmountBreakdown;
  readonly openingCash: AmountBreakdown;
  readonly closingCash: AmountBreakdown;
  readonly metadata: ReportMetadata;
}

export interface TrialBalance {
  readonly asOf: string;
  readonly currency: 'KRW';
  readonly rows: ReadonlyArray<AccountBalanceRow>;
  readonly totalDebit: AmountBreakdown;
  readonly totalCredit: AmountBreakdown;
  readonly metadata: ReportMetadata;
}

export interface ReportMetadata {
  readonly generatedAt: string;
  readonly accountingStandard: 'K-IFRS';
  readonly uncertainEntryCount: number;
  readonly note: string;
}
