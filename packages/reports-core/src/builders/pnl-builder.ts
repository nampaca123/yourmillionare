// P&L builder — collapses period-scoped journal aggregates into the K-IFRS income statement.

import type { IncomeStatement, LineItem, ReportMetadata, SectionBlock } from '../types.js';

export interface PnlInputRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountKind: 'revenue' | 'cogs' | 'operating_expense' | 'non_operating' | 'income_tax';
  readonly amount: number;
}

const buildSection = (items: ReadonlyArray<LineItem>): SectionBlock => ({
  items,
  subtotal: items.reduce((sum, item) => sum + item.amount, 0),
});

const toLineItems = (rows: ReadonlyArray<PnlInputRow>): ReadonlyArray<LineItem> =>
  rows.map((row) => ({ accountCode: row.accountCode, accountName: row.accountName, amount: row.amount }));

export interface PnlBuilderInput {
  readonly from: string;
  readonly to: string;
  readonly rows: ReadonlyArray<PnlInputRow>;
  readonly metadata: ReportMetadata;
}

export const buildIncomeStatement = (input: PnlBuilderInput): IncomeStatement => {
  const revenue = buildSection(toLineItems(input.rows.filter((r) => r.accountKind === 'revenue')));
  const cogs = buildSection(toLineItems(input.rows.filter((r) => r.accountKind === 'cogs')));
  const operatingExpenses = buildSection(toLineItems(input.rows.filter((r) => r.accountKind === 'operating_expense')));
  const nonOperating = buildSection(toLineItems(input.rows.filter((r) => r.accountKind === 'non_operating')));
  const incomeTax = input.rows
    .filter((r) => r.accountKind === 'income_tax')
    .reduce((sum, r) => sum + r.amount, 0);

  const grossProfit = revenue.subtotal - cogs.subtotal;
  const operatingIncome = grossProfit - operatingExpenses.subtotal;
  const netIncomeBeforeTax = operatingIncome + nonOperating.subtotal;
  const netIncome = netIncomeBeforeTax - incomeTax;

  return {
    from: input.from,
    to: input.to,
    currency: 'KRW',
    revenue,
    cogs,
    grossProfit,
    operatingExpenses,
    operatingIncome,
    nonOperating,
    netIncomeBeforeTax,
    incomeTax,
    netIncome,
    metadata: input.metadata,
  };
};
