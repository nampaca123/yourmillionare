// ExchangeRate value object + ECOS-aware lookup port + walk-back helper for non-business days.

export type FxRateType = 'closing' | 'transaction' | 'tt_buy' | 'tt_sell' | 'cash_buy' | 'cash_sell';

export type FxSource = 'ECOS' | 'BANK' | 'MANUAL' | 'FALLBACK';

export interface ExchangeRate {
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly rate: number;
  readonly rateType: FxRateType;
  readonly requestedDate: string;
  readonly effectiveDate: string;
  readonly source: FxSource;
}

export class ExchangeRateUnavailableError extends Error {
  constructor(
    public readonly quoteCurrency: string,
    public readonly requestedDate: string,
    public readonly searchedBackDays: number,
  ) {
    super(`Exchange rate ${quoteCurrency} unavailable on or before ${requestedDate} (searched ${searchedBackDays} days)`);
    this.name = 'ExchangeRateUnavailableError';
  }
}

export interface ExchangeRateClient {
  getRate(input: { quoteCurrency: string; date: string; rateType?: FxRateType }): Promise<ExchangeRate | null>;
  getRange(input: {
    quoteCurrency: string;
    fromDate: string;
    toDate: string;
    rateType?: FxRateType;
  }): Promise<ReadonlyArray<ExchangeRate>>;
}

const MAX_WALKBACK_DAYS = 7;

export const resolveRateWithWalkback = async (
  client: ExchangeRateClient,
  quoteCurrency: string,
  requestedDate: string,
  rateType: FxRateType = 'closing',
): Promise<ExchangeRate> => {
  let cursor = new Date(`${requestedDate}T00:00:00Z`);
  for (let i = 0; i <= MAX_WALKBACK_DAYS; i += 1) {
    const iso = cursor.toISOString().slice(0, 10);
    const found = await client.getRate({ quoteCurrency, date: iso, rateType });
    if (found) {
      return { ...found, requestedDate, effectiveDate: iso };
    }
    cursor = new Date(cursor.getTime() - 86_400_000);
  }
  throw new ExchangeRateUnavailableError(quoteCurrency, requestedDate, MAX_WALKBACK_DAYS);
};
