// Use case: fetches the BOK USD/KRW closing rate over a fixed walkback window and persists every observation via a writer port.

import type { ExchangeRate, ExchangeRateClient } from '@ym/fx-core';

const SUPPORTED_CURRENCIES = ['USD'] as const;
const WALKBACK_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export interface FxObservationsWriterPort {
  upsertMany(rates: ReadonlyArray<ExchangeRate>): Promise<void>;
}

export interface CollectFxRatesResult {
  readonly ok: true;
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly upserted: number;
  readonly perCurrency: Readonly<Record<SupportedCurrency, number>>;
}

const toIsoDate = (date: Date): string => date.toISOString().slice(0, 10);

export class CollectFxRatesUseCase {
  constructor(
    private readonly rateClient: ExchangeRateClient,
    private readonly writer: FxObservationsWriterPort,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<CollectFxRatesResult> {
    const now = this.clock();
    const windowTo = toIsoDate(now);
    const windowFrom = toIsoDate(new Date(now.getTime() - WALKBACK_DAYS * MS_PER_DAY));

    const perCurrency: Record<SupportedCurrency, number> = { USD: 0 };
    let upserted = 0;

    for (const currency of SUPPORTED_CURRENCIES) {
      const rates = await this.rateClient.getRange({ quoteCurrency: currency, fromDate: windowFrom, toDate: windowTo });
      await this.writer.upsertMany(rates);
      perCurrency[currency] = rates.length;
      upserted += rates.length;
    }

    return { ok: true, windowFrom, windowTo, upserted, perCurrency };
  }
}
