// Unit tests for CollectFxRatesUseCase using in-memory ExchangeRateClient and writer ports.

import { describe, it, expect } from 'vitest';
import type { ExchangeRate, ExchangeRateClient } from '@ym/fx-core';
import { CollectFxRatesUseCase, type FxObservationsWriterPort } from '../src/application/collect-fx-rates.use-case.js';

interface CapturedRange {
  readonly quoteCurrency: string;
  readonly fromDate: string;
  readonly toDate: string;
}

class StubExchangeRateClient implements ExchangeRateClient {
  public readonly ranges: CapturedRange[] = [];
  constructor(private readonly response: ReadonlyArray<ExchangeRate>) {}

  async getRate(): Promise<ExchangeRate | null> {
    return null;
  }

  async getRange(input: { quoteCurrency: string; fromDate: string; toDate: string }): Promise<ReadonlyArray<ExchangeRate>> {
    this.ranges.push({ quoteCurrency: input.quoteCurrency, fromDate: input.fromDate, toDate: input.toDate });
    return this.response;
  }
}

class InMemoryFxObservationsWriter implements FxObservationsWriterPort {
  public readonly upserts: ReadonlyArray<ExchangeRate>[] = [];
  async upsertMany(rates: ReadonlyArray<ExchangeRate>): Promise<void> {
    this.upserts.push(rates);
  }
}

const makeRate = (effectiveDate: string, value: number): ExchangeRate => ({
  baseCurrency: 'KRW',
  quoteCurrency: 'USD',
  rate: value,
  rateType: 'closing',
  requestedDate: effectiveDate,
  effectiveDate,
  source: 'ECOS',
});

const FROZEN_CLOCK = (): Date => new Date('2026-05-13T03:00:00.000Z');

describe('CollectFxRatesUseCase', () => {
  it('should query ECOS over a 14-day window ending today when executed', async () => {
    const client = new StubExchangeRateClient([makeRate('2026-05-13', 1380)]);
    const writer = new InMemoryFxObservationsWriter();
    const useCase = new CollectFxRatesUseCase(client, writer, FROZEN_CLOCK);

    await useCase.execute();

    expect(client.ranges).toEqual([{ quoteCurrency: 'USD', fromDate: '2026-04-29', toDate: '2026-05-13' }]);
  });

  it('should upsert every fetched observation when the window returns rows', async () => {
    const fetched = [makeRate('2026-05-12', 1379.5), makeRate('2026-05-13', 1381.0)];
    const client = new StubExchangeRateClient(fetched);
    const writer = new InMemoryFxObservationsWriter();
    const useCase = new CollectFxRatesUseCase(client, writer, FROZEN_CLOCK);

    const result = await useCase.execute();

    expect(writer.upserts).toEqual([fetched]);
    expect(result.upserted).toBe(2);
    expect(result.perCurrency.USD).toBe(2);
  });

  it('should report zero upserts when the ECOS window returns no rows', async () => {
    const client = new StubExchangeRateClient([]);
    const writer = new InMemoryFxObservationsWriter();
    const useCase = new CollectFxRatesUseCase(client, writer, FROZEN_CLOCK);

    const result = await useCase.execute();

    expect(result.upserted).toBe(0);
    expect(writer.upserts).toEqual([[]]);
  });
});
