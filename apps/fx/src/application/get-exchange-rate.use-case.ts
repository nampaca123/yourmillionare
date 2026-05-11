// Use case: serve a cached ECOS rate (with walk-back) for /fx/rates/usd-krw GET.

import {
  ExchangeRateUnavailableError,
  resolveRateWithWalkback,
  type ExchangeRate,
  type ExchangeRateClient,
} from '@ym/fx-core';
import type { PgFxObservationsRepository } from '../infrastructure/outbound/pg/pg-fx-observations.repository.js';

export class GetExchangeRateUseCase {
  constructor(
    private readonly client: ExchangeRateClient,
    private readonly cache: PgFxObservationsRepository,
  ) {}

  async getRate(input: { quoteCurrency: string; date: string }): Promise<ExchangeRate> {
    const cached = await this.cache.findLatestOnOrBefore({
      quoteCurrency: input.quoteCurrency,
      onOrBefore: input.date,
    });
    if (cached && cached.effectiveDate === input.date) {
      return { ...cached, requestedDate: input.date };
    }
    const resolved = await resolveRateWithWalkback(this.client, input.quoteCurrency, input.date);
    await this.cache.upsertMany([resolved]);
    return resolved;
  }

  async getRange(input: {
    quoteCurrency: string;
    fromDate: string;
    toDate: string;
  }): Promise<ReadonlyArray<ExchangeRate>> {
    const cached = await this.cache.listRange(input);
    if (cached.length > 0) return cached;
    const fresh = await this.client.getRange(input);
    if (fresh.length === 0) {
      throw new ExchangeRateUnavailableError(input.quoteCurrency, input.toDate, 0);
    }
    await this.cache.upsertMany(fresh);
    return fresh;
  }
}
