// ECOS Open API adapter — fetches BOK 매매기준율 (731Y001 / 0000001) for USD/KRW IAS 21 conversions.

import type { ExchangeRate, ExchangeRateClient, FxRateType } from '@ym/fx-core';
import { BedrockUnavailableError } from '@ym/shared-errors';

const ECOS_BASE_URL = 'https://ecos.bok.or.kr/api/StatisticSearch';
const TABLE_CODE = '731Y001';
const ITEM_CODE_USD = '0000001';
const CYCLE = 'D';
const FETCH_TIMEOUT_MS = 8_000;

interface EcosRow {
  readonly STAT_CODE: string;
  readonly ITEM_CODE1: string;
  readonly TIME: string;
  readonly DATA_VALUE: string;
}

interface EcosSuccessEnvelope {
  readonly StatisticSearch?: {
    readonly list_total_count?: number;
    readonly row?: ReadonlyArray<EcosRow>;
  };
}

interface EcosErrorEnvelope {
  readonly RESULT?: {
    readonly CODE: string;
    readonly MESSAGE: string;
  };
}

const ymd = (date: string): string => date.replaceAll('-', '');

const itemCodeFor = (quoteCurrency: string): string => {
  if (quoteCurrency.toUpperCase() === 'USD') return ITEM_CODE_USD;
  throw new Error(`ECOS item code not configured for ${quoteCurrency}. USD only in this slice.`);
};

const toExchangeRate = (
  row: EcosRow,
  quoteCurrency: string,
  rateType: FxRateType,
  requestedDate: string,
): ExchangeRate => ({
  baseCurrency: 'KRW',
  quoteCurrency,
  rate: Number(row.DATA_VALUE),
  rateType,
  requestedDate,
  effectiveDate: `${row.TIME.slice(0, 4)}-${row.TIME.slice(4, 6)}-${row.TIME.slice(6, 8)}`,
  source: 'ECOS',
});

export interface EcosClientConfig {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
}

export class EcosExchangeRateClient implements ExchangeRateClient {
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: EcosClientConfig) {
    if (!config.apiKey || config.apiKey.length < 4) {
      throw new BedrockUnavailableError('ECOS_API_KEY is missing or malformed');
    }
    this.apiKey = config.apiKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async getRate({
    quoteCurrency,
    date,
    rateType = 'closing',
  }: {
    quoteCurrency: string;
    date: string;
    rateType?: FxRateType;
  }): Promise<ExchangeRate | null> {
    const itemCode = itemCodeFor(quoteCurrency);
    const url = `${ECOS_BASE_URL}/${this.apiKey}/json/kr/1/10/${TABLE_CODE}/${CYCLE}/${ymd(date)}/${ymd(date)}/${itemCode}`;
    const envelope = await this.invoke(url);
    const row = envelope.StatisticSearch?.row?.[0];
    if (!row) return null;
    return toExchangeRate(row, quoteCurrency, rateType, date);
  }

  async getRange({
    quoteCurrency,
    fromDate,
    toDate,
    rateType = 'closing',
  }: {
    quoteCurrency: string;
    fromDate: string;
    toDate: string;
    rateType?: FxRateType;
  }): Promise<ReadonlyArray<ExchangeRate>> {
    const itemCode = itemCodeFor(quoteCurrency);
    const url = `${ECOS_BASE_URL}/${this.apiKey}/json/kr/1/1000/${TABLE_CODE}/${CYCLE}/${ymd(fromDate)}/${ymd(toDate)}/${itemCode}`;
    const envelope = await this.invoke(url);
    return (envelope.StatisticSearch?.row ?? []).map((row) =>
      toExchangeRate(row, quoteCurrency, rateType, `${row.TIME.slice(0, 4)}-${row.TIME.slice(4, 6)}-${row.TIME.slice(6, 8)}`),
    );
  }

  private async invoke(url: string): Promise<EcosSuccessEnvelope> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new BedrockUnavailableError(`ECOS HTTP ${response.status} for ${url}`);
      }
      const payload = (await response.json()) as EcosSuccessEnvelope & EcosErrorEnvelope;
      if (payload.RESULT && payload.RESULT.CODE && payload.RESULT.CODE !== 'INFO-000') {
        if (payload.RESULT.CODE === 'INFO-200') return { StatisticSearch: { list_total_count: 0, row: [] } };
        throw new BedrockUnavailableError(`ECOS error ${payload.RESULT.CODE}: ${payload.RESULT.MESSAGE}`);
      }
      return payload;
    } finally {
      clearTimeout(timer);
    }
  }
}
