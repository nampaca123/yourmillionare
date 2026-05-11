// Cash flow builder (indirect method) — net income + working-capital deltas + non-cash adjustments.

import type { CashFlowStatement, LineItem, ReportMetadata, SectionBlock } from '../types.js';

const EPSILON_KRW = 1;

const section = (items: ReadonlyArray<LineItem>): SectionBlock => ({
  items,
  subtotal: items.reduce((s, i) => s + i.amount, 0),
});

export interface CashFlowInput {
  readonly from: string;
  readonly to: string;
  readonly netIncome: number;
  readonly operatingAdjustments: ReadonlyArray<LineItem>;
  readonly investingFlows: ReadonlyArray<LineItem>;
  readonly financingFlows: ReadonlyArray<LineItem>;
  readonly openingCash: number;
  readonly closingCash: number;
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
  const netChange = operating.subtotal + investing.subtotal + financing.subtotal;
  const expectedClosing = input.openingCash + netChange;
  if (Math.abs(expectedClosing - input.closingCash) > EPSILON_KRW) {
    throw new Error(
      `Cash flow reconciliation broken: opening(${input.openingCash}) + netChange(${netChange}) != closing(${input.closingCash})`,
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
