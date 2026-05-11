// Use case: month-end IAS 21 revaluation orchestrator. Caller must already verify tenant membership.

import { resolveRateWithWalkback, type ExchangeRateClient } from '@ym/fx-core';

export interface RevaluationResult {
  readonly asOf: string;
  readonly currency: 'USD';
  readonly rateUsed: number;
  readonly effectiveDate: string;
  readonly pending: string;
}

export class RevalueForeignBalancesUseCase {
  constructor(private readonly ratesClient: ExchangeRateClient) {}

  async execute({ asOf }: { tenantId: string; asOf: string }): Promise<RevaluationResult> {
    const rate = await resolveRateWithWalkback(this.ratesClient, 'USD', asOf);
    return {
      asOf,
      currency: 'USD',
      rateUsed: rate.rate,
      effectiveDate: rate.effectiveDate,
      pending: 'Wave-5: read open FX balances + buildRevaluationLines + journal-entry insert',
    };
  }
}
