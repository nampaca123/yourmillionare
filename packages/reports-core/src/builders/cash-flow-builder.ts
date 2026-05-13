// Cash flow builder (indirect) — net income + working-capital deltas. Cash carries certain/uncertain breakdown.

import {
  addBreakdown,
  subtractBreakdown,
  sumBreakdown,
  zeroBreakdown,
  type AmountBreakdown,
  type CashFlowStatement,
  type LineItem,
  type ReportMetadata,
  type SectionBlock,
} from '../types.js';

const EPSILON_KRW = 1;

const section = (items: ReadonlyArray<LineItem>): SectionBlock => ({
  items,
  subtotal: sumBreakdown(items.map((i) => i.amount)),
});

export interface CashFlowInput {
  readonly from: string;
  readonly to: string;
  readonly netIncome: AmountBreakdown;
  readonly operatingAdjustments: ReadonlyArray<LineItem>;
  readonly investingFlows: ReadonlyArray<LineItem>;
  readonly financingFlows: ReadonlyArray<LineItem>;
  readonly openingCash: AmountBreakdown;
  readonly closingCash: AmountBreakdown;
  readonly metadata: ReportMetadata;
}

export const buildCashFlowStatement = (input: CashFlowInput): CashFlowStatement => {
  const operatingItems: LineItem[] = [
    { accountCode: '__net_income', accountName: '당기순이익', amount: input.netIncome },
    ...input.operatingAdjustments,
  ];
  const operating = section(operatingItems);
  const investing = section(input.investingFlows);
  const financing = section(input.financingFlows);
  const netChange = addBreakdown(addBreakdown(operating.subtotal, investing.subtotal), financing.subtotal);

  // Certain-only reconciliation check.
  const expectedClosingCertain = input.openingCash.certain + netChange.certain;
  if (Math.abs(expectedClosingCertain - input.closingCash.certain) > EPSILON_KRW) {
    throw new Error(
      `Cash flow reconciliation broken (certain only): opening(${input.openingCash.certain}) + netChange(${netChange.certain}) != closing(${input.closingCash.certain})`,
    );
  }
  return {
    from: input.from,
    to: input.to,
    currency: 'KRW',
    method: 'indirect',
    operating,
    investing,
    financing,
    netChange,
    openingCash: input.openingCash,
    closingCash: input.closingCash,
    metadata: input.metadata,
  };
};

export { zeroBreakdown, subtractBreakdown };
