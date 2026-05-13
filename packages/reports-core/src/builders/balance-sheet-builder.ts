// Balance sheet builder — splits asset/liability rows by is_current; numbers carry certain/uncertain breakdown.

import {
  addBreakdown,
  sumBreakdown,
  subtractBreakdown,
  zeroBreakdown,
  type AmountBreakdown,
  type BalanceSheet,
  type LineItem,
  type ReportMetadata,
  type SectionBlock,
} from '../types.js';

export interface BalanceSheetInputRow {
  readonly accountCode: string;
  readonly accountName: string;
  readonly accountKind: 'asset' | 'liability' | 'equity';
  readonly isCurrent: boolean | null;
  readonly amount: AmountBreakdown;
}

const EPSILON_KRW = 1;

const section = (items: ReadonlyArray<LineItem>): SectionBlock => ({
  items,
  subtotal: sumBreakdown(items.map((i) => i.amount)),
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

  const totalAssets = addBreakdown(assetCurrent.subtotal, assetNonCurrent.subtotal);
  const totalLiabilities = addBreakdown(liabilityCurrent.subtotal, liabilityNonCurrent.subtotal);
  const totalLiabilitiesAndEquity = addBreakdown(totalLiabilities, equity.subtotal);

  // Certain-only identity check (uncertain entries may transiently make BS not balance until confirmed).
  const certainDiff = subtractBreakdown(totalAssets, totalLiabilitiesAndEquity).certain;
  if (Math.abs(certainDiff) > EPSILON_KRW) {
    throw new Error(
      `Balance sheet identity broken (certain only): assets.certain=${totalAssets.certain}, L+E.certain=${totalLiabilitiesAndEquity.certain}`,
    );
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

export { zeroBreakdown };
