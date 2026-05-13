// P&L builder — collapses period-scoped journal aggregates into K-IFRS income statement with certain/uncertain breakdown.

import {
  addBreakdown,
  subtractBreakdown,
  sumBreakdown,
  zeroBreakdown,
  type AmountBreakdown,
  type IncomeStatement,
  type LineItem,
  type ReportMetadata,
  type SectionBlock,
} from '../types.js';

export interface PnlInputRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountKind: 'revenue' | 'cogs' | 'operating_expense' | 'non_operating' | 'income_tax';
  readonly amount: AmountBreakdown;
}

const toLineItem = (row: PnlInputRow): LineItem => ({
  accountCode: row.accountCode,
  accountName: row.accountName,
  amount: row.amount,
});

const buildSection = (items: ReadonlyArray<LineItem>): SectionBlock => ({
  items,
  subtotal: sumBreakdown(items.map((i) => i.amount)),
});

export interface PnlBuilderInput {
  readonly from: string;
  readonly to: string;
  readonly rows: ReadonlyArray<PnlInputRow>;
  readonly metadata: ReportMetadata;
}

export const buildIncomeStatement = (input: PnlBuilderInput): IncomeStatement => {
  const revenue = buildSection(input.rows.filter((r) => r.accountKind === 'revenue').map(toLineItem));
  const cogs = buildSection(input.rows.filter((r) => r.accountKind === 'cogs').map(toLineItem));
  const operatingExpenses = buildSection(input.rows.filter((r) => r.accountKind === 'operating_expense').map(toLineItem));
  const nonOperating = buildSection(input.rows.filter((r) => r.accountKind === 'non_operating').map(toLineItem));
  const incomeTax = input.rows
    .filter((r) => r.accountKind === 'income_tax')
    .reduce<AmountBreakdown>((acc, r) => addBreakdown(acc, r.amount), zeroBreakdown());

  const grossProfit = subtractBreakdown(revenue.subtotal, cogs.subtotal);
  const operatingIncome = subtractBreakdown(grossProfit, operatingExpenses.subtotal);
  const netIncomeBeforeTax = addBreakdown(operatingIncome, nonOperating.subtotal);
  const netIncome = subtractBreakdown(netIncomeBeforeTax, incomeTax);

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
