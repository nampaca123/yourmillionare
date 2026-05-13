// Port: aggregated read models that feed the K-IFRS report builders. All numbers carry certain/uncertain breakdown.

import type {
  AmountBreakdown,
  BalanceSheetInputRow,
  JournalLineAggregate,
  PnlInputRow,
} from '@ym/reports-core';

export interface ReportsRepository {
  pnlAggregates(input: { tenantId: string; fromDate: string; toDate: string }): Promise<ReadonlyArray<PnlInputRow>>;
  balanceSheetAggregates(input: { tenantId: string; asOf: string }): Promise<ReadonlyArray<BalanceSheetInputRow>>;
  trialBalanceAggregates(input: { tenantId: string; asOf: string }): Promise<ReadonlyArray<JournalLineAggregate>>;
  cashSnapshot(input: { tenantId: string; asOf: string }): Promise<AmountBreakdown>;
  countUncertain(input: { tenantId: string }): Promise<number>;
}
