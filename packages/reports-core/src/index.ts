// Barrel export for @ym/reports-core.

export type {
  AccountBalanceRow,
  LineItem,
  SectionBlock,
  IncomeStatement,
  BalanceSheet,
  CashFlowStatement,
  TrialBalance,
  ReportMetadata,
} from './types.js';

export type { JournalLineAggregate } from './builders/trial-balance-builder.js';
export { buildTrialBalance } from './builders/trial-balance-builder.js';

export type { PnlInputRow, PnlBuilderInput } from './builders/pnl-builder.js';
export { buildIncomeStatement } from './builders/pnl-builder.js';

export type { BalanceSheetInputRow, BalanceSheetBuilderInput } from './builders/balance-sheet-builder.js';
export { buildBalanceSheet } from './builders/balance-sheet-builder.js';

export type { CashFlowInput } from './builders/cash-flow-builder.js';
export { buildCashFlowStatement } from './builders/cash-flow-builder.js';
