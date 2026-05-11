// Balance sheet builder — splits asset/liability rows by is_current and asserts the accounting identity.

import type { BalanceSheet, LineItem, ReportMetadata, SectionBlock } from '../types.js';

export interface BalanceSheetInputRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountKind: 'asset' | 'liability' | 'equity';
  readonly isCurrent: boolean | null;
  readonly amount: number;
}

const EPSILON_KRW = 1;

const section = (items: ReadonlyArray<LineItem>): SectionBlock => ({
  items,
  subtotal: items.reduce((s, i) => s + i.amount, 0),
});

const toItem = (row: BalanceSheetInputRow): LineItem => ({
  accountCode: row.accountCode,
  accountName: row.accountName,
  amount: row.amount,
});

export interface BalanceSheetBuilderInput {
  readonly asOf: string;
  readonly rows: ReadonlyArray<BalanceSheetInputRow>;
  readonly metadata: ReportMetadata;
}

export const buildBalanceSheet = (input: BalanceSheetBuilderInput): BalanceSheet => {
  const assetCurrent = section(input.rows.filter((r) => r.accountKind === 'asset' && r.isCurrent === true).map(toItem));
  const assetNonCurrent = section(input.rows.filter((r) => r.accountKind === 'asset' && r.isCurrent === false).map(toItem));
  const liabilityCurrent = section(input.rows.filter((r) => r.accountKind === 'liability' && r.isCurrent === true).map(toItem));
  const liabilityNonCurrent = section(input.rows.filter((r) => r.accountKind === 'liability' && r.isCurrent === false).map(toItem));
  const equity = section(input.rows.filter((r) => r.accountKind === 'equity').map(toItem));

  const totalAssets = assetCurrent.subtotal + assetNonCurrent.subtotal;
  const totalLiabilities = liabilityCurrent.subtotal + liabilityNonCurrent.subtotal;
  const totalLiabilitiesAndEquity = totalLiabilities + equity.subtotal;

  if (Math.abs(totalAssets - totalLiabilitiesAndEquity) > EPSILON_KRW) {
    throw new Error(`Balance sheet identity broken: assets=${totalAssets}, L+E=${totalLiabilitiesAndEquity}`);
  }

  return {
    asOf: input.asOf,
    currency: 'KRW',
    assets: { current: assetCurrent, nonCurrent: assetNonCurrent, total: totalAssets },
    liabilities: { current: liabilityCurrent, nonCurrent: liabilityNonCurrent, total: totalLiabilities },
    equity,
    totalLiabilitiesAndEquity,
    metadata: input.metadata,
  };
};
